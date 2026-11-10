import type { ChainType, Wallet } from "./types";

export const WALLET_LIMIT = 50;
const ABSTRACT_SUFFIX = "（Abstract）";

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function ensureAbstractName(name: string, chain: ChainType): string {
  const n = name.trim() || "未命名";
  if (chain !== "ABSTRACT") {
    return n.endsWith(ABSTRACT_SUFFIX) ? n.slice(0, -ABSTRACT_SUFFIX.length).trim() || n : n;
  }
  if (n.includes("（Abstract）") || n.includes("(Abstract)")) return n;
  return `${n}${ABSTRACT_SUFFIX}`;
}

export function isValidEthAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address.trim());
}

export function findDupeIndex(wallets: Wallet[], address: string, excludeId?: string): number {
  const addr = normalizeAddress(address);
  return wallets.findIndex(
    (w) => normalizeAddress(w.address) === addr && (!excludeId || w.id !== excludeId)
  );
}

export function parseBatchAddresses(text: string): string[] {
  const lines = text
    .split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/(0x[a-fA-F0-9]{40})/i);
    if (!m) continue;
    const addr = normalizeAddress(m[1]);
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(m[1]);
  }
  return out;
}

export function makeWallet(partial: {
  id?: string;
  name: string;
  address: string;
  chain: ChainType;
  balanceUsd?: number;
}): Wallet {
  const chain = partial.chain;
  return {
    id: partial.id || `w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: ensureAbstractName(partial.name, chain),
    address: partial.address.trim(),
    chain,
    balanceUsd: Math.round((partial.balanceUsd || 0) * 100) / 100,
    lastUpdated: null,
    status: "baseline",
  };
}

/** Optional hard-coded pause list. Prefer wallet.refreshPaused in the store. */
export const PAUSED_ABSTRACT_ADDRESSES = new Set<string>();

export function isWalletRefreshEnabled(wallet: Pick<Wallet, "address" | "refreshPaused">): boolean {
  if (wallet.refreshPaused === true) return false;
  return !PAUSED_ABSTRACT_ADDRESSES.has(normalizeAddress(wallet.address));
}

/** Optional one-shot dust rescans for paused wallets (address → USD). */
export const PAUSED_ABSTRACT_RESCANNED_USD: Record<string, number> = {};

export function activeRefreshWallets<T extends Pick<Wallet, "address" | "refreshPaused">>(wallets: T[]): T[] {
  return wallets.filter(isWalletRefreshEnabled);
}
