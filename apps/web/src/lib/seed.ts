import type { ManualAsset, Wallet } from "./types";

/** Demo baseline only — not real portfolio figures. */
export const BASELINE = {
  totalUsd: 10000,
  onchainUsd: 4000,
  cexUsd: 5000,
  manualUsd: 1000,
  okx: 1000,
  binance: 2000,
  gate: 2000,
  bitget: 0,
  evmUsd: 3000,
  abstractUsd: 1000,
} as const;

export const SEED_MANUAL: ManualAsset[] = [
  { id: "m1", name: "Demo OKX account A", amountUsd: 500, updatedAt: new Date().toISOString() },
  { id: "m2", name: "Demo OKX account B", amountUsd: 500, updatedAt: new Date().toISOString() },
];

/** Placeholder addresses for empty-store demos. Replace with your own wallets in the UI. */
const EVM: Array<[string, string, number]> = [
  ["Demo wallet 1", "0x1111111111111111111111111111111111111111", 2000],
  ["Demo wallet 2", "0x2222222222222222222222222222222222222222", 1000],
];

const ABSTRACT: Array<[string, string, number]> = [
  ["Demo Abstract 1", "0x3333333333333333333333333333333333333333", 600],
  ["Demo Abstract 2", "0x4444444444444444444444444444444444444444", 400],
];

export function seedWallets(): Wallet[] {
  const now = new Date().toISOString();
  const evm = EVM.map(([name, address, balanceUsd], i) => ({
    id: `e${i + 1}`,
    name,
    address,
    chain: "EVM" as const,
    balanceUsd,
    lastUpdated: now,
    status: "baseline" as const,
  }));
  const abs = ABSTRACT.map(([name, address, balanceUsd], i) => ({
    id: `a${i + 1}`,
    name,
    address,
    chain: "ABSTRACT" as const,
    balanceUsd,
    lastUpdated: now,
    status: "baseline" as const,
  }));
  return [...evm, ...abs];
}

/**
 * Optional one-shot migrations when bootstrapping an empty store.
 * Keep empty in the public tree — add wallets via the UI or your private env.
 */
export const MIGRATION_WALLETS: Array<{ name: string; address: string; chain: "EVM" | "ABSTRACT" }> = [];
