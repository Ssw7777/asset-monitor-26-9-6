import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyRpcQuantities} from '../src/lib/onchain/rpc-cache.ts';
const address='0x1111111111111111111111111111111111111111',uuid='eth:eth';
const cache={at:'2026-09-27T00:00:00Z',source:'rabby-public',tokens:[{chain:'eth',tokenId:'eth',symbol:'ETH',amount:2,valueUsd:4000,kind:'native',isCore:true}],coveredChains:['eth']};
const row={address,uuid,observedAt:'2026-09-27T00:05:00Z',amountExact:'0.0',decimals:18,blockNumber:'100'};
test('zero quantity retains metadata and price basis for later deposits without faking price timestamp',()=>{
  const zero=applyRpcQuantities(cache,[row]);assert.equal(zero.tokens[0].amount,0);
  assert.equal(zero.at,cache.at);assert.equal(zero.tokens[0].priceUpdatedAt,cache.at);
  const restored=applyRpcQuantities(zero,[{...row,observedAt:'2026-09-27T00:10:00Z',amountExact:'3.5'}]);
  assert.equal(restored.tokens[0].valueUsd,7000);assert.equal(restored.tokens[0].priceUpdatedAt,cache.at);
  assert.equal(cache.tokens[0].amount,2);
  const evicted={...zero,tokens:[]};
  assert.equal(applyRpcQuantities(evicted,[{...row,observedAt:'2026-09-27T00:10:00Z',amountExact:'3.5'}]).tokens[0].valueUsd,7000);
});
test('failed or out of order RPC read preserves successful quantities',()=>{
  const next=applyRpcQuantities(cache,[{...row,error:'http_429',amountExact:undefined}]);
  assert.equal(next.tokens[0].amount,2);assert.equal(next.tokens[0].updatedAt,undefined);
  assert.equal(next.tokenErrors[uuid],'http_429');
  const zero=applyRpcQuantities(cache,[row]);
  assert.equal(applyRpcQuantities(zero,[{...row,observedAt:cache.at,amountExact:'8'}]).tokens[0].amount,0);
});

test('verified native Zerion alias joins RPC updates; equivalent rows never double the balance',()=>{
  const legacy={...cache.tokens[0],tokenId:'zerion:eth',assetId:'zerion:eth',kind:'spot'};
  const next=applyRpcQuantities({...cache,tokens:[legacy,cache.tokens[0]]},[{...row,amountExact:'0.125'}]);
  assert.equal(next.tokens.length,1);
  assert.equal(next.tokens[0].amount,0.125);
  assert.equal(next.tokens[0].tokenId,'eth');
  assert.equal(next.tokens[0].assetId,undefined);
  assert.equal(next.tokens[0].kind,'native');
  assert.equal(next.tokens[0].priceUpdatedAt,cache.at);
});
