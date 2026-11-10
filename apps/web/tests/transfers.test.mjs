import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildTransferSummary, mergeTransactionRecords} from '../src/lib/transfers.ts';

const wallet = {id:'w1',name:'主钱包',address:'0x1111111111111111111111111111111111111111',chain:'EVM',balanceUsd:0,lastUpdated:null,status:'ok'};
const other = '0x2222222222222222222222222222222222222222';
const minedAt = new Date().toISOString();

test('buildTransferSummary formats 钱包 转入/转出 资产 and ignores non-tracked wallets',()=>{
  const state = {
    wallets:[wallet],
    transactionHistory:{
      [wallet.address]:{
        at:minedAt,source:'alchemy',more:false,
        records:[{
          hash:'0x'+'ab'.repeat(32),chain:'eth',minedAt,operation:'receive',
          transfers:[
            {sender:other,recipient:wallet.address,symbol:'USDT',quantity:'100.5',valueUsd:100.5},
            {sender:wallet.address,recipient:other,symbol:'ETH',quantity:'0.25',valueUsd:null},
          ],
        }],
      },
      ['0x9999999999999999999999999999999999999999']:{
        at:minedAt,source:'alchemy',more:false,
        records:[{hash:'0x'+'cd'.repeat(32),chain:'eth',minedAt,operation:'send',transfers:[{sender:'0x9999999999999999999999999999999999999999',recipient:other,symbol:'USDT',quantity:'1',valueUsd:1}]}],
      },
    },
    manual:[],exchanges:[],snapshots:[],flowEvents:[],
  };
  const summary = buildTransferSummary(state,{range:'7d',limit:20});
  assert.equal(summary.lines.length,2);
  assert.equal(summary.lines.find(l=>l.direction==='in').summary,'主钱包 转入 100.5 USDT');
  assert.equal(summary.lines.find(l=>l.direction==='out').summary,'主钱包 转出 0.25 ETH');
  assert.equal(summary.walletCoverage,1);
  assert.ok(summary.sources.includes('alchemy'));
});

test('mergeTransactionRecords dedupes by chain:hash and keeps distinct legs',()=>{
  const a={hash:'0x'+'ab'.repeat(32),chain:'eth',minedAt,operation:'send',transfers:[{sender:wallet.address,recipient:other,symbol:'USDT',quantity:'1',valueUsd:null}]};
  const b={...a,transfers:[{sender:wallet.address,recipient:other,symbol:'ETH',quantity:'2',valueUsd:null,contractAddress:undefined}]};
  const merged=mergeTransactionRecords([a],[b]);
  assert.equal(merged.length,1);
  assert.equal(merged[0].transfers.length,2);
});

test('drops priced transfers under 1 USD and hides unpriced ERC-20 airdrops',()=>{
  const state = {
    wallets:[wallet],
    tokenCache:{
      [wallet.address]:{at:minedAt,tokens:[
        {chain:'bsc',symbol:'BNB',amount:1,valueUsd:600,tokenId:'bnb',kind:'native',isCore:true},
        {chain:'eth',symbol:'ETH',amount:1,valueUsd:3000,tokenId:'eth',kind:'native',isCore:true},
      ],unpricedCount:0,unpricedByChain:{},coveredChains:['bsc','eth']},
    },
    transactionHistory:{
      [wallet.address]:{
        at:minedAt,source:'okx-web3',more:false,
        records:[{
          hash:'0x'+'11'.repeat(32),chain:'bsc',minedAt,operation:'receive',
          transfers:[{sender:other,recipient:wallet.address,symbol:'BNB',quantity:'0.0002',valueUsd:null}],
        },{
          hash:'0x'+'22'.repeat(32),chain:'eth',minedAt,operation:'receive',
          transfers:[{sender:other,recipient:wallet.address,symbol:'ETH',quantity:'0.01',valueUsd:null}],
        },{
          hash:'0x'+'33'.repeat(32),chain:'eth',minedAt,operation:'receive',
          transfers:[{sender:other,recipient:wallet.address,symbol:'USDC',quantity:'0.4',valueUsd:null,contractAddress:'0x'+'ab'.repeat(20)}],
        },{
          hash:'0x'+'44'.repeat(32),chain:'eth',minedAt,operation:'receive',
          transfers:[{sender:other,recipient:wallet.address,symbol:'NEWTOKEN',quantity:'250',valueUsd:null,contractAddress:'0x'+'cd'.repeat(20)}],
        },{
          hash:'0x'+'55'.repeat(32),chain:'bsc',minedAt,operation:'receive',
          transfers:[{sender:other,recipient:wallet.address,symbol:'www.poks.top',quantity:'9000',valueUsd:null,contractAddress:'0x'+'ef'.repeat(20)}],
        }],
      },
    },
    manual:[],exchanges:[],snapshots:[],flowEvents:[],
  };
  const summary = buildTransferSummary(state,{range:'7d',limit:20});
  const symbols = summary.lines.map(line=>line.symbol).sort();
  assert.deepEqual(symbols, ['ETH']);
  const eth = summary.lines.find(line=>line.symbol==='ETH');
  assert.equal(eth.valueUsd, 30);
});
