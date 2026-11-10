import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readRpcChain,multicallAbi,erc20Abi,planCalls,MULTICALL} from '../src/lib/onchain/rpc-balances.ts';
const address='0x1111111111111111111111111111111111111111';
const contract='0x2222222222222222222222222222222222222222';
const now=1_800_000_000_000;
const targets=[{address,uuid:'eth:eth'},{address,uuid:`eth:${contract}`}];
function rpcReply(change={}) {
  const rows=[
    {success:true,returnData:multicallAbi.encodeFunctionResult('getBlockNumber',[100n])},
    {success:true,returnData:multicallAbi.encodeFunctionResult('getCurrentBlockTimestamp',[BigInt((now-12000)/1000)])},
    {success:true,returnData:multicallAbi.encodeFunctionResult('getEthBalance',[123456789012345678n])},
    {success:true,returnData:erc20Abi.encodeFunctionResult('balanceOf',[1800123456n])},
    {success:true,returnData:erc20Abi.encodeFunctionResult('decimals',[6])},
  ];
  if(change.failedBalance)rows[3]={success:false,returnData:'0x'};
  if(change.zero)rows[3].returnData=erc20Abi.encodeFunctionResult('balanceOf',[0]);
  if(change.oldBlock)rows[1].returnData=multicallAbi.encodeFunctionResult('getCurrentBlockTimestamp',[BigInt((now-600000)/1000)]);
  if(change.badDecimals)rows[4]={success:false,returnData:'0x'};
  return [{id:1,result:change.wrongChain?'0x38':'0x1'},{id:2,result:multicallAbi.encodeFunctionResult('aggregate3',[rows])}];
}
async function run(change){return readRpcChain('eth',targets,{apiKey:'test',now:()=>now,request:async(url,options)=>{
  assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
  const body=JSON.parse(options.body);assert.deepEqual(body.map(x=>x.method),['eth_chainId','eth_call']);
  return Response.json(rpcReply(change));
}});}
test('multicall reads native and ERC20 quantities at the same recent block without rounding',async()=>{
  const result=await run({});assert.equal(result.estimatedCu,26);
  assert.equal(result.quantities[0].amountExact,'0.123456789012345678');
  assert.equal(result.quantities[1].amountExact,'1800.123456');
  assert.equal(result.quantities[1].blockNumber,'100');
});
test('explicit zero succeeds but reverted balance/decimals never become zero',async()=>{
  assert.equal((await run({zero:true})).quantities[1].amountExact,'0.0');
  for(const change of [{failedBalance:true},{badDecimals:true}]){
    const row=(await run(change)).quantities[1];assert.ok(row.error);assert.equal(row.amountExact,undefined);
  }
});
test('wrong chain and old block reject all quantities',async()=>{
  for(const change of [{wrongChain:true},{oldBlock:true}])assert.ok((await run(change)).quantities.every(q=>q.error));
});
test('known decimal metadata avoids repeated calls; malformed target is rejected',()=>{
  assert.equal(planCalls([{...targets[1],decimals:6}],'eth',MULTICALL).calls.length,3);
  assert.throws(()=>planCalls([{address,uuid:'eth:not-a-contract'}],'eth',MULTICALL));
});
test('429 stops remaining batches without retry or endpoint rotation',async()=>{
  let requests=0;const result=await readRpcChain('eth',Array(70).fill(targets[0]),{apiKey:'test',request:async()=>{requests++;return new Response('',{status:429});}});
  assert.equal(requests,1);assert.equal(result.quantities.length,70);assert.ok(result.quantities.every(q=>q.error==='http_429'));
});

test('Merlin uses block-anchored native reads without an undeployed Multicall3 contract',async()=>{
  let requests=0;
  const result=await readRpcChain('merlin',[{address,uuid:'merlin:merlin'}],{now:()=>now,request:async(_url,options)=>{
    requests++;const calls=JSON.parse(options.body);
    return Response.json(calls.map(c=>({id:c.id,result:c.method==='eth_chainId'?'0x1068':c.method==='eth_getBlockByNumber'?{number:'0x64',timestamp:'0x'+((now-12000)/1000).toString(16)}:(assert.equal(c.method,'eth_getBalance'),assert.equal(c.params[1],'0x64'),'0xde0b6b3a7640000')})));
  }});
  assert.equal(requests,2);assert.equal(result.quantities[0].amountExact,'1.0');assert.equal(result.quantities[0].blockNumber,'100');
});
