import { mutateLiveStore as mutateStore } from './store';
import { readRpcChain, RPC_NETWORKS, type RpcTarget, type RpcChainResult } from './onchain/rpc-balances';
import { tokenUuid } from './onchain/rabby-token-observation';
import { applyRpcQuantities } from './onchain/rpc-cache';
import { refreshOnchainBreakdown } from './onchain/debank';
import type { PortfolioState } from './types';
import { isWalletRefreshEnabled } from './wallets';
import {refreshMarketPrices} from './market-refresh';
import {readKonaPositions,applyKonaObservation,type KonaObservation} from './onchain/kona-rpc';
import {readFablesPositions,applyFablesObservation,type FablesObservation} from './onchain/fables-rpc';

const MONTHLY_CU_CAP=9_000_000;
/** 1inch campaign tokenized NVDA on Base. Rabby token lists sometimes miss it, so
 * every active EVM wallet gets a direct balanceOf read (quantity only; price from
 * an existing Rabby row). */
export const PINNED_RPC_TOKENS=[{uuid:'base:0xb20000000000000000000078ee7ce2fe4908108c',decimals:8}];
function pinnedTemplate(state: PortfolioState, uuid: string){
  const [chain,id]=uuid.split(':');
  for(const entry of Object.values(state.tokenCache??{})){
    const hit=entry?.tokens?.find(t=>t.chain===chain&&tokenUuid(t)===uuid&&t.amount>0&&t.valueUsd>0)
      ?? entry?.rpcTokenMetadata?.[uuid];
    if(hit)return {...hit,chain,tokenId:hit.tokenId||id};
  }
  return undefined;
}
export function rpcPlan(state: PortfolioState) {
  const groups=new Map<string,RpcTarget[]>();
  for(const wallet of state.wallets){
    if(!isWalletRefreshEnabled(wallet))continue;
    const address=wallet.address.toLowerCase(),cache=state.tokenCache?.[address];
    const ids=new Set([...(cache?.tokens??[]).map(tokenUuid).filter((s):s is string=>!!s),...Object.keys(cache?.inventory??{})]);
    if(wallet.chain==='EVM')for(const pin of PINNED_RPC_TOKENS)if(!ids.has(pin.uuid)){
      ids.add(pin.uuid);
    }
    for(const uuid of ids){
      const chain=uuid.split(':')[0];
      const group=groups.get(chain)??[];
      group.push({address,uuid,decimals:cache?.inventory?.[uuid]?.decimals??PINNED_RPC_TOKENS.find(p=>p.uuid===uuid)?.decimals});groups.set(chain,group);
    }
  }
  return groups;
}

export async function refreshRpcQuantities() {
  const start=Date.now(),month=new Date(start).toISOString().slice(0,7),at=new Date(start).toISOString();
  // Reserve the chain queue and quota before network calls; another scheduler
  // sees the reservation and cannot spend the same slot twice.
  const reserved=await mutateStore(async state=>{
    const audit=state.rpcAudit??{usage:{month,reservedCu:0},chains:{},quantities:{}};
    if(audit.usage.month!==month)audit.usage={month,reservedCu:0};
    if(Date.parse(audit.cooldownUntil??'')>start)return {targets:[] as Array<[string,RpcTarget[]]>,konaWallets:[] as string[],fablesWallets:[] as string[]};
    const plan=[...rpcPlan(state)].filter(([chain])=>start-(Date.parse(audit.chains[chain]?.lastAttemptAt??'')||0)>=4*60_000)
      .sort(([a],[b])=>(Date.parse(audit.chains[a]?.lastAttemptAt??'')||0)-(Date.parse(audit.chains[b]?.lastAttemptAt??'')||0)).slice(0,6);
    const targets:Array<[string,RpcTarget[]]>=[];
    for(const [chain,rows] of plan){
      const cost=RPC_NETWORKS[chain]?.net?Math.ceil(rows.length/60)*26+(chain==='abs'?(Math.ceil(state.wallets.length*8/50)+2)*26:0):0;
      if(audit.usage.reservedCu+cost>MONTHLY_CU_CAP)continue;
      audit.usage.reservedCu+=cost;
      audit.chains[chain]={...audit.chains[chain],lastAttemptAt:at};targets.push([chain,rows]);
    }
    // Public Fables discovery is paced across cloud ticks, not 25 concurrent
    // requests. Three oldest addresses per minute cover all 25 in nine ticks.
    const fablesWallets=audit.usage.reservedCu+100<=MONTHLY_CU_CAP?state.wallets.filter(isWalletRefreshEnabled)
      .map(w=>w.address.toLowerCase()).filter(a=>start-(Date.parse(audit.fablesWallets?.[a]?.lastAttemptAt??'')||0)>=4*60_000)
      .sort((a,b)=>(Date.parse(audit.fablesWallets?.[a]?.lastAttemptAt??'')||0)-(Date.parse(audit.fablesWallets?.[b]?.lastAttemptAt??'')||0)||
        Number(state.protocolCache?.[b]?.protocols.some(p=>p.id==='hood_fables')??false)-Number(state.protocolCache?.[a]?.protocols.some(p=>p.id==='hood_fables')??false))
      .slice(0,3):[];
    if(fablesWallets.length){audit.usage.reservedCu+=100;audit.fablesWallets={...audit.fablesWallets};for(const address of fablesWallets)audit.fablesWallets[address]={...audit.fablesWallets[address],lastAttemptAt:at};}
    state.rpcAudit=audit;
    return {targets,konaWallets:targets.some(([chain])=>chain==='abs')?state.wallets.filter(isWalletRefreshEnabled).map(w=>w.address.toLowerCase()):[],fablesWallets};
  });
  const queue=[...reserved.result.targets],results:RpcChainResult[]=[];
  let kona:KonaObservation|undefined,konaError:string|undefined;
  let fables:FablesObservation|undefined,fablesError:string|undefined;
  let rateLimited=false;
  async function worker(){
    while(queue.length && !rateLimited && Date.now()-start<40_000){
      const [chain,rows]=queue.shift()!;
      const result=await readRpcChain(chain,rows,{apiKey:process.env.ALCHEMY_API_KEY,timeoutMs:Math.min(10_000,45_000-(Date.now()-start))});
      results.push(result);
      if(result.error==='http_429')rateLimited=true;
    }
  }
  const [market]=await Promise.all([
    refreshMarketPrices().catch(()=>({ran:'failed'})), worker(), worker(),
    ...(reserved.result.konaWallets.length?[readKonaPositions(reserved.result.konaWallets,{apiKey:process.env.ALCHEMY_API_KEY}).then(value=>{kona=value;}).catch(error=>{konaError=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'kona_read_failed';if(konaError==='http_429')rateLimited=true;})]:[]),
    ...(reserved.result.fablesWallets.length?[readFablesPositions(reserved.result.fablesWallets,{apiKey:process.env.ALCHEMY_API_KEY}).then(value=>{fables=value;}).catch(error=>{fablesError=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'fables_read_failed';if(fablesError==='http_429')rateLimited=true;})]:[]),
  ]);
  const mutation=await mutateStore(async state=>{
    const audit=state.rpcAudit!;
    if(rateLimited)audit.cooldownUntil=new Date(Date.now()+10*60_000).toISOString();
    const cache={...state.tokenCache};
    for(const result of results){
      const grouped=new Map<string,typeof result.quantities>();
      for(const row of result.quantities){
        const key=`${row.address}:${row.uuid}`,existing=audit.quantities[key];
        if(Date.parse(existing?.at??'')>=Date.parse(row.observedAt))continue;
        audit.quantities[key]={at:row.observedAt,error:row.error,amountExact:row.amountExact,decimals:row.decimals,block:row.blockNumber};
        const items=grouped.get(row.address)??[];items.push(row);grouped.set(row.address,items);
      }
      for(const [address,rows] of grouped){
        let entry=cache[address];
        for(const pin of PINNED_RPC_TOKENS){
          const row=rows.find(r=>r.uuid===pin.uuid);
          if(!row||row.error||!(Number(row.amountExact)>0))continue;
          const has=entry?.tokens?.some(t=>tokenUuid(t)===pin.uuid)||entry?.rpcTokenMetadata?.[pin.uuid];
          if(has)continue;
          const template=pinnedTemplate(state,pin.uuid);
          if(!template)continue;
          entry=entry??{at:row.observedAt,tokens:[],unpricedCount:0,unpricedByChain:{},coveredChains:[]} as typeof entry;
          entry={...entry!,rpcTokenMetadata:{...entry!.rpcTokenMetadata,[pin.uuid]:{...template,updatedAt:'1970-01-01T00:00:00.000Z',priceUpdatedAt:template.priceUpdatedAt??template.updatedAt}}};
        }
        if(entry)cache[address]=applyRpcQuantities(entry,rows);
      }
      const successful=result.quantities.filter(r=>!r.error).length;
      audit.chains[result.chain]={...audit.chains[result.chain],successful,failed:result.quantities.length-successful,error:result.error,
        ...(successful===result.quantities.length?{lastSuccessAt:result.observedAt}:{})};
    }
    state.tokenCache=cache;state.rpcAudit=audit;
    if(kona){
      const protocols={...state.protocolCache};
      for(const [address,protocol] of Object.entries(kona.wallets))protocols[address]=applyKonaObservation(protocols[address],protocol,kona.at,kona.block);
      state.protocolCache=protocols;
      audit.protocols={...audit.protocols,kona:{at:kona.at,block:kona.block,wallets:Object.keys(kona.wallets).length}};
    }else if(konaError)audit.protocols={...audit.protocols,kona:{...audit.protocols?.kona,error:konaError}};
    if(fables){
      const protocols={...state.protocolCache};
      for(const [address,protocol] of Object.entries(fables.wallets)){
        protocols[address]=applyFablesObservation(protocols[address],protocol,fables.at,fables.block);
        audit.fablesWallets![address]={...audit.fablesWallets![address],at:fables.at,block:fables.block,error:undefined};
      }
      state.protocolCache=protocols;
      // Only refund a completed bounded request's unused reservation; errors
      // keep the full reservation rather than under-count a possibly spent call.
      if(audit.usage.month===month)audit.usage.reservedCu-=Math.max(0,100-fables.estimatedCu);
      audit.protocols={...audit.protocols,fables:{at:fables.at,block:fables.block,wallets:Object.keys(audit.fablesWallets??{}).filter(a=>Date.now()-Date.parse(audit.fablesWallets![a].at??'')<=20*60_000).length}};
    }else if(fablesError){
      for(const address of reserved.result.fablesWallets)audit.fablesWallets![address]={...audit.fablesWallets![address],error:fablesError};
      audit.protocols={...audit.protocols,fables:{...audit.protocols?.fables,error:fablesError}};
    }
    if(results.length||kona||fables)state.onchainBreakdown=await refreshOnchainBreakdown(state.wallets,state.chainCache??{},cache,state.protocolCache??{},state.zerionDefi??{});
    return {chains:results.map(r=>({chain:r.chain,successful:r.quantities.filter(q=>!q.error).length,failed:r.quantities.filter(q=>q.error).length,error:r.error})),protocols:audit.protocols??{},reservedCu:audit.usage.reservedCu,monthlyCap:MONTHLY_CU_CAP};
  });
  return {ok:true,ran:'rpc-quantities',market,...mutation.result};
}
