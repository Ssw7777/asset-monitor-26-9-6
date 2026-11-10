import {Interface,AbiCoder,keccak256,formatUnits} from 'ethers';
import {multicallAbi,MULTICALL,RPC_NETWORKS} from './rpc-balances.ts';
import type {WalletProtocolCacheEntry} from '../types';

// Addresses and read ABI published by https://www.fables.fi (Robinhood).
export const FABLES_LENS='0xE44c0BAb43BdD47e7Ab40236bC183dCc77A9ED6c';
export const FABLES_REGISTRY='0x159a113e012593d9b3cc63ad45e30f0467e13ef3';
export const fablesAbi=new Interface([
 'function activePools() view returns (((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bytes32 id,bool active)[])',
 'function userRanges(address hook,address owner,uint256[] ids) view returns ((uint256 rangeId,bool keyVerified,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,int24 tickLower,int24 tickUpper,uint256 shares,uint128 staked,uint128 claimable0,uint128 claimable1,uint128 totalShares,uint128 totalStaked,uint16 effectiveClaimFeeBps,bool claimPaused,bool settling,uint160 sqrtPriceX96,int24 tick,bool inRange,int24 ticksToLower,int24 ticksToUpper,uint128 poolLiquidity,uint256 shareOfActiveLiquidityE18,uint256 amount0,uint256 amount1)[] rows,(uint256 arbBlockNumber,uint256 l1BlockNumber,uint64 timestamp,bool arbSysAnswered) stamp)',
 'function tokenStates(address[] tokens) view returns ((address token,bool isNative,uint8 decimals,bool decimalsAnswered,uint256 totalSupply,uint256 uiMultiplier,bool hasUiMultiplier,string symbol)[] states,(uint256 arbBlockNumber,uint256 l1BlockNumber,uint64 timestamp,bool arbSysAnswered) stamp)',
]);
const coder=AbiCoder.defaultAbiCoder(),keyType='tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const ZERO=BigInt(0),UI_UNIT=BigInt(10)**BigInt(18);
type Call={target:string;name:string;args?:unknown[]};
export interface FablesObservation {at:string;block:string;wallets:Record<string,Record<string,unknown>|null>;estimatedCu:number;indexedBlock:string}

export async function readFablesPositions(addresses:string[],options:{apiKey?:string;request?:typeof fetch;now?:()=>number;timeoutMs?:number}={}):Promise<FablesObservation>{
 if(!addresses.length||addresses.length>5||new Set(addresses).size!==addresses.length||addresses.some(a=>!/^0x[a-f0-9]{40}$/.test(a)))throw new Error('invalid_fables_addresses');
 if(!options.apiKey)throw new Error('rpc_key_missing');
 const request=options.request??fetch,now=options.now??Date.now,start=now();let estimatedCu=0,seq=0;
 const remaining=()=>{const ms=(options.timeoutMs??24000)-(now()-start);if(ms<500)throw new Error('fables_deadline');return Math.min(8000,ms);};
 const rpcUrl=`https://${RPC_NETWORKS.hood.net}.g.alchemy.com/v2/${options.apiKey}`;
 async function indexer(op:string,params:Record<string,string>={}){
  const isRanges=op==='ranges';
  const r=await request('https://www.fables.fi/api/indexer'+(isRanges?'':'?'+new URLSearchParams({op,...params})),{
   method:isRanges?'POST':'GET',...(isRanges?{headers:{'Content-Type':'application/json'},body:JSON.stringify({op,...params})}:{}),
   cache:'no-store',redirect:'error',signal:AbortSignal.timeout(remaining()),
  });
  if(!r.ok)throw new Error(`fables_http_${r.status}`);
  const body=await r.json();if(!body?.data||body.errors?.length)throw new Error('invalid_fables_indexer');return body.data;
 }
 let anchoredRpcBlock:{number:string;timestamp:string}|undefined;
 async function batch(calls:Call[],block:string,anchor=false){
  if(!calls.length)return [];
  if(calls.length>50)throw new Error('fables_batch_limit');
  const items=calls.map(c=>({target:c.target,allowFailure:false,callData:(c.name.startsWith('getBlock')||c.name==='getCurrentBlockTimestamp'?multicallAbi:fablesAbi).encodeFunctionData(c.name,c.args??[])}));
  const chainId=++seq,callId=++seq,blockId=++seq;estimatedCu+=anchor?46:26;
  const r=await request(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(remaining()),body:JSON.stringify([
   {jsonrpc:'2.0',id:chainId,method:'eth_chainId',params:[]},{jsonrpc:'2.0',id:callId,method:'eth_call',params:[{to:MULTICALL,data:multicallAbi.encodeFunctionData('aggregate3',[items])},block]},
   ...(anchor?[{jsonrpc:'2.0',id:blockId,method:'eth_getBlockByNumber',params:[block,false]}]:[]),
  ])});
  if(!r.ok)throw new Error(`http_${r.status}`);
  const body=await r.json();if(!Array.isArray(body)||body.length!==(anchor?3:2))throw new Error('invalid_fables_rpc');
  const identity=body.filter(v=>v.id===chainId),value=body.filter(v=>v.id===callId);
  if(identity.length!==1||value.length!==1||identity[0].error||value[0].error||BigInt(identity[0].result)!==BigInt(4663))throw new Error('invalid_fables_chain');
  if(anchor){const blocks=body.filter(v=>v.id===blockId);if(blocks.length!==1||blocks[0].error||!/^0x[0-9a-f]+$/i.test(blocks[0].result?.number)||!/^0x[0-9a-f]+$/i.test(blocks[0].result?.timestamp))throw new Error('invalid_fables_rpc_block');anchoredRpcBlock=blocks[0].result;}
  const rows=multicallAbi.decodeFunctionResult('aggregate3',value[0].result)[0];if(rows.length!==calls.length)throw new Error('invalid_fables_multicall');
  return calls.map((c,i)=>{if(!rows[i].success)throw new Error('fables_read_reverted');return [...(c.name.startsWith('getBlock')||c.name==='getCurrentBlockTimestamp'?multicallAbi:fablesAbi).decodeFunctionResult(c.name,rows[i].returnData)];});
 }
 const head=await indexer('head'),indexed=BigInt(String(head.chain_metadata?.[0]?.latest_processed_block??0));
 if(indexed<=ZERO)throw new Error('invalid_fables_indexer_head');
 // Anchor to the indexer's last complete block. A recent RPC block alone must
 // not certify a delayed discovery index as complete.
 const anchor=await batch([{target:FABLES_REGISTRY,name:'activePools'}],'0x'+indexed.toString(16),true);
 // On Arbitrum Orbit, Solidity block.number is the parent/L1 number; use
 // eth_getBlockByNumber and the Lens's arbBlockNumber, not Multicall block.number.
 const block=BigInt(anchoredRpcBlock!.number),blockMs=Number(BigInt(anchoredRpcBlock!.timestamp))*1000;
 if(block!==indexed||!Number.isSafeInteger(blockMs)||now()-blockMs>5*60_000||blockMs>now()+60000)throw new Error('stale_fables_indexer');
 const pools=new Map<string,{currency0:string;currency1:string;hooks:string}>();
 for(const row of anchor[0][0] as Array<{id:string;key:{currency0:string;currency1:string;hooks:string}}>){
  const id=row.id.toLowerCase();if(pools.has(id)||!/^0x[a-f0-9]{64}$/.test(id))throw new Error('invalid_fables_registry');pools.set(id,row.key);
 }
 if(!pools.size||pools.size>200)throw new Error('invalid_fables_registry');
 const marksData=await indexer('marks');if(!Array.isArray(marksData.Pool))throw new Error('invalid_fables_prices');
 const marks=new Map<string,{usd0:string;usd1:string}>(marksData.Pool.map((p:{id:string;usd0:string;usd1:string})=>[p.id.toLowerCase(),p]));
 const ranges=new Map<string,Array<{pool_id:string;range_id:string}>>();
 for(const address of addresses){
  const rows:Array<{pool_id:string;range_id:string}>=[];
  for(let off=0;;off+=1000){
   if(off>=20000)throw new Error('fables_ranges_truncated');
   const data=await indexer('ranges',{address,off:String(off)});
   if(!Array.isArray(data.Position)||data.Position.length>1000||data.Position.some((p:Record<string,unknown>)=>typeof p.pool_id!=='string'||typeof p.range_id!=='string'||!/^0x[a-f0-9]{64}$/i.test(p.pool_id as string)||!/^0x[a-f0-9]{64}$/i.test(p.range_id as string)))throw new Error('invalid_fables_ranges');
   rows.push(...data.Position);if(data.Position.length<1000)break;
  }
  ranges.set(address,rows);
 }
 const requests:Array<Call&{owner:string;ids:bigint[]}>=[],tokens=new Set<string>();
 for(const [owner,rows] of ranges){
  const hooks=new Map<string,Set<bigint>>();
  for(const range of rows){
   const pool=pools.get(range.pool_id.toLowerCase());
   // An unknown/retired pool is not evidence that the owner's money is zero.
   if(!pool)throw new Error('fables_unresolved_pool');
   const hook=pool.hooks.toLowerCase(),ids=hooks.get(hook)??new Set<bigint>();ids.add(BigInt(range.range_id));hooks.set(hook,ids);
   tokens.add(pool.currency0.toLowerCase());tokens.add(pool.currency1.toLowerCase());
  }
  for(const [hook,ids] of hooks){const list=[...ids];for(let i=0;i<list.length;i+=200)requests.push({target:FABLES_LENS,name:'userRanges',args:[hook,owner,list.slice(i,i+200)],owner,ids:list.slice(i,i+200)});}
 }
 const at=new Date(now()).toISOString(),wallets:FablesObservation['wallets']=Object.fromEntries(addresses.map(a=>[a,null]));
 if(!requests.length)return {at,block:block.toString(),indexedBlock:indexed.toString(),wallets,estimatedCu};
 const tokenList=[...tokens];
 const values=await batch([...requests,{target:FABLES_LENS,name:'tokenStates',args:[tokenList]}],'0x'+block.toString(16));
 function validStamp(stamp:{arbBlockNumber:bigint;timestamp:bigint;arbSysAnswered:boolean}){
  if(!stamp.arbSysAnswered||stamp.arbBlockNumber!==block||Number(stamp.timestamp)*1000!==blockMs)throw new Error('invalid_fables_lens_stamp');
 }
 const [states,tokenStamp]=values[requests.length];validStamp(tokenStamp as Parameters<typeof validStamp>[0]);
 const metadata=new Map<string,{decimals:number;symbol:string;multiplier:bigint}>();
 for(const state of states as Array<{token:string;decimals:bigint;decimalsAnswered:boolean;symbol:string;hasUiMultiplier:boolean;uiMultiplier:bigint}>){
  const decimals=Number(state.decimals),token=state.token.toLowerCase();
  if(metadata.has(token)||!tokenList.includes(token)||!state.decimalsAnswered||!Number.isInteger(decimals)||decimals<0||decimals>36||!state.symbol||state.hasUiMultiplier&&state.uiMultiplier<=ZERO)throw new Error('invalid_fables_token_metadata');
  metadata.set(token,{decimals,symbol:state.symbol,multiplier:state.hasUiMultiplier?state.uiMultiplier:UI_UNIT});
 }
 if(metadata.size!==tokenList.length)throw new Error('incomplete_fables_token_metadata');
 const portfolios=new Map<string,Record<string,unknown>[]>();
 for(let i=0;i<requests.length;i++){
  const [rows,stamp]=values[i];validStamp(stamp as Parameters<typeof validStamp>[0]);
  if((rows as unknown[]).length!==requests[i].ids.length)throw new Error('incomplete_fables_ranges');
  for(let j=0;j<(rows as unknown[]).length;j++){
   const row=(rows as Array<Record<string,unknown>>)[j] as any;
   if(row.rangeId!==requests[i].ids[j]||!row.keyVerified)throw new Error('unverified_fables_range');
   if(row.shares===ZERO&&row.claimable0===ZERO&&row.claimable1===ZERO)continue;
   if(row.shares>ZERO&&row.totalShares===ZERO||row.sqrtPriceX96===ZERO)throw new Error('invalid_fables_shares');
   const id=keccak256(coder.encode([keyType],[row.key])).toLowerCase(),pool=pools.get(id),mark=marks.get(id);
   if(!pool||!mark)throw new Error('fables_unpriced_pool');
   const supply:Record<string,unknown>[]=[],rewards:Record<string,unknown>[]=[];let asset=0;
   for(const n of [0,1] as const){
    const token=String(row.key[n]).toLowerCase(),meta=metadata.get(token);if(!meta)throw new Error('fables_missing_token');
    const unitPrice=Number(n===0?mark.usd0:mark.usd1),price=unitPrice*10**meta.decimals;
    if(!Number.isFinite(price)||price<=0)throw new Error('invalid_fables_price');
    // Lens reports raw principal and claimable fees separately, exactly once.
    // Match the official frontend's scaled/rebasing-token display units.
    for(const [raw,list] of [[row[n===0?'amount0':'amount1'],supply],[row[n===0?'claimable0':'claimable1'],rewards]] as const){
     const exact=formatUnits(BigInt(raw)*meta.multiplier,meta.decimals+18),amount=Number(exact);
     if(!Number.isFinite(amount)||amount<0)throw new Error('invalid_fables_quantity');
     if(amount>0){const value=amount*price;if(!Number.isFinite(value))throw new Error('invalid_fables_value');asset+=value;list.push({id:token,chain:'hood',symbol:meta.symbol,optimized_symbol:meta.symbol,amount,amount_exact:exact,price,usd_value:value});}
    }
   }
   const list=portfolios.get(requests[i].owner)??[];
   list.push({name:'Liquidity Pool',position_index:row.rangeId.toString(),stats:{asset_usd_value:asset,debt_usd_value:0,net_usd_value:asset},detail:{supply_token_list:supply,reward_token_list:rewards,borrow_token_list:[]}});portfolios.set(requests[i].owner,list);
  }
 }
 for(const [owner,portfolio_item_list] of portfolios)wallets[owner]={id:'hood_fables',name:'Fables',chain:'hood',site_url:'https://www.fables.fi',portfolio_item_list};
 return {at:new Date(now()).toISOString(),block:block.toString(),indexedBlock:indexed.toString(),wallets,estimatedCu};
}

export function applyFablesObservation(previous:WalletProtocolCacheEntry|undefined,protocol:Record<string,unknown>|null,at:string,block:string):WalletProtocolCacheEntry{
 const base=previous??{at:'',protocols:[]},owned=base.protocolRpcOwnership?.hood_fables;
 if(owned&&BigInt(block)<=BigInt(owned.block))return base;
 const old=base.protocols.find(p=>p.id==='hood_fables');
 return {...base,protocols:[...base.protocols.filter(p=>p.id!=='hood_fables'),...(protocol?[{...old,...protocol}]:[])],protocolUpdatedAt:{...base.protocolUpdatedAt,hood_fables:at},protocolRpcOwnership:{...base.protocolRpcOwnership,hood_fables:{at,block}}};
}
