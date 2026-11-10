import {mutateLiveStore as mutateStore,readLiveStore as readStore} from './store';
import {web3Credentials,web3Read} from './onchain/okx-web3';
import {OKX_CHAIN_IDS,parseWeb3Tokens,applyWeb3Tokens,parseWeb3DefiOverview,applyFablesDetail,parseWeb3History} from './onchain/okx-web3-observation';
import {refreshOnchainBreakdown} from './onchain/debank';
import type {Wallet,WalletTokenCacheEntry,WalletProtocolCacheEntry} from './types';
import type {TransactionRecord} from './transaction-records';
import {dueWeb3Wallets} from './web3-scheduling';
import {preserveRpcProtocols} from './onchain/protocol-observation';

const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const safeError=(error:unknown)=>error instanceof Error&&/^web3_[a-z0-9_]+$/.test(error.message)?error.message:'web3_request_failed';
const BATCH=3,MAX_CALLS=24,FREE_CALL_CAP=1_200_000;

export async function refreshWeb3Observations(){
  if(!web3Credentials())return {ok:true,ran:'disabled'};
  const start=Date.now(),at=new Date(start).toISOString(),month=at.slice(0,7);
  // Cross-instance reservation: one minute queue, not one timer per browser/runner.
  const reservation=await mutateStore(state=>{
    const audit=state.web3Audit??{wallets:{}};state.web3Audit=audit;
    if(start-(Date.parse(audit.lastCycleAt??'')||0)<45_000||Date.parse(audit.cooldownUntil??'')>start)return [] as Wallet[];
    if(audit.usage?.month!==month)audit.usage={month,reservedCalls:0};
    if(audit.usage!.reservedCalls+MAX_CALLS>FREE_CALL_CAP)return [] as Wallet[];
    const selected=dueWeb3Wallets(state.wallets,audit,start,BATCH);
    if(!selected.length)return selected;
    audit.usage!.reservedCalls+=MAX_CALLS;audit.lastCycleAt=at;
    for(const w of selected)audit.wallets[w.id]={...audit.wallets[w.id],lastAttemptAt:at,retryAt:undefined};
    return selected;
  });
  if(!reservation.result.length)return {ok:true,ran:'not_due'};
  let lastRequest=0,calls=0,rateLimited=false;
  async function read(path:string,body?:unknown){
    // Leave sufficient time for the final CAS write inside Vercel's 60s limit.
    if(rateLimited||Date.now()-start>32_000||calls>=MAX_CALLS)throw new Error('web3_cycle_budget');
    await wait(Math.max(0,lastRequest+1250-Date.now()));lastRequest=Date.now();calls++;
    try{return await web3Read(path,body);}catch(error){
      if(['web3_http_429','web3_code_50011'].includes(safeError(error)))rateLimited=true;
      throw error;
    }
  }
  let balanceIds:string[]=[],defiIds:string[]=[];
  try{
    const audit=reservation.state.web3Audit!;
    if(start-(Date.parse(audit.metadataAt??'')||0)>24*3600000||!audit.balanceChains?.length||!audit.defiChains?.length){
      const balance=await read('/api/v6/dex/balance/supported/chain'),defi=await read('/api/v6/defi/product/supported-chains');
      const ids=(payload:Record<string,unknown>)=>{
        if(!Array.isArray(payload.data)||!payload.data.length)throw new Error('web3_invalid_chain_metadata');
        const values=payload.data.map(c=>String(c.chainIndex));
        if(values.some(v=>!/^\d+$/.test(v))||new Set(values).size!==values.length)throw new Error('web3_invalid_chain_metadata');return values;
      };
      balanceIds=ids(balance);defiIds=ids(defi);
      await mutateStore(state=>{const a=state.web3Audit!;a.balanceChains=balanceIds;a.defiChains=defiIds;a.metadataAt=new Date().toISOString();});
    }else{balanceIds=audit.balanceChains;defiIds=audit.defiChains;}
  }catch(error){
    await mutateStore(state=>{
      for(const w of reservation.result)if(state.web3Audit!.wallets[w.id].lastAttemptAt===at)state.web3Audit!.wallets[w.id].error=safeError(error);
      if(rateLimited)state.web3Audit!.cooldownUntil=new Date(Date.now()+10*60000).toISOString();
    });return {ok:false,ran:'metadata_failed',error:safeError(error)};
  }
  const mapped=new Set(Object.values(OKX_CHAIN_IDS)),chains=balanceIds.filter(id=>mapped.has(id)).slice(0,50),protocolChains=defiIds.filter(id=>mapped.has(id)).slice(0,50);
  type Result={wallet:Wallet;tokens?:WalletTokenCacheEntry['tokens'];tokensAt?:string;error?:string;protocol?:WalletProtocolCacheEntry;protocolAt?:string;fablesAbsentAt?:string;protocolError?:string;history?:{records:TransactionRecord[];cursor:string};historyAt?:string;historyError?:string};
  const results:Result[]=[];
  for(const wallet of reservation.result){
    if(rateLimited||Date.now()-start>32_000)break;
    const result:Result={wallet},address=wallet.address.toLowerCase();
    try{
      const data=await read('/api/v6/dex/balance/all-token-balances-by-address?'+new URLSearchParams({address,chains:chains.join(','),excludeRiskToken:'1'}));
      result.tokensAt=new Date().toISOString();result.tokens=parseWeb3Tokens(data,address,chains,result.tokensAt);
    }catch(error){result.error=safeError(error);}
    const fablesRpcAt=reservation.state.protocolCache?.[address]?.protocolRpcOwnership?.hood_fables?.at;
    try{
      if(fablesRpcAt&&Date.now()-Date.parse(fablesRpcAt)<=20*60000){
        // The native Lens has already checked this owner's complete Fables
        // ledger. Do not spend another API call on a delayed provider snapshot.
      }else{
      const data=await read('/api/v6/defi/user/asset/platform/list',{walletAddressList:protocolChains.map(chainIndex=>({chainIndex,walletAddress:address}))});
      const overview=parseWeb3DefiOverview(data,new Date().toISOString());
      const platform=overview.platforms.find(p=>String(p.analysisPlatformId)==='141415'&&p.platformName==='Fables');
      // Other protocols need their own coverage/debt/double-counting adapters.
      if(platform){
        const detail=await read('/api/v6/defi/user/asset/platform/detail',{walletAddressList:[{chainIndex:'4663',walletAddress:address}],platformList:[{chainIndex:'4663',analysisPlatformId:'141415'}]});
        result.protocol=applyFablesDetail(undefined,detail,overview);result.protocolAt=overview.observedAt;
      }else if(protocolChains.includes('4663'))result.fablesAbsentAt=overview.observedAt;
      }
    }catch(error){result.protocolError=safeError(error);}
    try{
      const begin=Date.now()-30*86400000;
      const collected:TransactionRecord[]=[];
      let cursor='';
      // OKX now rejects multi-chain limit>20 (code 81001), so walk four 20-row pages
      // (3 wallets x ~6 calls fits MAX_CALLS). Order is not strictly by time across chains.
      for(let page=0;page<4;page++){
        const params=new URLSearchParams({address,chains:chains.join(','),begin:String(begin),limit:'20'});
        if(cursor)params.set('cursor',cursor);
        let history:Record<string,unknown>;
        try{history=await read('/api/v6/dex/post-transaction/transactions-by-address?'+params);}
        catch(error){if(!collected.length)throw error;break;}
        const parsed=parseWeb3History(history,address,chains,begin);
        collected.push(...parsed.records);
        cursor=parsed.cursor;
        if(!cursor)break;
      }
      result.history={records:collected,cursor};result.historyAt=new Date().toISOString();
    }catch(error){result.historyError=safeError(error);}
    results.push(result);
  }
  await mutateStore(async state=>{
    const cache={...state.tokenCache},protocols={...state.protocolCache},history={...state.transactionHistory};
    for(const result of results){
      const {wallet}=result,address=wallet.address.toLowerCase();
      if(!state.wallets.some(w=>w.id===wallet.id&&w.address.toLowerCase()===address))continue;
      const audit=state.web3Audit!.wallets[wallet.id];
      if(audit.lastAttemptAt!==at)continue;
      audit.error=result.error;audit.protocolError=result.protocolError;audit.historyError=result.historyError;
      if(result.tokens){cache[address]=applyWeb3Tokens(cache[address],result.tokens,result.tokensAt!);audit.tokensAt=result.tokensAt;audit.tokenCount=result.tokens.length;}
      if(result.protocol&&Date.parse(result.protocolAt!)>Math.max(Date.parse(protocols[address]?.at??'')||0,Date.parse(protocols[address]?.protocolUpdatedAt?.hood_fables??'')||0)){
        const previous=protocols[address]??{at:'',protocols:[]};
        protocols[address]=preserveRpcProtocols(previous,{...previous,protocolUpdatedAt:{...previous.protocolUpdatedAt,hood_fables:result.protocolAt!},
          protocols:[...previous.protocols.filter(p=>p.id!=='hood_fables'),...result.protocol.protocols]});
        audit.protocolAt=result.protocolAt;
        audit.fablesAbsentSince=undefined;
      }
      if(result.fablesAbsentAt){
        // Two separate fresh completed provider snapshots confirm disappearance.
        // A stale/updating/failed response never reaches this branch.
        const absentMs=Date.parse(result.fablesAbsentAt),since=Date.parse(audit.fablesAbsentSince??'')||0;
        const previous=protocols[address];
        if(!since||absentMs<since)audit.fablesAbsentSince=result.fablesAbsentAt;
        else if(absentMs-since>=4*60000&&previous&&absentMs>Math.max(Date.parse(previous.at)||0,Date.parse(previous.protocolUpdatedAt?.hood_fables??'')||0)){
          protocols[address]=preserveRpcProtocols(previous,{...previous,protocolUpdatedAt:{...previous.protocolUpdatedAt,hood_fables:result.fablesAbsentAt},protocols:previous.protocols.filter(p=>p.id!=='hood_fables')});
        }
      }
      if(result.history&&Date.parse(result.historyAt!)>(Date.parse(history[address]?.at??'')||0)){
        const combined=new Map<string,TransactionRecord>();
        for(const tx of [...(history[address]?.records??[]),...result.history.records]){
          if(Date.now()-Date.parse(tx.minedAt)>30*86400000)continue;
          const id=tx.chain+':'+tx.hash,previous=combined.get(id);
          if(previous){for(const t of tx.transfers)if(!previous.transfers.some(p=>JSON.stringify(p)===JSON.stringify(t)))previous.transfers.push(t);}
          else combined.set(id,{...tx,transfers:[...tx.transfers]});
        }
        history[address]={at:result.historyAt!,source:'okx-web3',more:!!result.history.cursor,records:[...combined.values()].sort((a,b)=>Date.parse(b.minedAt)-Date.parse(a.minedAt)).slice(0,500)};
        audit.historyAt=result.historyAt;
      }
    }
    state.tokenCache=cache;state.protocolCache=protocols;state.transactionHistory=history;
    const completed=new Set(results.map(result=>result.wallet.id));
    for(const wallet of reservation.result)if(!completed.has(wallet.id)&&state.web3Audit!.wallets[wallet.id]?.lastAttemptAt===at){
      state.web3Audit!.wallets[wallet.id].retryAt=new Date(Date.now()+45_000).toISOString();
    }
    if(rateLimited)state.web3Audit!.cooldownUntil=new Date(Date.now()+10*60000).toISOString();
    state.onchainBreakdown=await refreshOnchainBreakdown(state.wallets,state.chainCache??{},cache,protocols,state.zerionDefi??{});
  });
  return {ok:results.length===reservation.result.length&&results.every(r=>!r.error),ran:'web3-observations',targeted:reservation.result.length,updated:results.filter(r=>r.tokens).length,calls,
    protocolsUpdated:results.filter(r=>r.protocol).length,protocolsDeferred:results.filter(r=>r.protocolError).length,historyUpdated:results.filter(r=>r.history).length,
    failed:results.filter(r=>r.error).map(r=>({wallet:r.wallet.id,error:r.error})),unsupportedKnownChains:Object.keys(OKX_CHAIN_IDS).filter(chain=>!balanceIds.includes(OKX_CHAIN_IDS[chain]))};
}

export async function web3Status(){
  const state=await readStore(),audit=state.web3Audit;
  return {configured:!!web3Credentials(),audit:audit??null,fullWalletTotalReplacement:false,
    reason:'token_balances_do_not_prove_complete_protocol_and_chain_coverage'};
}
