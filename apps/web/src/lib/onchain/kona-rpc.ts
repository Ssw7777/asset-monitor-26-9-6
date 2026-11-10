import {Interface,formatUnits} from 'ethers';
import {multicallAbi,RPC_NETWORKS} from './rpc-balances.ts';
import type {WalletProtocolCacheEntry} from '../types';

// Kona's deployed Aave-compatible data provider, checked against the live
// application's lending deployment and its on-chain ADDRESSES_PROVIDER.
export const KONA_PROVIDER='0xDfc422c8793864ecD12Bc59F2024614034BcB078';
export const konaAbi=new Interface([
 'function getAllReservesTokens() view returns ((string symbol,address tokenAddress)[])',
 'function ADDRESSES_PROVIDER() view returns(address)',
 'function getPriceOracle() view returns(address)',
 'function BASE_CURRENCY_UNIT() view returns(uint256)',
 'function BASE_CURRENCY() view returns(address)',
 'function getAssetPrice(address) view returns(uint256)',
 'function decimals() view returns(uint8)',
 'function getUserReserveData(address,address) view returns(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint40,bool)',
]);
type Call={target:string;name:string;args?:unknown[]};
export interface KonaObservation {at:string;block:string;wallets:Record<string,Record<string,unknown>|null>;estimatedCu:number}

export function konaPriceScale(raw:unknown){
 const value=Number(raw);
 // This deployed oracle reports 8 (decimal places), not Aave's usual 10^8.
 if(value===8)return 100_000_000;
 if(value===100_000_000)return value;
 throw new Error('unsupported_kona_price_unit');
}

/** Full reserve enumeration, including loans and explicit zero after withdrawal. */
export async function readKonaPositions(addresses:string[],options:{apiKey?:string;request?:typeof fetch;now?:()=>number;timeoutMs?:number}={}):Promise<KonaObservation>{
 if(!addresses.length||addresses.length>50||new Set(addresses).size!==addresses.length||addresses.some(a=>!/^0x[a-f0-9]{40}$/.test(a)))throw new Error('invalid_kona_addresses');
 if(!options.apiKey)throw new Error('rpc_key_missing');
 const now=options.now??Date.now,request=options.request??fetch,start=now();
 const network=RPC_NETWORKS.abs,multicall=network.multicall!,url=`https://${network.net}.g.alchemy.com/v2/${options.apiKey}`;
 let seq=0,estimatedCu=0;
 async function batch(calls:Call[],block='latest'){
  const result:unknown[][]=[];
  for(let offset=0;offset<calls.length;offset+=50){
   const remaining=(options.timeoutMs??18000)-(now()-start);if(remaining<1000)throw new Error('kona_deadline');
   const selected=calls.slice(offset,offset+50),items=selected.map(c=>({target:c.target,allowFailure:false,callData:(c.name.startsWith('getBlock')||c.name==='getCurrentBlockTimestamp'?multicallAbi:konaAbi).encodeFunctionData(c.name,c.args??[])}));
   const chainId=++seq,callId=++seq;estimatedCu+=26;
   const r=await request(url,{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(Math.min(8000,remaining)),body:JSON.stringify([
    {jsonrpc:'2.0',id:chainId,method:'eth_chainId',params:[]},
    {jsonrpc:'2.0',id:callId,method:'eth_call',params:[{to:multicall,data:multicallAbi.encodeFunctionData('aggregate3',[items])},block]},
   ])});
   if(!r.ok)throw new Error(`http_${r.status}`);
   const body=await r.json();if(!Array.isArray(body)||body.length!==2)throw new Error('invalid_kona_rpc');
   const identities=body.filter(v=>v.id===chainId),values=body.filter(v=>v.id===callId);
   if(identities.length!==1||values.length!==1||identities[0].error||values[0].error||BigInt(identities[0].result)!==BigInt(2741))throw new Error('invalid_kona_chain');
   const rows=multicallAbi.decodeFunctionResult('aggregate3',values[0].result)[0];
   if(rows.length!==selected.length)throw new Error('invalid_kona_multicall');
   selected.forEach((c,i)=>{if(!rows[i].success)throw new Error('kona_read_reverted');result.push([...(c.name.startsWith('getBlock')||c.name==='getCurrentBlockTimestamp'?multicallAbi:konaAbi).decodeFunctionResult(c.name,rows[i].returnData)]);});
  }
  return result;
 }
 const first=await batch([{target:multicall,name:'getBlockNumber'},{target:multicall,name:'getCurrentBlockTimestamp'},{target:KONA_PROVIDER,name:'getAllReservesTokens'},{target:KONA_PROVIDER,name:'ADDRESSES_PROVIDER'}]);
 const block=BigInt(String(first[0][0])),blockMs=Number(first[1][0])*1000;
 if(block<=BigInt(0)||!Number.isSafeInteger(blockMs)||now()-blockMs>300000||blockMs>now()+60000)throw new Error('stale_kona_block');
 const blockHex='0x'+block.toString(16),reserves=first[2][0] as Array<{symbol:string;tokenAddress:string}>;
 if(!reserves.length||reserves.length>8||new Set(reserves.map(r=>r.tokenAddress.toLowerCase())).size!==reserves.length||reserves.some(r=>!r.symbol||!/^0x[a-f0-9]{40}$/i.test(r.tokenAddress)))throw new Error('invalid_kona_reserves');
 const addressProvider=String(first[3][0]);
 const metadata=await batch([{target:addressProvider,name:'getPriceOracle'},...reserves.map(r=>({target:r.tokenAddress,name:'decimals'}))],blockHex);
 const oracle=String(metadata[0][0]),decimals=metadata.slice(1).map(r=>Number(r[0]));
 if(decimals.some(d=>!Number.isInteger(d)||d<0||d>36))throw new Error('invalid_kona_decimals');
 const data=await batch([{target:oracle,name:'BASE_CURRENCY_UNIT'},{target:oracle,name:'BASE_CURRENCY'},...reserves.map(r=>({target:oracle,name:'getAssetPrice',args:[r.tokenAddress]})),...addresses.flatMap(address=>reserves.map(r=>({target:KONA_PROVIDER,name:'getUserReserveData',args:[r.tokenAddress,address]})))],blockHex);
 if(String(data[1][0]).toLowerCase()!=='0x0000000000000000000000000000000000000000')throw new Error('unsupported_kona_base_currency');
 const unit=konaPriceScale(data[0][0]);
 const prices=data.slice(2,2+reserves.length).map(r=>Number(r[0])/unit);
 if(prices.some(p=>!Number.isFinite(p)||p<=0))throw new Error('invalid_kona_oracle_price');
 const at=new Date(now()).toISOString(),wallets:KonaObservation['wallets']={};
 addresses.forEach((address,wi)=>{
  let asset=0,debt=0;const supply:Record<string,unknown>[]=[],borrow:Record<string,unknown>[]=[];
  reserves.forEach((reserve,ri)=>{
   const row=data[2+reserves.length+wi*reserves.length+ri];
   const amountExact=formatUnits(BigInt(String(row[0])),decimals[ri]),debtExact=formatUnits(BigInt(String(row[1]))+BigInt(String(row[2])),decimals[ri]);
   const amount=Number(amountExact),owed=Number(debtExact),price=prices[ri];
   if(!Number.isFinite(amount)||!Number.isFinite(owed)||amount<0||owed<0)throw new Error('invalid_kona_quantity');
   const token={id:reserve.tokenAddress.toLowerCase(),chain:'abs',symbol:reserve.symbol,optimized_symbol:reserve.symbol,price};
   if(amount>0){asset+=amount*price;supply.push({...token,amount,amount_exact:amountExact,usd_value:amount*price});}
   if(owed>0){debt+=owed*price;borrow.push({...token,amount:owed,amount_exact:debtExact,usd_value:owed*price});}
  });
  wallets[address]=asset>0||debt>0?{id:'abs_kona',name:'Kona',chain:'abs',site_url:'https://app.kona.surf',portfolio_item_list:[{stats:{asset_usd_value:asset,debt_usd_value:debt,net_usd_value:asset-debt},detail:{supply_token_list:supply,borrow_token_list:borrow,reward_token_list:[]}}]}:null;
 });
 return {at,block:block.toString(),wallets,estimatedCu};
}

export function applyKonaObservation(previous:WalletProtocolCacheEntry|undefined,protocol:Record<string,unknown>|null,at:string,block:string):WalletProtocolCacheEntry{
 const base=previous??{at:'',protocols:[]},owned=base.protocolRpcOwnership?.abs_kona;
 if(owned&&BigInt(block)<=BigInt(owned.block))return base;
 const old=base.protocols.find(p=>p.id==='abs_kona');
 return {...base,protocols:[...base.protocols.filter(p=>p.id!=='abs_kona'),...(protocol?[{...old,...protocol}]:[])],
  protocolUpdatedAt:{...base.protocolUpdatedAt,abs_kona:at},protocolRpcOwnership:{...base.protocolRpcOwnership,abs_kona:{at,block}}};
}
