import { Interface, formatUnits } from 'ethers';

export const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
export const multicallAbi = new Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
  'function getEthBalance(address) view returns (uint256)',
  'function getBlockNumber() view returns (uint256)',
  'function getCurrentBlockTimestamp() view returns (uint256)',
]);
export const erc20Abi = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);
export interface RpcNetwork { id: number; net?: string; url?: string; multicall?: string; plain?:boolean; }
// Provider network names are from its supported-chains reference. Chain IDs and
// multicall bytecode were checked read-only with this project's existing key.
export const RPC_NETWORKS: Record<string, RpcNetwork> = {
  eth:{id:1,net:'eth-mainnet'},arb:{id:42161,net:'arb-mainnet'},base:{id:8453,net:'base-mainnet'},
  op:{id:10,net:'opt-mainnet'},bsc:{id:56,net:'bnb-mainnet'},matic:{id:137,net:'polygon-mainnet'},
  linea:{id:59144,net:'linea-mainnet'},hood:{id:4663,net:'robinhood-mainnet'},
  abs:{id:2741,net:'abstract-mainnet',multicall:'0xf9cda624fbc7e059355ce98a31693d299facd963'},
  xlayer:{id:196,net:'xlayer-mainnet'},avax:{id:43114,net:'avax-mainnet'},ink:{id:57073,net:'ink-mainnet'},
  rsk:{id:30,net:'rootstock-mainnet'},ape:{id:33139,net:'apechain-mainnet'},scrl:{id:534352,net:'scroll-mainnet'},
  megaeth:{id:4326,net:'megaeth-mainnet'},monad:{id:143,net:'monad-mainnet'},opbnb:{id:204,net:'opbnb-mainnet'},
  arc:{id:5042,net:'arc-mainnet'},plasma:{id:9745,net:'plasma-mainnet'},katana:{id:747474,net:'katana-mainnet'},
  zora:{id:7777777,net:'zora-mainnet'},bera:{id:80094,net:'berachain-mainnet'},sei:{id:1329,net:'sei-mainnet'},
  klay:{id:8217,net:'kaia-mainnet'},
  gravity:{id:1625,url:'https://rpc.gravity.xyz'},
  'gravity-alpha':{id:1625,url:'https://rpc.gravity.xyz'},
  merlin:{id:4200,url:'https://rpc.merlinchain.io',plain:true},core:{id:1116,url:'https://rpc.coredao.org'},
};
export interface RpcTarget { address: string; uuid: string; decimals?: number; }
export interface RpcQuantity extends RpcTarget {
  observedAt: string; blockNumber?: string; blockTimestamp?: string;
  raw?: string; amountExact?: string; decimals?: number; error?: string;
}
export interface RpcChainResult {
  chain: string; observedAt: string; quantities: RpcQuantity[]; error?: string; estimatedCu: number;
}

export function validateTarget(target: RpcTarget, chain: string) {
  const [idChain,id,...extra] = target.uuid.split(':');
  return /^0x[a-f0-9]{40}$/i.test(target.address) && idChain === chain && !extra.length &&
    (id === chain || /^0x[a-f0-9]{40}$/.test(id));
}
export function planCalls(targets: RpcTarget[], chain: string, multicall: string) {
  const calls: Array<{target:string;allowFailure:boolean;callData:string}> = [
    {target:multicall,allowFailure:false,callData:multicallAbi.encodeFunctionData('getBlockNumber')},
    {target:multicall,allowFailure:false,callData:multicallAbi.encodeFunctionData('getCurrentBlockTimestamp')},
  ];
  const indexes = targets.map(target => {
    if (!validateTarget(target,chain)) throw new Error('invalid_target');
    const id = target.uuid.split(':')[1];
    const native = id === chain;
    const balanceIndex = calls.length;
    calls.push({target:native?multicall:id,allowFailure:true,callData:native
      ?multicallAbi.encodeFunctionData('getEthBalance',[target.address])
      :erc20Abi.encodeFunctionData('balanceOf',[target.address])});
    let decimals = native ? 18 : target.decimals;
    if (!Number.isInteger(decimals) || Number(decimals)<0 || Number(decimals)>36) decimals=undefined;
    const decimalsIndex = decimals === undefined ? calls.length : undefined;
    if (decimalsIndex !== undefined) calls.push({target:id,allowFailure:true,callData:erc20Abi.encodeFunctionData('decimals')});
    return {balanceIndex,decimalsIndex,decimals,native};
  });
  return {calls,indexes};
}

export async function readRpcChain(chain: string, targets: RpcTarget[], options: {
  apiKey?: string; request?: typeof fetch; now?: ()=>number; timeoutMs?:number;
} = {}): Promise<RpcChainResult> {
  const now=options.now??Date.now, request=options.request??fetch;
  const observedAt=new Date(now()).toISOString();
  const network=RPC_NETWORKS[chain];
  const result:RpcChainResult={chain,observedAt,quantities:[],estimatedCu:0};
  const fail=(error:string) => ({...result,error,quantities:targets.map(t=>({...t,observedAt,error}))});
  if (!network) return fail('unsupported_chain');
  if (network.net && !options.apiKey) return fail('rpc_key_missing');
  if (targets.length>1000 || targets.some(t=>!validateTarget(t,chain))) return fail('invalid_targets');
  const url=network.url??`https://${network.net}.g.alchemy.com/v2/${options.apiKey}`;
  const contract=network.multicall??MULTICALL;
  if(network.plain)return readPlainRpcChain(chain,targets,{request,now,url,timeoutMs:options.timeoutMs});
  for (let offset=0;offset<targets.length;offset+=60) {
    const batch=targets.slice(offset,offset+60);
    const {calls,indexes}=planCalls(batch,chain,contract);
    try {
      result.estimatedCu+=network.net?26:0;
      const response=await request(url,{
        method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',redirect:'error',
        signal:AbortSignal.timeout(options.timeoutMs??12000),
        body:JSON.stringify([
          {jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]},
          {jsonrpc:'2.0',id:2,method:'eth_call',params:[{to:contract,data:multicallAbi.encodeFunctionData('aggregate3',[calls])},'latest']},
        ]),
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const body=await response.json();
      if (!Array.isArray(body)) throw new Error('invalid_rpc_payload');
      const identity=body.filter(r=>r.id===1), data=body.filter(r=>r.id===2);
      if(identity.length!==1 || data.length!==1 || identity[0].error || data[0].error) throw new Error('rpc_error');
      if(BigInt(identity[0].result)!==BigInt(network.id)) throw new Error('wrong_chain');
      const rows=multicallAbi.decodeFunctionResult('aggregate3',data[0].result)[0];
      if(rows.length!==calls.length || !rows[0].success || !rows[1].success) throw new Error('invalid_multicall');
      const block=multicallAbi.decodeFunctionResult('getBlockNumber',rows[0].returnData)[0] as bigint;
      const seconds=multicallAbi.decodeFunctionResult('getCurrentBlockTimestamp',rows[1].returnData)[0] as bigint;
      const blockMs=Number(seconds)*1000;
      if(block<=BigInt(0) || !Number.isSafeInteger(blockMs) || blockMs>now()+60_000 || now()-blockMs>5*60_000) throw new Error('stale_block');
      const at=new Date(now()).toISOString();
      batch.forEach((target,i)=>{
        const index=indexes[i];
        const row:RpcQuantity={...target,observedAt:at,blockNumber:block.toString(),blockTimestamp:new Date(blockMs).toISOString()};
        try {
          if(!rows[index.balanceIndex].success) throw new Error('balance_reverted');
          let decimals=index.decimals;
          if(index.decimalsIndex!==undefined) {
            if(!rows[index.decimalsIndex].success) throw new Error('decimals_reverted');
            decimals=Number(erc20Abi.decodeFunctionResult('decimals',rows[index.decimalsIndex].returnData)[0]);
          }
          if(!Number.isInteger(decimals) || decimals!<0 || decimals!>36) throw new Error('invalid_decimals');
          const raw=(index.native?multicallAbi:erc20Abi).decodeFunctionResult(index.native?'getEthBalance':'balanceOf',rows[index.balanceIndex].returnData)[0] as bigint;
          const amountExact=formatUnits(raw,decimals!);
          if(!Number.isFinite(Number(amountExact))) throw new Error('invalid_quantity');
          Object.assign(row,{raw:raw.toString(),decimals,amountExact});
        } catch(error) { row.error=error instanceof Error && /^[a-z_]+$/.test(error.message)?error.message:'invalid_return_data'; }
        result.quantities.push(row);
      });
    } catch(error) {
      const reason=error instanceof Error && /^[a-z0-9_]+$/.test(error.message)?error.message:'network_or_decode_error';
      result.error=reason;
      result.quantities.push(...targets.slice(offset).map(t=>({...t,observedAt:new Date(now()).toISOString(),error:reason})));
      break; // No endpoint rotation or immediate retry on a provider failure.
    }
  }
  return result;
}

/** Networks without Multicall3: anchor every read to one verified recent block. */
async function readPlainRpcChain(chain:string,targets:RpcTarget[],options:{request:typeof fetch;now:()=>number;url:string;timeoutMs?:number}):Promise<RpcChainResult>{
  const observedAt=new Date(options.now()).toISOString();
  const result:RpcChainResult={chain,observedAt,quantities:[],estimatedCu:0};
  let sequence=0;
  const call=(method:string,params:unknown[])=>({jsonrpc:'2.0',id:++sequence,method,params});
  async function batch(calls:Array<ReturnType<typeof call>>){
    const response=await options.request(options.url,{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(options.timeoutMs??12000),body:JSON.stringify(calls)});
    if(!response.ok)throw new Error(`http_${response.status}`);
    const body=await response.json();
    if(!Array.isArray(body)||body.length!==calls.length)throw new Error('invalid_rpc_payload');
    return calls.map(c=>{const matches=body.filter(r=>r.id===c.id);if(matches.length!==1)throw new Error('invalid_rpc_payload');return matches[0];});
  }
  try{
    const [identity,block]=await batch([call('eth_chainId',[]),call('eth_getBlockByNumber',['latest',false])]);
    if(identity.error||block.error)throw new Error('rpc_error');
    if(BigInt(identity.result)!==BigInt(RPC_NETWORKS[chain].id))throw new Error('wrong_chain');
    const number=BigInt(block.result.number),blockMs=Number(BigInt(block.result.timestamp))*1000;
    if(number<=BigInt(0)||!Number.isSafeInteger(blockMs)||blockMs>options.now()+60000||options.now()-blockMs>300000)throw new Error('stale_block');
    for(let offset=0;offset<targets.length;offset+=60){
      const selected=targets.slice(offset,offset+60),calls:Array<ReturnType<typeof call>>=[];
      const indexes=selected.map(target=>{
        const id=target.uuid.split(':')[1],native=id===chain;
        const balance=calls.length;
        calls.push(native?call('eth_getBalance',[target.address,block.result.number]):call('eth_call',[{to:id,data:erc20Abi.encodeFunctionData('balanceOf',[target.address])},block.result.number]));
        const known=native?18:target.decimals;
        const decimals=Number.isInteger(known)&&Number(known)>=0&&Number(known)<=36?known:undefined;
        const scale=decimals===undefined?calls.length:undefined;
        if(scale!==undefined)calls.push(call('eth_call',[{to:id,data:erc20Abi.encodeFunctionData('decimals')},block.result.number]));
        return {balance,scale,decimals,native};
      });
      const replies=await batch(calls);
      selected.forEach((target,i)=>{
        const ix=indexes[i],at=new Date(options.now()).toISOString();
        try{
          if(replies[ix.balance].error||(ix.scale!==undefined&&replies[ix.scale].error))throw new Error('rpc_error');
          const decimals=ix.decimals??Number(erc20Abi.decodeFunctionResult('decimals',replies[ix.scale!].result)[0]);
          if(!Number.isInteger(decimals)||decimals<0||decimals>36)throw new Error('invalid_decimals');
          const raw=ix.native?BigInt(replies[ix.balance].result):erc20Abi.decodeFunctionResult('balanceOf',replies[ix.balance].result)[0] as bigint;
          if(raw<BigInt(0))throw new Error('invalid_quantity');
          const amountExact=formatUnits(raw,decimals);
          if(!Number.isFinite(Number(amountExact)))throw new Error('invalid_quantity');
          result.quantities.push({...target,observedAt:at,blockNumber:number.toString(),blockTimestamp:new Date(blockMs).toISOString(),raw:raw.toString(),decimals,amountExact});
        }catch{result.quantities.push({...target,observedAt:at,error:'invalid_rpc_quantity'});}
      });
    }
  }catch(error){
    result.error=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'network_or_decode_error';
    result.quantities.push(...targets.slice(result.quantities.length).map(t=>({...t,observedAt,error:result.error})));
  }
  return result;
}
