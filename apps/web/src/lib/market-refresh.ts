import {mutateLiveStore as mutateStore} from './store';
import {COINSTATS_PRICE_IDS,parseCoinStatsPrices,applyMarketPrices} from './onchain/coinstats-prices';
import {refreshOnchainBreakdown} from './onchain/debank';

const CREDIT_COST=2,MONTHLY_CAP=18000;
export async function refreshMarketPrices(){
  const key=process.env.COINSTATS_API_KEY;
  if(!key)return {ran:'disabled'};
  const now=Date.now(),month=new Date(now).toISOString().slice(0,7),at=new Date(now).toISOString();
  const reserved=await mutateStore(state=>{
    const current=state.marketAudit??{month,reservedCredits:0};
    if(current.month!==month){current.month=month;current.reservedCredits=0;}
    state.marketAudit=current;
    if(Date.parse(current.cooldownUntil??'')>now||now-(Date.parse(current.lastAttemptAt??'')||0)<5*60000)return false;
    if(current.reservedCredits+CREDIT_COST>MONTHLY_CAP){current.error='monthly_credit_cap';return false;}
    current.reservedCredits+=CREDIT_COST;current.lastAttemptAt=at;return true;
  });
  if(!reserved.result)return {ran:'not_due'};
  let error:string|undefined,quotes:ReturnType<typeof parseCoinStatsPrices>|undefined,remaining:number|undefined;
  async function request(path:string){
    const r=await fetch(`https://api.coinstats.app/v1${path}`,{headers:{'X-API-KEY':key!},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(6000)});
    if(!r.ok)throw new Error(`http_${r.status}`);
    return r.json();
  }
  try{
    const usage=await request('/usage/credits');
    remaining=usage.remainingCredits;
    if(usage.subscription!=='free'||!Number.isFinite(remaining)||Number(remaining)<CREDIT_COST)throw new Error('free_credits_unavailable');
    quotes=parseCoinStatsPrices(await request(`/coins?limit=100&coinIds=${COINSTATS_PRICE_IDS.join(',')}`),new Date().toISOString());
    remaining=Number(remaining)-CREDIT_COST;
  }catch(caught){error=caught instanceof Error&&/^[a-z0-9_]+$/.test(caught.message)?caught.message:'market_request_failed';}
  const saved=await mutateStore(async state=>{
    const audit=state.marketAudit!;
    if(audit.lastAttemptAt!==at)return {updated:0,ran:'superseded'};
    audit.remainingCredits=remaining;audit.error=error;
    if(error){if(error==='http_429')audit.cooldownUntil=new Date(Date.now()+10*60000).toISOString();return {updated:0,ran:'failed',error};}
    let updated=0;
    const cache={...state.tokenCache};
    for(const [address,entry] of Object.entries(cache)){
      const result=applyMarketPrices(entry,quotes!);cache[address]=result.cache;updated+=result.updated;
    }
    state.tokenCache=cache;audit.lastSuccessAt=new Date().toISOString();audit.updated=updated;
    state.onchainBreakdown=await refreshOnchainBreakdown(state.wallets,state.chainCache??{},cache,state.protocolCache??{},state.zerionDefi??{});
    return {updated,ran:'market-prices'};
  });
  return saved.result;
}
