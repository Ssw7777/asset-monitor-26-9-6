import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readKonaPositions,konaAbi,konaPriceScale,applyKonaObservation} from '../src/lib/onchain/kona-rpc.ts';
import {multicallAbi} from '../src/lib/onchain/rpc-balances.ts';
import {applyProtocolObservation,preserveRpcProtocols} from '../src/lib/onchain/protocol-observation.ts';
const now=1800000000000,address='0x1111111111111111111111111111111111111111',contract='0x2222222222222222222222222222222222222222';
function mock(change={}){
 return async(url,options)=>{
  const requests=JSON.parse(options.body),rpc=requests.find(r=>r.method==='eth_call');
  const calls=multicallAbi.decodeFunctionData('aggregate3',rpc.params[0].data)[0];
  const rows=calls.map(c=>{
   const iface=multicallAbi.getFunction(c.callData.slice(0,10))?multicallAbi:konaAbi;
   const parsed=iface.parseTransaction({data:c.callData}),name=parsed.name;
   const values={getBlockNumber:[100n],getCurrentBlockTimestamp:[BigInt((now-(change.old?600000:12000))/1000)],getAllReservesTokens:[[{symbol:'USDT',tokenAddress:contract}]],ADDRESSES_PROVIDER:[contract],getPriceOracle:[contract],decimals:[6],BASE_CURRENCY_UNIT:[8],BASE_CURRENCY:['0x0000000000000000000000000000000000000000'],getAssetPrice:[100000000],getUserReserveData:[change.zero?0:1800123456,0,change.zero?0:50000000,0,0,0,0,0,true]};
   return {success:true,returnData:iface.encodeFunctionResult(name,values[name])};
  });
  return Response.json(requests.map(r=>({id:r.id,result:r.method==='eth_chainId'?(change.wrongChain?'0x1':'0xab5'):multicallAbi.encodeFunctionResult('aggregate3',[rows])})));
 };
}
test('deployed Kona oracle decimal unit cannot cause a 12.5-million-fold valuation error',()=>{
 assert.equal(konaPriceScale(8),1e8);assert.equal(konaPriceScale(1e8),1e8);assert.throws(()=>konaPriceScale(1));
});
test('Kona reads all reserves and subtracts actual current borrow balances at one anchored block',async()=>{
 const r=await readKonaPositions([address],{apiKey:'test',request:mock(),now:()=>now});
 const position=r.wallets[address].portfolio_item_list[0];
 assert.equal(position.stats.asset_usd_value,1800.123456);assert.equal(position.stats.debt_usd_value,50);
 assert.equal(position.stats.net_usd_value,1750.123456);assert.equal(position.detail.supply_token_list[0].amount_exact,'1800.123456');assert.equal(r.block,'100');
});
test('Kona complete zero clears only Kona, without pretending whole-wallet protocol freshness',async()=>{
 const r=await readKonaPositions([address],{apiKey:'test',request:mock({zero:true}),now:()=>now});
 const previous={at:new Date(now-3600000).toISOString(),protocols:[{id:'abs_kona'},{id:'abs_other'}]};
 const next=applyKonaObservation(previous,r.wallets[address],r.at,r.block);
 assert.deepEqual(next.protocols,[{id:'abs_other'}]);assert.equal(next.at,previous.at);assert.equal(next.protocolRpcOwnership.abs_kona.block,'100');
 const upstream=applyProtocolObservation(next,[{id:'abs_kona',portfolio_item_list:[{}]}],new Date(now+1000).toISOString(),now+1000);
 assert.deepEqual(upstream.protocols,[]);
 assert.equal(applyKonaObservation(next,{id:'abs_kona'},r.at,'99'),next);
});
test('wrong chain, stale block, and rate limit never become empty Kona positions',async()=>{
 for(const change of [{wrongChain:true},{old:true}])await assert.rejects(readKonaPositions([address],{apiKey:'test',request:mock(change),now:()=>now}));
 let calls=0;await assert.rejects(readKonaPositions([address],{apiKey:'test',request:async()=>{calls++;return new Response('',{status:429})}}),/http_429/);assert.equal(calls,1);
});
test('concurrent older bulk cache writes cannot resurrect an RPC-confirmed withdrawal',()=>{
 const current=applyKonaObservation({at:new Date(now-3600000).toISOString(),protocols:[{id:'abs_kona'}]},null,new Date(now).toISOString(),'101');
 const incoming={at:new Date(now+1000).toISOString(),protocols:[{id:'abs_kona'},{id:'other'}]};
 const merged=preserveRpcProtocols(current,incoming,now+1000);
 assert.deepEqual(merged.protocols,[{id:'other'}]);assert.equal(merged.at,incoming.at);assert.equal(merged.protocolRpcOwnership.abs_kona.block,'101');
 const newer=applyKonaObservation(current,{id:'abs_kona',portfolio_item_list:[]},new Date(now+2000).toISOString(),'102');
 assert.equal(preserveRpcProtocols(current,newer,now+2000).protocolRpcOwnership.abs_kona.block,'102');
});
