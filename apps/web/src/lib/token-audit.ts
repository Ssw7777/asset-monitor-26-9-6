import type { PortfolioState, TokenAuditSummary } from "./types";
import {canonicalTokenId} from './onchain/token-identity.ts';
import { isWalletRefreshEnabled } from "./wallets";

export const TOKEN_FRESHNESS_MS = 10 * 60_000;

/** Audit every stored token, not just USDG/ETH or the currently visible rows. */
export function requiredTokenChains(state: Pick<PortfolioState, "tokenCache" | "chainCache">, address: string): string[] {
  const key = address.toLowerCase();
  return [...new Set([
    ...(state.chainCache?.[key]?.chains ?? []).filter(chain => chain.valueUsd > 0 && !chain.id.startsWith("app:")).map(chain => chain.id),
    ...(state.tokenCache?.[key]?.tokens ?? []).map(token => token.chain),
  ])];
}

export function auditTokens(state: Pick<PortfolioState, "wallets" | "tokenCache" | "onchainBreakdown" | "chainCache" | "rpcAudit">, now = Date.now()): TokenAuditSummary {
  let invalidRows = 0;
  let duplicateRows = 0;
  let aggregateMismatches = 0;
  let oldestMs = Infinity;
  const expected = new Map<string, { amount: number; value: number }>();
  // Token freshness UI only covers wallets still being refreshed.
  const sourceWallets = state.wallets.filter(isWalletRefreshEnabled);
  const wallets = sourceWallets.map(wallet => {
    const cache = state.tokenCache?.[wallet.address.toLowerCase()];
    const chains = requiredTokenChains(state, wallet.address);
    const chainTimes = chains.map(chain => {
      const holdings = (cache?.tokens ?? []).filter(token => token.chain === chain);
      if (holdings.length) return Math.min(...holdings.map(token => Date.parse(token.updatedAt ?? cache?.chainUpdatedAt?.[chain] ?? cache?.at ?? "")));
      return Date.parse(cache?.chainUpdatedAt?.[chain] ?? (cache?.coveredChains.includes("*") || cache?.coveredChains.includes(chain) ? cache.at : ""));
    });
    const at = chainTimes.length ? Math.min(...chainTimes) : Date.parse(cache?.at ?? "");
    const validAt = Number.isFinite(at) && at <= now + 60_000;
    if (validAt) oldestMs = Math.min(oldestMs, at);
    const rows = cache?.tokens ?? [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.chain || !row.tokenId || !row.symbol || !Number.isFinite(row.amount) || row.amount < 0 || !Number.isFinite(row.valueUsd) || row.valueUsd < 0) {
        invalidRows++;
        continue;
      }
      const identity = `${row.chain}:${row.tokenId.toLowerCase()}`;
      if (seen.has(identity)) duplicateRows++;
      seen.add(identity);
      const rawId = row.contractAddress?.trim() || row.assetId?.trim() || row.tokenId.trim();
      const id = /^0x[0-9a-f]+$/i.test(rawId) ? rawId.toLowerCase() : rawId;
      const key = `${wallet.id}:${row.chain}:${id}`;
      const sum = expected.get(key) ?? { amount: 0, value: 0 };
      sum.amount += row.amount;
      sum.value += row.valueUsd;
      expected.set(key, sum);
    }
    const hasError = !!cache?.lastError || chains.some(chain => !!cache?.chainErrors?.[chain]) || Object.keys(cache?.tokenErrors ?? {}).length > 0;
    const status = hasError ? "error" : !cache || !validAt ? "missing" :
      now - at > TOKEN_FRESHNESS_MS ? "stale" : "fresh";
    return { walletId: wallet.id, updatedAt: validAt ? new Date(at).toISOString() : null, source: cache?.source ?? "legacy", status, tokenCount: rows.length } as const;
  });
  const actual = new Map<string, { amount: number; value: number }>();
  for (const token of state.onchainBreakdown?.tokens ?? []) {
    for (const wallet of token.wallets) {
      const key = `${wallet.walletId}:${token.id}`;
      const sum = actual.get(key) ?? { amount: 0, value: 0 };
      sum.amount += wallet.amount;
      sum.value += wallet.valueUsd;
      actual.set(key, sum);
    }
  }
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    const before = expected.get(key) ?? { amount: 0, value: 0 };
    const after = actual.get(key) ?? { amount: 0, value: 0 };
    // Floating point summation tolerance, never a fixed two-decimal token tolerance.
    if (Math.abs(before.amount - after.amount) > Math.max(1e-12, Math.abs(before.amount) * 1e-12) || Math.abs(before.value - after.value) > .02) aggregateMismatches++;
  }
  const count = (status: string) => wallets.filter(wallet => wallet.status === status).length;
  const freshWallets = count("fresh");
  const rpcKeys = new Set<string>();
  for (const wallet of sourceWallets) {
    const address=wallet.address.toLowerCase(),cache=state.tokenCache?.[address];
    for(const uuid of Object.keys(cache?.inventory??{}))rpcKeys.add(`${address}:${uuid}`);
    for(const token of cache?.tokens??[]){
      const id=canonicalTokenId(token);
      if(/^0x[a-f0-9]{40}$/.test(id)||id===token.chain)rpcKeys.add(`${address}:${token.chain}:${id}`);
    }
  }
  const rpcRows=[...rpcKeys].map(key=>state.rpcAudit?.quantities[key]);
  const rpcTimes=rpcRows.filter(r=>r&&!r.error).map(r=>Date.parse(r!.at)).filter(Number.isFinite);
  return {
    rpc:state.rpcAudit?{total:rpcKeys.size,fresh:rpcRows.filter(r=>r&&!r.error&&now-Date.parse(r.at)<=TOKEN_FRESHNESS_MS&&Date.parse(r.at)<=now+60_000).length,failed:rpcRows.filter(r=>r?.error).length,oldestAt:rpcTimes.length?new Date(Math.min(...rpcTimes)).toISOString():null}:undefined,
    checkedAt: new Date(now).toISOString(), walletCount: wallets.length, freshWallets,
    staleWallets: count("stale"), missingWallets: count("missing"), failedWallets: count("error"),
    invalidRows, duplicateRows, aggregateMismatches,
    oldestUpdatedAt: Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString() : null,
    healthy: wallets.length > 0 && freshWallets === wallets.length && invalidRows === 0 && duplicateRows === 0 && aggregateMismatches === 0,
    wallets,
  };
}
