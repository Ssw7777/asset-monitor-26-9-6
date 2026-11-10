import type {WalletTokenCacheEntry,WalletProtocolCacheEntry} from '../types';
import type {TransactionRecord} from '../transaction-records';
import {canonicalTokenId} from './token-identity.ts';
import {isJunkTokenSymbol} from './junk-tokens.ts';

// Balance coverage is obtained from the live supported-chain endpoint, not this map.
// The map only converts established EVM IDs to the dashboard's canonical IDs.
export const OKX_CHAIN_IDS:Record<string,string>={eth:'1',arb:'42161',base:'8453',op:'10',bsc:'56',matic:'137',linea:'59144',hood:'4663',abs:'2741',
  xlayer:'196',avax:'43114',ink:'57073',rsk:'30',ape:'33139',scrl:'534352',megaeth:'4326',monad:'143',opbnb:'204',arc:'5042',plasma:'9745',katana:'747474',
  zora:'7777777',bera:'80094',sei:'1329',klay:'8217',gravity:'1625',merlin:'4200',core:'1116',ftm:'250',celo:'42220',era:'324',blast:'81457',mnt:'5000'};
const chainsById=Object.fromEntries(Object.entries(OKX_CHAIN_IDS).map(([chain,id])=>[id,chain]));
const stable=new Set(['USDT','USDC','USDG','USD1','USD₮0','USDT0','USDE','DAI','FRXUSD','AUSD','PYUSD','FDUSD','USDS']);
const record=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('web3_invalid_payload');return v as Record<string,unknown>};
const decimal=(v:unknown)=>{if(typeof v!=='string'||v.length>100||!/^\d+(?:\.\d+)?$/.test(v)||!Number.isFinite(Number(v)))throw new Error('web3_invalid_decimal');return Number(v)};
function validTime(at:string,now:number){const ms=Date.parse(at);if(!Number.isFinite(ms)||ms>now+60000||now-ms>600000)throw new Error('web3_stale_observation');return ms;}

export function parseWeb3Tokens(payload:unknown,address:string,requested:string[],at:string,now=Date.now()):WalletTokenCacheEntry['tokens']{
  validTime(at,now);const envelope=record(payload);
  if(String(envelope.code)!=='0'||!Array.isArray(envelope.data))throw new Error('web3_invalid_payload');
  // Verified live: an address with no holdings on the requested supported chains
  // returns data: []. This is not proof that its unsupported chains are empty.
  if(envelope.data.length===0)return [];
  if(envelope.data.length!==1)throw new Error('web3_invalid_payload');
  const data=record(envelope.data[0]);if(!Array.isArray(data.tokenAssets)||data.tokenAssets.length>10000)throw new Error('web3_invalid_tokens');
  const rows=new Map<string,WalletTokenCacheEntry['tokens'][number]>();
  for(const item of data.tokenAssets){
    const r=record(item),id=String(r.chainIndex),chain=chainsById[id];
    if(!chain||!requested.includes(id)||String(r.address).toLowerCase()!==address.toLowerCase())throw new Error('web3_wrong_address_or_chain');
    const amount=decimal(r.balance),price=decimal(r.tokenPrice),valueUsd=amount*price;
    if(!Number.isFinite(valueUsd))throw new Error('web3_invalid_value');
    if(typeof r.isRiskToken!=='boolean')throw new Error('web3_missing_risk_flag');
    if(r.isRiskToken)continue;
    if(isJunkTokenSymbol(String(r.symbol||'')))continue;
    const contract=String(r.tokenContractAddress).toLowerCase();
    if(contract!==''&&!/^0x[a-f0-9]{40}$/.test(contract))throw new Error('web3_invalid_contract');
    if(typeof r.symbol!=='string'||!r.symbol.trim()||r.symbol.length>100)throw new Error('web3_invalid_symbol');
    const tokenId=contract||chain,uuid=chain+':'+tokenId;
    const row:WalletTokenCacheEntry['tokens'][number]={chain,tokenId,contractAddress:contract||undefined,symbol:r.symbol.trim(),
      amount,amountExact:r.balance as string,valueUsd,valuationPrice:price,priceUpdatedAt:at,priceSource:'okx-web3',updatedAt:at,quantitySource:'okx-web3',
      isCore:true,kind:!contract?'native':stable.has(r.symbol.toUpperCase().replace(/\.E$/,''))?'stable':'spot'};
    const previous=rows.get(uuid);if(previous&&(previous.amountExact!==row.amountExact||previous.valuationPrice!==row.valuationPrice))throw new Error('web3_conflicting_token');
    rows.set(uuid,row);
  }
  return [...rows.values()];
}

/** Discovery/returned balances only. Absence is NOT proof of zero (risk filtering or provider coverage). */
export function applyWeb3Tokens(previous:WalletTokenCacheEntry|undefined,rows:WalletTokenCacheEntry['tokens'],at:string):WalletTokenCacheEntry {
  const base=previous??{at:'',tokens:[],unpricedCount:0,unpricedByChain:{},coveredChains:[]};
  const tokens=base.tokens.map(t=>({...t})),inventory={...base.inventory},tokenErrors={...base.tokenErrors},rpcTokenMetadata={...base.rpcTokenMetadata};
  for(const row of rows){
    const uuid=row.chain+':'+row.tokenId,matches=tokens.filter(t=>t.chain===row.chain&&canonicalTokenId(t)===row.tokenId);
    const existing=matches[0];
    if(!existing&&(!row.amount||row.valueUsd<.01))continue;
    const latest=Math.max(Date.parse(inventory[uuid]?.updatedAt??'')||0,...matches.map(t=>Date.parse(t.updatedAt??base.chainUpdatedAt?.[t.chain]??base.at)||0));
    if(latest>=Date.parse(at))continue;
    for(let i=tokens.length-1;i>=0;i--)if(matches.includes(tokens[i]))tokens.splice(i,1);
    const merged={...row,logoUrl:existing?.logoUrl};
    // Provider query time is not an on-chain block time. Once a balance has been
    // verified by RPC, a newer HTTP response must not roll it back to a provider
    // cache. Keep the verified quantity/time; use OKX for discovery and quotes.
    const rpcVerified=existing?.quantitySource==='rpc';
    if(rpcVerified){
      merged.amount=existing.amount;merged.amountExact=existing.amountExact;
      merged.updatedAt=existing.updatedAt;merged.quantitySource='rpc';merged.quantityBlock=existing.quantityBlock;
      merged.valueUsd=merged.amount*(merged.valuationPrice??0);
    }
    // A newer independent quote stays newer even when the quantity changes.
    if(existing&&(Date.parse(existing.priceUpdatedAt??'')||0)>Date.parse(at)){
      merged.valuationPrice=existing.valuationPrice??(existing.amount?existing.valueUsd/existing.amount:0);
      merged.priceUpdatedAt=existing.priceUpdatedAt;merged.priceSource=existing.priceSource;merged.valueUsd=merged.amount*merged.valuationPrice;
    }
    tokens.push(merged);
    if(!rpcVerified)inventory[uuid]={...inventory[uuid],amount:row.amount,amountExact:row.amountExact,updatedAt:at};
    rpcTokenMetadata[uuid]=merged;if(!rpcVerified)delete tokenErrors[uuid];
  }
  // No advance of full-chain coverage, full wallet value, or its successful timestamp.
  const visible=tokens.filter(row=>!isJunkTokenSymbol(row.symbol));
  return {...base,tokens:visible.sort((a,b)=>b.valueUsd-a.valueUsd),inventory,rpcTokenMetadata,tokenErrors};
}

export function parseWeb3DefiOverview(payload:unknown,at:string,now=Date.now()){
  validTime(at,now);const envelope=record(payload);if(String(envelope.code)!=='0')throw new Error('web3_invalid_payload');
  const data=record(envelope.data),ms=Number(data.updateAt);
  if(data.assetStatus!==1)throw new Error('web3_defi_updating');
  if(!Number.isFinite(ms)||ms<=0||ms>now+60000||now-ms>600000)throw new Error('web3_stale_defi');
  // Verified live: a completed, fresh scoped query with no positions omits the
  // group property altogether. Do not accept updating/stale responses here.
  if(data.walletIdPlatformList===undefined)return {platforms:[] as Record<string,unknown>[],observedAt:new Date(ms).toISOString()};
  if(!Array.isArray(data.walletIdPlatformList)||data.walletIdPlatformList.length!==1)throw new Error('web3_invalid_wallet_groups');
  const wallet=record(data.walletIdPlatformList[0]);if(!Array.isArray(wallet.platformList))throw new Error('web3_invalid_protocols');
  const platforms=wallet.platformList.map(item=>{const p=record(item);decimal(p.currencyAmount);if(!p.platformName||!p.analysisPlatformId||!Array.isArray(p.networkBalanceList))throw new Error('web3_invalid_protocol');return p;});
  return {platforms,observedAt:new Date(ms).toISOString()};
}

/** Protocol-specific LP adapter: preserve every unsupported protocol/chain and App asset. */
export function applyFablesDetail(previous:WalletProtocolCacheEntry|undefined,detail:unknown,overview:ReturnType<typeof parseWeb3DefiOverview>):WalletProtocolCacheEntry {
  const base=previous??{at:'',protocols:[]},at=overview.observedAt;
  const latest=Date.parse(String(base.protocolUpdatedAt?.hood_fables??base.at))||0;
  if(Date.parse(at)<=latest)return base;
  const envelope=record(detail);if(String(envelope.code)!=='0'||!Array.isArray(envelope.data)||envelope.data.length!==1)throw new Error('web3_invalid_fables');
  const platform=record(envelope.data[0]);if(String(platform.analysisPlatformId)!=='141415'||platform.platformName!=='Fables')throw new Error('web3_wrong_protocol');
  if(!Array.isArray(platform.walletIdPlatformDetailList)||platform.walletIdPlatformDetailList.length!==1)throw new Error('web3_invalid_wallet_groups');
  const wallet=record(platform.walletIdPlatformDetailList[0]);if(!Array.isArray(wallet.networkHoldVoList)||wallet.networkHoldVoList.length!==1)throw new Error('web3_invalid_fables_chains');
  const network=record(wallet.networkHoldVoList[0]);if(String(network.chainIndex)!=='4663'||!Array.isArray(network.investTokenBalanceVoList))throw new Error('web3_wrong_chain');
  const items=network.investTokenBalanceVoList.map(raw=>{
    const position=record(raw);if(position.investType!==2||!Array.isArray(position.positionList)||position.positionList.length===0)throw new Error('web3_unsupported_fables_position');
    const value=decimal(position.totalValue),assets:Record<string,unknown>[]=[],rewards:Record<string,unknown>[]=[];
    const token=(raw:unknown)=>{const t=record(raw);return {symbol:String(t.tokenSymbol),amount:decimal(t.coinAmount),price:decimal(t.coinAmount)?decimal(t.currencyAmount)/decimal(t.coinAmount):0};};
    for(const raw of position.positionList){
      const lp=record(raw);if(!Array.isArray(lp.assetsTokenList))throw new Error('web3_invalid_fables_tokens');
      assets.push(...lp.assetsTokenList.map(token));
      for(const rawReward of (Array.isArray(lp.unclaimFeesDefiTokenInfo)?lp.unclaimFeesDefiTokenInfo:[])){
        const reward=record(rawReward);if(!Array.isArray(reward.baseDefiTokenInfos))throw new Error('web3_invalid_fables_rewards');
        rewards.push(...reward.baseDefiTokenInfos.map(token));
      }
    }
    const explained=[...assets,...rewards].reduce((sum,t)=>sum+Number(t.amount)*Number(t.price),0);
    if(Math.abs(explained-value)>Math.max(.03,value*.005))throw new Error('web3_fables_value_mismatch');
    return {name:position.investmentName,stats:{asset_usd_value:value,debt_usd_value:0,net_usd_value:value},detail:{supply_token_list:assets,reward_token_list:rewards}};
  });
  const net=items.reduce((sum,item)=>sum+item.stats.net_usd_value,0),expected=decimal(network.totalAssert);
  if(Math.abs(net-expected)>.03)throw new Error('web3_fables_value_mismatch');
  const protocol={id:'hood_fables',name:'Fables',chain:'hood',site_url:'https://www.fables.fi',logo_url:platform.platformLogo,portfolio_item_list:items,observed_at:at};
  return {...base,protocolUpdatedAt:{...base.protocolUpdatedAt,hood_fables:at},protocols:[...base.protocols.filter(p=>p.id!=='hood_fables'),...(net>.005?[protocol]:[])]};
}

const evmAddress=(value:unknown)=>{
  const text=String(value??'').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(text)?text:null;
};
/** Human amount as returned by OnchainOS (not raw wei). Invalid rows are skipped, never fatal. */
function positiveAmount(value:unknown):string|null{
  const text=typeof value==='number'&&Number.isFinite(value)?String(value):typeof value==='string'?value.trim():'';
  if(!/^\d+(?:\.\d+)?$/.test(text))return null;
  const amount=Number(text);
  return Number.isFinite(amount)&&amount>0?text:null;
}
function party(value:unknown){
  try{const row=record(value);return {address:evmAddress(row.address),amount:positiveAmount(row.amount)};}
  catch{return {address:null,amount:null};}
}

export function parseWeb3History(payload:unknown,address:string,chains:string[],beginMs:number,now=Date.now()):{records:TransactionRecord[];cursor:string} {
  const envelope=record(payload);if(String(envelope.code)!=='0'||!Array.isArray(envelope.data)||envelope.data.length!==1)throw new Error('web3_invalid_history');
  const data=record(envelope.data[0]),raw=data.transactions??data.transactionList;
  // Verified live: a successful empty history is {cursor:'',transactions:null}.
  if((data.transactions===null||data.transactionList===null)&&data.cursor===''&&(raw==null))return {records:[],cursor:''};
  // Multi-chain queries may return up to 100 rows. One bad amount must not drop the page.
  if(!Array.isArray(raw)||raw.length>100)throw new Error('web3_invalid_history');
  const wallet=address.toLowerCase();
  const records=new Map<string,TransactionRecord>();
  for(const value of raw){
    let t:Record<string,unknown>;
    try{t=record(value);}catch{continue;}
    const id=String(t.chainIndex),chain=chainsById[id],ms=Number(t.txTime);
    // The live multi-chain endpoint returned old transactions despite begin. Filter locally, too.
    if(t.txStatus!=='success'||t.hitBlacklist!==false||!chain||!chains.includes(id)||!Number.isFinite(ms)||ms<beginMs||ms>now+60000)continue;
    const hash=String(t.txHash).toLowerCase();if(!/^0x[a-f0-9]{64}$/.test(hash))continue;
    if(!Array.isArray(t.from)||!Array.isArray(t.to)||!t.from.length||!t.to.length)continue;
    const from=t.from.map(party).filter(row=>row.address),to=t.to.map(party).filter(row=>row.address);
    if(!from.length||!to.length)continue;
    const contract=String(t.tokenContractAddress??'').toLowerCase();
    if(contract!==''&&!/^0x[a-f0-9]{40}$/.test(contract))continue;
    const top=positiveAmount(t.amount);
    const legs:{sender:string;recipient:string;quantity:string}[]=[];
    if(from.length===1&&to.length===1){
      const sender=from[0].address!,recipient=to[0].address!;
      if(sender!==wallet&&recipient!==wallet)continue;
      // OnchainOS amount is already a human quantity. Checked against BSC/ETH logs:
      // USDC 1000 (6 dp) and USD1/USDT (18 dp) matched; do not divide by decimals again.
      const quantity=top||from[0].amount||to[0].amount;
      if(quantity)legs.push({sender,recipient,quantity});
    }else{
      // Swaps often list several counterparties. A length===1 gate dropped those whole txs.
      for(const row of from){
        if(row.address!==wallet)continue;
        const recipient=to.length===1?to[0].address!:null;
        const quantity=row.amount||(to.length===1?top:null);
        if(recipient&&quantity)legs.push({sender:wallet,recipient,quantity});
      }
      for(const row of to){
        if(row.address!==wallet)continue;
        const sender=from.length===1?from[0].address!:null;
        const quantity=row.amount||(from.length===1?top:null);
        if(sender&&quantity)legs.push({sender,recipient:wallet,quantity});
      }
    }
    if(!legs.length)continue;
    const sender=legs[0].sender;
    const key=chain+':'+hash,tx=records.get(key)??{hash,chain,minedAt:new Date(ms).toISOString(),operation:t.methodId==='0x095ea7b3'?'approve':t.methodId?'execute':sender===wallet?'send':'receive',transfers:[]};
    for(const leg of legs){
      const transfer={sender:leg.sender,recipient:leg.recipient,symbol:String(t.symbol??''),quantity:leg.quantity,valueUsd:null as number|null,contractAddress:contract||undefined};
      if(!tx.transfers.some(row=>row.sender===transfer.sender&&row.recipient===transfer.recipient&&row.quantity===transfer.quantity&&row.contractAddress===transfer.contractAddress))tx.transfers.push(transfer);
    }
    records.set(key,tx);
  }
  return {records:[...records.values()].sort((a,b)=>Date.parse(b.minedAt)-Date.parse(a.minedAt)),cursor:typeof data.cursor==='string'?data.cursor:''};
}
