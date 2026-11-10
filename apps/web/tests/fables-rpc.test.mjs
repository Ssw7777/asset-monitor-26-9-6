import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AbiCoder,keccak256} from 'ethers';
import {readFablesPositions,fablesAbi,applyFablesObservation} from '../src/lib/onchain/fables-rpc.ts';
import {multicallAbi} from '../src/lib/onchain/rpc-balances.ts';
import {preserveRpcProtocols} from '../src/lib/onchain/protocol-observation.ts';
const now=1800000000000,owner='0x1111111111111111111111111111111111111111';
const token0='0x2222222222222222222222222222222222222222',token1='0x3333333333333333333333333333333333333333',hook='0x4444444444444444444444444444444444444444';
const key=[token0,token1,500,10,hook],pool=keccak256(AbiCoder.defaultAbiCoder().encode(['tuple(address,address,uint24,int24,address)'],[key]));
function mock(change={}){
 const seen=[];
 const request=async(url,options)=>{
  seen.push({url,options});
  if(url.includes('/api/indexer')){
   if(change.rateLimited)return new Response('',{status:429});
   const p=options.method==='POST'?JSON.parse(options.body):Object.fromEntries(new URL(url).searchParams),op=p.op;
   const data={head:{chain_metadata:[{latest_processed_block:100}]},marks:{Pool:change.noPrice?[]:[{id:pool,usd0:'0.000001',usd1:'0.000002'}]},ranges:change.invalidRanges?{}:{Position:change.empty?[]:[{range_id:'0x'+(7n).toString(16).padStart(64,'0'),pool_id:change.unknownPool?'0x'+'f'.repeat(64):pool}]}}[op];
   return Response.json({data});
  }
  const payload=JSON.parse(options.body),rpc=payload.find(r=>r.method==='eth_call');
  assert.equal(rpc.params[1],'0x64');
  const calls=multicallAbi.decodeFunctionData('aggregate3',rpc.params[0].data)[0];
  const stamp=[change.wrongStamp?99:100,40,(now-(change.old?600000:12000))/1000,true];
  const rows=calls.map(c=>{
   const parsed=fablesAbi.parseTransaction({data:c.callData}),name=parsed.name;
   const values={activePools:[[[key,pool,true]]],tokenStates:[[[token0,false,6,true,1000000,change.scaled?2000000000000000000n:1000000000000000000n,!!change.scaled,'USD0'],[token1,false,6,true,1000000,1000000000000000000n,false,'USD1']],stamp],
    userRanges:[[[7,!change.unverified,key,-100,100,change.zero?0:100,100,change.zero?0:50000,0,1000,1000,0,false,false,1000000,0,true,100,100,1000000,100000,change.zero?0:1500000,change.zero?0:2000000]],stamp]}[name];
   return {success:true,returnData:fablesAbi.encodeFunctionResult(name,values)};
  });
  return Response.json(payload.map(r=>({id:r.id,result:r.method==='eth_chainId'?(change.wrongChain?'0x1':'0x1237'):r.method==='eth_getBlockByNumber'?{number:'0x64',timestamp:'0x'+BigInt(stamp[2]).toString(16)}:multicallAbi.encodeFunctionResult('aggregate3',[rows])})));
 };
 return {request,seen};
}
test('Fables complete historical ranges are revalued from anchored Lens principal and fees, exactly once',async()=>{
 const m=mock(),r=await readFablesPositions([owner],{apiKey:'test',request:m.request,now:()=>now});
 assert.equal(r.block,'100');assert.equal(r.estimatedCu,72);
 const p=r.wallets[owner].portfolio_item_list[0];assert.equal(p.stats.net_usd_value,5.55);
 assert.equal(p.detail.supply_token_list[0].amount_exact,'1.5');assert.equal(p.detail.reward_token_list[0].amount_exact,'0.05');
 assert.equal(m.seen.filter(v=>v.url.includes('/api/indexer')&&v.options.method==='POST').length,1);
});
test('Fables scaled token quantities match official UI multiplier',async()=>{
 const r=await readFablesPositions([owner],{apiKey:'test',request:mock({scaled:true}).request,now:()=>now});
 assert.equal(r.wallets[owner].portfolio_item_list[0].stats.net_usd_value,7.1);
});
test('Fables empty indexed ledger or on-chain withdrawn historical ranges are explicit zero',async()=>{
 for(const change of [{empty:true},{zero:true}]){
  const r=await readFablesPositions([owner],{apiKey:'test',request:mock(change).request,now:()=>now});assert.equal(r.wallets[owner],null);
  const old={at:new Date(now-3600000).toISOString(),protocols:[{id:'hood_fables'},{id:'other'}]};
  const next=applyFablesObservation(old,null,r.at,r.block);assert.equal(next.at,old.at);assert.deepEqual(next.protocols,[{id:'other'}]);
 }
});
test('Fables partial discovery, stale index, unverified range, absent pricing, or wrong chain never clear a position',async()=>{
 for(const change of [{invalidRanges:true},{unknownPool:true},{old:true},{unverified:true},{noPrice:true},{wrongChain:true},{wrongStamp:true}])await assert.rejects(readFablesPositions([owner],{apiKey:'test',request:mock(change).request,now:()=>now}));
});
test('Fables 429 is not retried and never interpreted as empty assets',async()=>{
 const m=mock({rateLimited:true});await assert.rejects(readFablesPositions([owner],{apiKey:'test',request:m.request,now:()=>now}),/fables_http_429/);assert.equal(m.seen.length,1);
});
test('RPC-owned Fables withdrawal cannot be resurrected by another provider or older block',()=>{
 const current=applyFablesObservation({at:'',protocols:[{id:'hood_fables'}]},null,new Date(now).toISOString(),'100');
 assert.equal(applyFablesObservation(current,{id:'hood_fables'},new Date(now+1000).toISOString(),'99'),current);
 assert.deepEqual(preserveRpcProtocols(current,{at:new Date(now+1000).toISOString(),protocols:[{id:'hood_fables'}]},now+1000).protocols,[]);
});
