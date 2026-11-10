import type { WalletTokenCacheEntry } from "../types";
import {canonicalTokenId} from './token-identity.ts';

const STABLE = new Set(["USDT", "USDC", "USDG", "USDE", "USD1", "USDT0", "USD0", "DAI", "FDUSD", "TUSD", "BUSD", "USDD", "PYUSD", "GHO", "USDS", "SUSDE", "SUSDS", "FRAX", "LUSD", "USDX", "USDP", "USDR", "USDF", "USDY", "SUSD", "CRVUSD"]);
type Detail = Pick<WalletTokenCacheEntry, "tokens" | "unpricedCount" | "unpricedByChain" | "coveredChains"> & { observed?: Record<string, number> };

/** Complete official Rabby token_list response. Error envelopes are never empty wallets. */
export function parseRabbyTokenObservation(payload: unknown, expectedChain: string): Detail | null {
  if (!Array.isArray(payload) || payload.length > 30_000) return null;
  const tokens: Detail["tokens"] = [];
  const unpricedByChain: Record<string, number> = {};
  const seen = new Map<string, { amount: number; value: number }>();
  const observed: Record<string, number> = {};
  for (const item of payload) {
    if (!item || typeof item !== "object") return null;
    const r = item as Record<string, unknown>;
    const chain = typeof r.chain === "string" ? r.chain.trim() : "";
    const id = typeof r.id === "string" ? r.id.trim().toLowerCase() : "";
    const symbol = String(r.optimized_symbol || r.display_symbol || r.symbol || "").trim();
    if (chain !== expectedChain) return null;
    if (!chain || !id || !symbol || (typeof r.amount !== "number" && typeof r.amount !== "string")) return null;
    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount < 0 || String(r.amount).trim() === "") return null;
    if ((r.is_core === true || r.is_verified === true) && r.is_scam !== true && r.is_suspicious !== true && !String(r.protocol_id || "").trim()) observed[`${chain}:${id}`] = amount;
    if (!amount || r.is_wallet === false || String(r.protocol_id || "").trim()) continue;
    const price = r.price == null ? 0 : Number(r.price);
    const valueUsd = r.usd_value != null ? Number(r.usd_value) : amount * price;
    if (!Number.isFinite(valueUsd) || valueUsd < 0) return null;
    if (valueUsd < .01 || r.is_scam === true || r.is_suspicious === true || (r.is_core !== true && r.is_verified !== true)) {
      unpricedByChain[chain] = (unpricedByChain[chain] || 0) + 1;
      continue;
    }
    const key = `${chain}:${id}`;
    const previous = seen.get(key);
    if (previous) {
      if (previous.amount !== amount || previous.value !== valueUsd) return null;
      continue;
    }
    seen.set(key, { amount, value: valueUsd });
    const stableSymbol = symbol.toUpperCase().replace(/\.E$/, "");
    tokens.push({ chain, symbol, tokenId: id, amount, amountExact: String(r.amount), valueUsd,
      contractAddress: /^0x[a-f0-9]{40}$/.test(id) ? id : undefined,
      kind: STABLE.has(stableSymbol) ? "stable" : !id.startsWith("0x") && r.is_core === true ? "native" : "spot",
      isCore: r.is_core === true,
      logoUrl: typeof r.logo_url === "string" ? r.logo_url : undefined });
  }
  return { tokens: tokens.sort((a, b) => b.valueUsd - a.valueUsd), unpricedByChain, observed,
    unpricedCount: Object.values(unpricedByChain).reduce((a, b) => a + b, 0), coveredChains: [expectedChain] };
}

/** Idempotent, timestamp-ordered replacement; a failure only updates attempt/error metadata. */
export function applyTokenObservation(previous: WalletTokenCacheEntry | undefined, detail: Detail | null, at: string, chain: string, error?: string): WalletTokenCacheEntry {
  const observed = Date.parse(at);
  const latest = Math.max(Date.parse(previous?.chainUpdatedAt?.[chain] ?? previous?.at ?? "") || 0, Date.parse(previous?.chainAttemptAt?.[chain] ?? "") || 0);
  if (previous && observed <= latest) return previous;
  const base = previous ?? { at: "", tokens: [], unpricedCount: 0, unpricedByChain: {}, coveredChains: [] };
  const chainUpdatedAt = { ...base.chainUpdatedAt };
  // Migrate old global cache timestamps to chain-specific timestamps before replacing one chain.
  for (const token of base.tokens) if (!chainUpdatedAt[token.chain]) chainUpdatedAt[token.chain] = base.at;
  const chainErrors = { ...base.chainErrors };
  const chainAttemptAt = { ...base.chainAttemptAt, [chain]: at };
  if (!detail) {
    chainErrors[chain] = error || "invalid_payload";
    return { ...base, lastAttemptAt: at, chainAttemptAt, chainUpdatedAt, chainErrors };
  }
  chainUpdatedAt[chain] = at;
  delete chainErrors[chain];
  const newer = base.tokens.filter(row => row.chain === chain && Date.parse(row.updatedAt ?? "") > observed);
  const newerIds = new Set(newer.map(row => row.tokenId.toLowerCase()));
  const tokens = [...base.tokens.filter(row => row.chain !== chain), ...newer, ...detail.tokens.filter(row => !newerIds.has(row.tokenId.toLowerCase())).map(row => ({ ...row, updatedAt: at }))].sort((a,b) => b.valueUsd - a.valueUsd);
  const inventory = { ...base.inventory };
  const tokenErrors = { ...base.tokenErrors };
  for (const uuid of new Set([...Object.keys(inventory).filter(id => id.startsWith(`${chain}:`)), ...Object.keys(detail.observed ?? {})])) {
    if (Date.parse(inventory[uuid]?.updatedAt ?? "") > observed) continue;
    inventory[uuid] = { amount: detail.observed?.[uuid] ?? 0, updatedAt: at };
    if (Date.parse(base.tokenAttemptAt?.[uuid] ?? "") <= observed || !base.tokenAttemptAt?.[uuid]) delete tokenErrors[uuid];
  }
  const unpricedByChain = { ...base.unpricedByChain, [chain]: detail.unpricedByChain[chain] ?? 0 };
  const times = Object.values(chainUpdatedAt).map(value => Date.parse(value) || 0);
  const oldest = Math.min(...times);
  return { ...base, tokens, unpricedByChain, unpricedCount: Object.values(unpricedByChain).reduce((a,b) => a+b, 0),
    at: oldest > 0 ? new Date(oldest).toISOString() : "", lastAttemptAt: at, lastError: undefined,
    chainUpdatedAt, chainAttemptAt, chainErrors, inventory, tokenErrors, source: "rabby-public",
    coveredChains: [...new Set([...base.coveredChains.filter(id => id !== "*"), ...Object.keys(chainUpdatedAt)])] };
}

export function tokenUuid(token: {chain: string; tokenId: string; contractAddress?: string;symbol?:string}): string | null {
  const id = canonicalTokenId(token);
  // Legacy Zerion position IDs are not Rabby token identifiers.
  return /^0x[a-f0-9]{40}$/i.test(id) || id === token.chain ? `${token.chain}:${id.toLowerCase()}` : null;
}

/** A specified-token batch is NOT full-chain coverage; absent rows remain errors, never zero. */
export function applySpecificTokenObservation(previous: WalletTokenCacheEntry | undefined, requested: string[], payload: unknown, at: string, error?: string): WalletTokenCacheEntry {
  const base = previous ?? { at: "", tokens: [], unpricedCount: 0, unpricedByChain: {}, coveredChains: [] };
  const tokens = [...base.tokens];
  const inventory = { ...base.inventory };
  const tokenErrors = { ...base.tokenErrors };
  const tokenAttemptAt = { ...base.tokenAttemptAt };
  const rows = Array.isArray(payload) ? payload as Record<string, unknown>[] : [];
  for (const uuid of requested) {
    const [chain, id] = uuid.split(":");
    const existing = tokens.filter(token => tokenUuid(token) === uuid);
    const latest = Math.max(Date.parse(tokenAttemptAt[uuid] ?? "") || 0, Date.parse(inventory[uuid]?.updatedAt ?? "") || 0, ...existing.map(token => Date.parse(token.updatedAt ?? base.chainUpdatedAt?.[chain] ?? base.at) || 0));
    if (Date.parse(at) <= latest) continue;
    tokenAttemptAt[uuid] = at;
    const matches = rows.filter(row => row && row.chain === chain && String(row.id).toLowerCase() === id);
    const parsed = matches.length ? parseRabbyTokenObservation(matches, chain) : null;
    if (!parsed) { tokenErrors[uuid] = error || (matches.length ? "invalid_payload" : "missing_token"); continue; }
    const amount = Number(matches[0].amount);
    inventory[uuid] = { amount, updatedAt: at };
    delete tokenErrors[uuid];
    for (let i = tokens.length - 1; i >= 0; i--) if (tokenUuid(tokens[i]) === uuid) tokens.splice(i, 1);
    tokens.push(...parsed.tokens.map(token => ({ ...token, updatedAt: at })));
  }
  return { ...base, tokens: tokens.sort((a,b) => b.valueUsd-a.valueUsd), inventory, tokenErrors, tokenAttemptAt, lastAttemptAt: at };
}
