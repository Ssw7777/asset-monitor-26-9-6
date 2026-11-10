import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {web3Headers,web3Read} from '../src/lib/onchain/okx-web3.ts';
import {parseWeb3Tokens,applyWeb3Tokens,parseWeb3DefiOverview,applyFablesDetail,parseWeb3History} from '../src/lib/onchain/okx-web3-observation.ts';
const address='0x1111111111111111111111111111111111111111',contract='0x2222222222222222222222222222222222222222';
const at='2026-09-29T00:05:00.000Z',now=Date.parse(at),old='2026-09-29T00:00:00.000Z';
const credentials={key:'test-key',secret:'test-secret',passphrase:'test-passphrase'};
const token={chainIndex:'1',address,symbol:'USDT',tokenContractAddress:contract,balance:'1.123456789012345678',tokenPrice:'0.99',isRiskToken:false};
const envelope=tokenAssets=>({code:'0',data:[{tokenAssets}]});
test('signature includes exact GET query and raw POST body; keys never fall back to CEX',()=>{
  const path='/api/v6/dex/balance/all-token-balances-by-address?address=0xabc&chains=1%2C56';
  assert.equal(web3Headers(credentials,'GET',path,'',at)['OK-ACCESS-SIGN'],createHmac('sha256',credentials.secret).update(at+'GET'+path).digest('base64'));
  const body='{"walletAddressList":[]}';
  assert.equal(web3Headers(credentials,'POST','/api/v6/defi/user/asset/platform/list',body,at)['OK-ACCESS-SIGN'],createHmac('sha256',credentials.secret).update(at+'POST'+'/api/v6/defi/user/asset/platform/list'+body).digest('base64'));
});
test('transport blocks other destinations, execution, payment, wrong methods and never retries 402',async()=>{
  let calls=0;const request=async()=>{calls++;return new Response('{}',{status:402});};
  for(const path of ['https://evil.example/api/v6/dex/balance/supported/chain','/api/v6/dex/aggregator/swap','/api/v6/pay/a2a/payment/create'])await assert.rejects(()=>web3Read(path,undefined,{credentials,request}),/non_read/);
  await assert.rejects(()=>web3Read('/api/v6/defi/user/asset/platform/list',undefined,{credentials,request}),/invalid_method/);
  assert.equal(calls,0);await assert.rejects(()=>web3Read('/api/v6/dex/balance/supported/chain',undefined,{credentials,request}),/http_402/);assert.equal(calls,1);
});
test('balances use address+chain+contract identity, preserve exact decimals, native is not wrapped',()=>{
  const rows=parseWeb3Tokens(envelope([token,{...token,symbol:'ETH',tokenContractAddress:''}]),address,['1'],at,now);
  assert.equal(rows[0].amountExact,token.balance);assert.equal(rows[0].valueUsd,Number(token.balance)*.99);
  assert.equal(rows[1].tokenId,'eth');assert.equal(rows[1].kind,'native');
  assert.throws(()=>parseWeb3Tokens(envelope([{...token,address:contract}]),address,['1'],at,now),/wrong_address/);
  assert.throws(()=>parseWeb3Tokens(envelope([{...token,chainIndex:'2741'}]),address,['1'],at,now),/wrong_address/);
  assert.equal(parseWeb3Tokens(envelope([{...token,isRiskToken:true}]),address,['1'],at,now).length,0);
  assert.throws(()=>parseWeb3Tokens(envelope([token,{...token,balance:'9'}]),address,['1'],at,now),/conflicting/);
  assert.throws(()=>parseWeb3Tokens({code:'50011',data:[]},address,['1'],at,now),/invalid/);
});
test('returned balances cannot erase absent/risk-filtered holdings or make full coverage fresh',()=>{
  const rows=parseWeb3Tokens(envelope([token]),address,['1'],at,now);
  const previous={at:old,tokens:[{chain:'abs',tokenId:'abs',symbol:'ETH',amount:1,valueUsd:2000,kind:'native',isCore:true,updatedAt:old}],coveredChains:['abs']};
  const applied=applyWeb3Tokens(previous,rows,at);
  assert.equal(applied.at,old);assert.deepEqual(applied.coveredChains,['abs']);assert.equal(applied.tokens.length,2);
  assert.equal(applyWeb3Tokens(applied,[],at).tokens.length,2);
  const newer={...rows[0],amount:2,amountExact:'2',updatedAt:'2026-09-29T00:06:00.000Z'};
  const retained=applyWeb3Tokens({...previous,tokens:[newer]},rows,at);assert.equal(retained.tokens[0].amount,2);
});

test('a later provider HTTP response cannot overwrite an RPC-verified quantity or clear its error',()=>{
  const rows=parseWeb3Tokens(envelope([token]),address,['1'],at,now);
  const uuid='eth:'+contract,rpc={...rows[0],amount:1800,amountExact:'1800.123456789012345678',updatedAt:old,quantitySource:'rpc',quantityBlock:'0x123'};
  const previous={at:old,tokens:[rpc],coveredChains:['eth'],inventory:{[uuid]:{amount:rpc.amount,amountExact:rpc.amountExact,updatedAt:old}},tokenErrors:{[uuid]:'rpc_unavailable'}};
  const applied=applyWeb3Tokens(previous,rows,at);
  assert.equal(applied.tokens[0].amount,rpc.amount);assert.equal(applied.tokens[0].amountExact,rpc.amountExact);
  assert.equal(applied.tokens[0].quantitySource,'rpc');assert.equal(applied.tokens[0].updatedAt,old);
  assert.equal(applied.tokens[0].quantityBlock,'0x123');assert.equal(applied.tokens[0].valueUsd,1800*.99);
  assert.deepEqual(applied.inventory,previous.inventory);assert.equal(applied.tokenErrors[uuid],'rpc_unavailable');
});

test('verified empty supported-chain balances never clear holdings on unsupported chains',()=>{
  const rows=parseWeb3Tokens({code:'0',data:[]},address,['1'],at,now);
  const previous={at:old,tokens:[{chain:'abs',tokenId:'abs',symbol:'ETH',amount:1,valueUsd:2000,kind:'native',isCore:true,updatedAt:old}],coveredChains:['abs']};
  assert.deepEqual(rows,[]);assert.deepEqual(applyWeb3Tokens(previous,rows,at).tokens,previous.tokens);
  assert.equal(applyWeb3Tokens(previous,rows,at).at,old);
  assert.throws(()=>parseWeb3Tokens({code:'50011',data:[]},address,['1'],at,now),/invalid/);
  assert.throws(()=>parseWeb3Tokens({code:'0',data:null},address,['1'],at,now),/invalid/);
});

test('verified empty completed DeFi scope accepts omitted groups, not errors or stale data',()=>{
  const empty={code:'0',data:{assetStatus:1,updateAt:now}};
  assert.deepEqual(parseWeb3DefiOverview(empty,at,now),{platforms:[],observedAt:at});
  assert.throws(()=>parseWeb3DefiOverview({...empty,code:'50011'},at,now),/invalid/);
  assert.throws(()=>parseWeb3DefiOverview({...empty,data:{assetStatus:2,updateAt:now}},at,now),/updating/);
  assert.throws(()=>parseWeb3DefiOverview({...empty,data:{assetStatus:1,updateAt:now-660000}},at,now),/stale_defi/);
});
test('HTTP success with updating or stale DeFi is NOT a fresh successful observation',()=>{
  const overview={code:0,data:{assetStatus:1,updateAt:now,walletIdPlatformList:[{platformList:[]}]}};
  assert.equal(parseWeb3DefiOverview(overview,at,now).observedAt,at);
  assert.throws(()=>parseWeb3DefiOverview({...overview,data:{...overview.data,assetStatus:2}},at,now),/updating/);
  assert.throws(()=>parseWeb3DefiOverview({...overview,data:{...overview.data,updateAt:now-660000}},at,now),/stale_defi/);
  assert.throws(()=>parseWeb3DefiOverview({...overview,data:{...overview.data,walletIdPlatformList:[]}},at,now),/wallet_groups/);
});
test('Fables LP principal and fees are counted once; unsupported protocols and Apps survive',()=>{
  const detail={code:'0',data:[{platformName:'Fables',analysisPlatformId:141415,walletIdPlatformDetailList:[{networkHoldVoList:[{chainIndex:'4663',totalAssert:'12',investTokenBalanceVoList:[{investType:2,investmentName:'USDC-USDG',totalValue:'12',positionList:[{assetsTokenList:[{tokenSymbol:'USDG',coinAmount:'10',currencyAmount:'10'}],unclaimFeesDefiTokenInfo:[{baseDefiTokenInfos:[{tokenSymbol:'USDG',coinAmount:'2',currencyAmount:'2'}]}]}]}]}]}]}]};
  const previous={at:old,protocols:[{id:'abs_kona'},{id:'hood_fables',portfolio_item_list:[]}],apps:[{id:'polymarket'}]};
  const applied=applyFablesDetail(previous,detail,{platforms:[],observedAt:at});
  assert.equal(applied.at,old);assert.equal(applied.protocols.length,2);assert.deepEqual(applied.apps,previous.apps);
  assert.equal(applied.protocolUpdatedAt.hood_fables,at);assert.equal(applied.protocols[1].portfolio_item_list[0].stats.net_usd_value,12);
  detail.data[0].walletIdPlatformDetailList[0].networkHoldVoList[0].totalAssert='13';
  assert.throws(()=>applyFablesDetail(previous,detail,{platforms:[],observedAt:at}),/value_mismatch/);
});
test('history retains multiple token transfers per hash, rejects stale, pending and spam; no invented USD price',()=>{
  const hash='0x'+'a'.repeat(64),recipient='0x3333333333333333333333333333333333333333';
  const tx={chainIndex:'1',txHash:hash,txTime:String(now-10000),itype:'2',from:[{address}],to:[{address:recipient}],amount:'50',symbol:'USDT',tokenContractAddress:contract,txStatus:'success',hitBlacklist:false,methodId:'0x12345678'};
  const payload={code:'0',data:[{cursor:'123',transactions:[tx,{...tx,tokenContractAddress:recipient,symbol:'USDC'},{...tx,txStatus:'pending'},{...tx,hitBlacklist:true},{...tx,txTime:String(now-864000000)}]}]};
  const parsed=parseWeb3History(payload,address,['1'],now-600000,now);
  assert.equal(parsed.records.length,1);assert.equal(parsed.records[0].transfers.length,2);assert.equal(parsed.records[0].transfers[0].valueUsd,null);
  assert.equal(parsed.records[0].operation,'execute');assert.equal(parsed.cursor,'123');
});
test('verified successful null history is empty, but error/missing envelopes are not',()=>{
  assert.deepEqual(parseWeb3History({code:'0',data:[{transactions:null,cursor:''}]},address,['1'],now-600000,now),{records:[],cursor:''});
  assert.throws(()=>parseWeb3History({code:'50011',data:[{transactions:null,cursor:''}]},address,['1'],now-600000,now),/invalid/);
  assert.throws(()=>parseWeb3History({code:'0',data:[{}]},address,['1'],now-600000,now),/invalid/);
});

test('a bad amount or multi-party row does not drop the rest of the page',()=>{
  const hash='0x'+'b'.repeat(64),other='0x4444444444444444444444444444444444444444';
  const good={chainIndex:'1',txHash:hash,txTime:String(now-10000),itype:'2',from:[{address}],to:[{address:other}],amount:'12.5',symbol:'USDC',tokenContractAddress:contract,txStatus:'success',hitBlacklist:false};
  const bad={...good,txHash:'0x'+'c'.repeat(64),amount:''};
  const multiHash='0x'+'d'.repeat(64);
  const multi={...good,txHash:multiHash,amount:'999',from:[{address,amount:'40'},{address:other,amount:'1'}],to:[{address:other,amount:'40'}],symbol:'USDT'};
  const parsed=parseWeb3History({code:'0',data:[{cursor:'',transactions:[bad,good,multi]}]},address,['1'],now-600000,now);
  assert.equal(parsed.records.length,2);
  const single=parsed.records.find(row=>row.hash===hash);
  assert.equal(single.transfers[0].quantity,'12.5');
  const many=parsed.records.find(row=>row.hash===multiHash);
  assert.equal(many.transfers.length,1);
  assert.equal(many.transfers[0].quantity,'40');
});
