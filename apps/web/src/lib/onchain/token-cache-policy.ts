import type { WalletTokenCacheEntry } from "../types";

export const TOKEN_SUCCESS_TTL_MS = 12 * 60 * 60 * 1000;
export const TOKEN_RETRY_TTL_MS = 15 * 60 * 1000;

/** Presentation thresholds must not erase a positive on-chain quantity. */
export function hasNonzeroHolding(holding: {amount:number;valueUsd:number}):boolean {
  return holding.amount>0 || holding.valueUsd>0;
}

/** Symbols are labels, never an identity: unrelated contracts can share one. */
export function tokenIdentity(token: { tokenId: string; contractAddress?: string; assetId?: string }): string {
  const id = token.contractAddress?.trim() || token.assetId?.trim() || token.tokenId.trim();
  return /^0x[0-9a-f]+$/i.test(id) ? id.toLowerCase() : id;
}

/** A failed attempt must not renew the successful-data TTL. */
export function tokenCacheNeedsRefresh(entry: WalletTokenCacheEntry | undefined, now = Date.now()): boolean {
  if (!entry) return true;
  const successAt = Date.parse(entry.at);
  const attemptAt = Date.parse(entry.lastAttemptAt ?? "");
  const validSuccess = Number.isFinite(successAt) && successAt <= now;
  const validAttempt = Number.isFinite(attemptAt) && attemptAt <= now;
  if (validAttempt && (!validSuccess || attemptAt > successAt)) {
    return now - attemptAt >= TOKEN_RETRY_TTL_MS;
  }
  return !validSuccess || now - successAt >= TOKEN_SUCCESS_TTL_MS;
}

/** Replace only chains that actually returned a successful token-list response. */
export function mergeTokenCacheObservation(
  previous: WalletTokenCacheEntry | null,
  detail: Pick<WalletTokenCacheEntry, "tokens" | "unpricedCount" | "unpricedByChain" | "coveredChains">,
  observedAt: string
): WalletTokenCacheEntry {
  // A truncated all-chain response has no authoritative chain coverage. It
  // cannot replace old rows or append potentially duplicated partial rows.
  if (!detail.coveredChains.length) {
    return previous
      ? { ...previous, lastAttemptAt: observedAt }
      : { at: "", lastAttemptAt: observedAt, tokens: [], unpricedCount: 0, unpricedByChain: {}, coveredChains: [] };
  }
  if (detail.coveredChains.includes("*") || !previous) {
    return { ...detail, at: observedAt, lastAttemptAt: observedAt };
  }
  const replaced = new Set(detail.coveredChains);
  const retainedTokens = previous.tokens.filter((token) => !replaced.has(token.chain));
  const retainedUnpriced = Object.fromEntries(
    Object.entries(previous.unpricedByChain).filter(([chain]) => !replaced.has(chain))
  );
  const unpricedByChain = { ...retainedUnpriced, ...detail.unpricedByChain };
  const retainedCoverage = previous.coveredChains.filter((chain) => !replaced.has(chain));
  // A single global success timestamp cannot truthfully advance if some chains
  // still contain older observations. Their cached balances remain visible.
  const retainsOlderData = retainedCoverage.length > 0 || retainedTokens.length > 0 || Object.keys(retainedUnpriced).length > 0;
  return {
    ...previous,
    at: retainsOlderData ? previous.at : observedAt,
    lastAttemptAt: observedAt,
    tokens: [...retainedTokens, ...detail.tokens].sort((a, b) => b.valueUsd - a.valueUsd),
    unpricedByChain,
    unpricedCount: Object.values(unpricedByChain).reduce((sum, count) => sum + count, 0),
    coveredChains: previous.coveredChains.includes("*")
      ? ["*"]
      : [...new Set([...previous.coveredChains, ...detail.coveredChains])],
  };
}
