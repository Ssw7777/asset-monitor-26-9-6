import type { WalletTokenCacheEntry } from '../types';
import type { RpcQuantity } from './rpc-balances';
import {canonicalTokenId} from './token-identity.ts';

/** Update known quantities only. Never relabel full wallet/protocol totals fresh. */
export function applyRpcQuantities(previous: WalletTokenCacheEntry, quantities: RpcQuantity[]): WalletTokenCacheEntry {
  const tokens=previous.tokens.map(t=>({...t})),inventory={...previous.inventory};
  const rpcTokenMetadata={...previous.rpcTokenMetadata};
  const tokenErrors={...previous.tokenErrors},tokenAttemptAt={...previous.tokenAttemptAt};
  let lastAttemptAt=previous.lastAttemptAt;
  const duplicates=new Set<(typeof tokens)[number]>();
  for(const row of quantities){
    const at=Date.parse(row.observedAt), prior=Date.parse(inventory[row.uuid]?.updatedAt??'')||0;
    const [chain,id]=row.uuid.split(':');
    const matches=tokens.filter(t=>t.chain===chain && canonicalTokenId(t)===id);
    const latest=Math.max(prior,...matches.map(t=>Date.parse(t.updatedAt??previous.chainUpdatedAt?.[chain]??previous.at)||0));
    if(!Number.isFinite(at)||at<=latest)continue;
    if(at>(Date.parse(lastAttemptAt??'')||0))lastAttemptAt=row.observedAt;
    tokenAttemptAt[row.uuid]=row.observedAt;
    if(row.error || row.amountExact===undefined || !Number.isFinite(Number(row.amountExact)) || Number(row.amountExact)<0){
      tokenErrors[row.uuid]=row.error??'invalid_rpc_quantity';continue;
    }
    const amount=Number(row.amountExact);
    if(!matches.length && amount>0 && rpcTokenMetadata[row.uuid]){
      const restored={...rpcTokenMetadata[row.uuid]};tokens.push(restored);matches.push(restored);
    }
    inventory[row.uuid]={amount,amountExact:row.amountExact,updatedAt:row.observedAt,decimals:row.decimals};
    delete tokenErrors[row.uuid];
    // One wallet+chain+contract is one balance. Keep the latest price metadata
    // if old providers left equivalent aliases, never add their quantities.
    matches.sort((a,b)=>(Date.parse(b.priceUpdatedAt??b.updatedAt??previous.at)||0)-(Date.parse(a.priceUpdatedAt??a.updatedAt??previous.at)||0));
    for(const duplicate of matches.slice(1))duplicates.add(duplicate);
    for(const token of matches.slice(0,1)){
      const price=token.amount>0?token.valueUsd/token.amount:token.valuationPrice??0;
      token.valuationPrice=price;
      token.priceUpdatedAt??=token.updatedAt??previous.chainUpdatedAt?.[chain]??previous.at;
      token.amount=amount;token.amountExact=row.amountExact;token.updatedAt=row.observedAt;
      token.quantitySource='rpc';token.quantityBlock=row.blockNumber;
      if(id===chain){token.tokenId=chain;token.assetId=undefined;token.kind='native';}
      token.valueUsd=Number.isFinite(price)?amount*price:0;
      rpcTokenMetadata[row.uuid]={...token};
    }
  }
  // Preserve metadata for zero holdings so future deposits can be displayed again.
  return {...previous,tokens:tokens.filter(token=>!duplicates.has(token)),inventory,rpcTokenMetadata,tokenErrors,tokenAttemptAt,lastAttemptAt};
}
