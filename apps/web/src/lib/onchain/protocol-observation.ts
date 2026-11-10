import type { WalletProtocolCacheEntry } from '../types';

/** Whole-wallet provider observations cannot roll back newer RPC-owned positions. */
export function preserveRpcProtocols(current:WalletProtocolCacheEntry|undefined,incoming:WalletProtocolCacheEntry,now=Date.now()):WalletProtocolCacheEntry {
  let protocols=incoming.protocols;
  const ownership={...incoming.protocolRpcOwnership},updated={...incoming.protocolUpdatedAt};
  for(const [id,known] of Object.entries(current?.protocolRpcOwnership??{})){
    if(now-Date.parse(known.at)>20*60_000)continue;
    const candidate=ownership[id];
    if(candidate&&BigInt(candidate.block)>BigInt(known.block))continue;
    protocols=[...protocols.filter(p=>String(p.id)!==id),...(current?.protocols??[]).filter(p=>String(p.id)===id)];
    ownership[id]=known;updated[id]=known.at;
  }
  return {...incoming,protocols,protocolRpcOwnership:ownership,protocolUpdatedAt:updated};
}

export function applyProtocolObservation(previous:WalletProtocolCacheEntry|undefined, raw:unknown, observedAt:string, now=Date.now()):WalletProtocolCacheEntry {
  const at=Date.parse(observedAt);
  if(!Number.isFinite(at)||at>now+60_000||now-at>10*60_000)throw new Error('invalid_observation_time');
  let list:unknown=raw;
  if(raw && typeof raw==='object' && !Array.isArray(raw)){
    const value=raw as Record<string,unknown>;
    list=value.list??value.data;
    if(list && typeof list==='object' && !Array.isArray(list))list=(list as Record<string,unknown>).list;
  }
  if(!Array.isArray(list)||list.some(p=>!p||typeof p!=='object'||Array.isArray(p)||typeof p.id!=='string'||!Array.isArray(p.portfolio_item_list)))throw new Error('invalid_protocol_observation');
  if(previous && at<=(Date.parse(previous.at)||0))return previous;
  // A complete successful list REPLACES the previous one, including an empty
  // list after withdrawal. Never merge vanished positions back into this list.
  const owned=new Set(Object.entries(previous?.protocolRpcOwnership??{}).filter(([,v])=>now-Date.parse(v.at)<=20*60_000).map(([id])=>id));
  return {...previous,at:observedAt,lastAttemptAt:observedAt,lastError:undefined,
    protocols:[...list.filter(p=>!owned.has(p.id)),...(previous?.protocols??[]).filter(p=>owned.has(String(p.id)))]};
}
