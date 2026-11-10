import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCoinStatsPrices,applyMarketPrices} from '../src/lib/onchain/coinstats-prices.ts';
const contract='0x1111111111111111111111111111111111111111';
const old='2026-09-28T00:00:00Z',at='2026-09-28T00:05:00Z';
const token={chain:'eth',tokenId:contract,symbol:'USDT',amount:2,valueUsd:2,kind:'stable',isCore:true,updatedAt:old};
const cache={at:old,source:'rabby-public',tokens:[token],coveredChains:['eth']};
test('public quotes match contract and chain, never a same-symbol counterfeit',()=>{
  const quotes=parseCoinStatsPrices({result:[{id:'tether',symbol:'USDT',price:0.99,contractAddresses:[{blockchain:'ethereum',contractAddress:contract}]}]},at);
  const updated=applyMarketPrices(cache,quotes);
  assert.equal(updated.cache.tokens[0].valueUsd,1.98);
  assert.equal(updated.cache.tokens[0].updatedAt,old);
  assert.equal(updated.cache.tokens[0].priceUpdatedAt,at);
  assert.equal(updated.cache.at,old);
  assert.equal(applyMarketPrices({...cache,tokens:[{...token,chain:'bsc'}]},quotes).updated,0);
  assert.equal(applyMarketPrices({...cache,tokens:[{...token,tokenId:'0x2222222222222222222222222222222222222222'}]},quotes).updated,0);
  assert.equal(token.valueUsd,2);
});
test('native ETH is chain-scoped; stale quotes cannot replace a newer valuation',()=>{
  const quotes=parseCoinStatsPrices({result:[{id:'ethereum',symbol:'ETH',price:2000}]},at);
  const native={...token,chain:'abs',tokenId:'abs',symbol:'ETH',amount:0.5};
  assert.equal(applyMarketPrices({...cache,tokens:[native]},quotes).cache.tokens[0].valueUsd,1000);
  assert.equal(applyMarketPrices({...cache,tokens:[{...native,priceUpdatedAt:'2026-09-28T00:06:00Z'}]},quotes).updated,0);
  assert.equal(quotes['xlayer:xlayer'],undefined);
});
test('invalid, incomplete, or ambiguous upstream results cannot erase valid prices',()=>{
  assert.throws(()=>parseCoinStatsPrices({result:[],meta:{hasNextPage:true}},at),/incomplete/);
  for(const price of [0,-1,NaN,'1',null])assert.throws(()=>parseCoinStatsPrices({result:[{id:'ethereum',symbol:'ETH',price}]},at),/invalid/);
  const row={symbol:'X',price:1,contractAddresses:[{blockchain:'ethereum',contractAddress:contract}]};
  assert.throws(()=>parseCoinStatsPrices({result:[{...row,id:'one'},{...row,id:'two'}]},at),/ambiguous/);
});
