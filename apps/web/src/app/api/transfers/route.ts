import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { mutateLiveStore, readStore } from "@/lib/store";
import {
  TRANSFER_RANGES,
  TRANSFER_RETENTION_MS,
  buildTransferSummary,
  mergeTransactionRecords,
  type TransferRangeKey,
} from "@/lib/transfers";
import { fetchAlchemyTransfersForWallet } from "@/lib/onchain/alchemy-transfers";
import { isWalletRefreshEnabled } from "@/lib/wallets";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const STALE_MS = 30 * 60 * 1000;
const BACKFILL_WALLET_CAP = 2;
const BACKFILL_CHAINS = ["eth", "base", "arb"];

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const params = new URL(req.url).searchParams;
  const requestedRange = params.get("range") || "7d";
  const range = (TRANSFER_RANGES.some((item) => item.key === requestedRange)
    ? requestedRange
    : "7d") as TransferRangeKey;
  const limitParam = Number(params.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(200, limitParam) : 80;
  const refresh = params.get("refresh") === "1";

  let state = await readStore();
  let summary = buildTransferSummary(state, { range, limit });
  const backfill: { wallets: string[]; calls: number; errors: string[] } = {
    wallets: [],
    calls: 0,
    errors: [],
  };

  // Lightweight Alchemy backfill when cache is thin or explicitly refreshed.
  const needsBackfill =
    !!process.env.ALCHEMY_API_KEY &&
    (refresh || summary.lines.length < 8 || summary.walletCoverage < Math.min(3, state.wallets.filter(isWalletRefreshEnabled).length));

  const activeWallets = state.wallets.filter(isWalletRefreshEnabled);
  if (needsBackfill && activeWallets.length) {
    const now = Date.now();
    const history = state.transactionHistory ?? {};
    const candidates = [...activeWallets]
      .map((wallet) => {
        const address = wallet.address.toLowerCase();
        const entry = history[address];
        const age = entry?.at ? now - Date.parse(entry.at) : Number.POSITIVE_INFINITY;
        const count = entry?.records?.length ?? 0;
        return { wallet, address, age, count };
      })
      .sort((a, b) => b.age - a.age || a.count - b.count)
      .filter((item) => item.age > STALE_MS || item.count === 0)
      .slice(0, BACKFILL_WALLET_CAP);

    for (const item of candidates) {
      const result = await fetchAlchemyTransfersForWallet(item.address, {
        chains: BACKFILL_CHAINS,
        maxCount: 20,
        lookbackMs: TRANSFER_RETENTION_MS,
        timeoutMs: 7_000,
      });
      backfill.calls += result.calls;
      backfill.wallets.push(item.wallet.name || item.address.slice(0, 10));
      if (result.error) backfill.errors.push(result.error);
      if (!result.records.length && result.error) continue;

      await mutateLiveStore((draft) => {
        const prev = draft.transactionHistory ?? {};
        const existing = prev[item.address];
        const records = mergeTransactionRecords(existing?.records, result.records);
        draft.transactionHistory = {
          ...prev,
          [item.address]: {
            at: new Date().toISOString(),
            source: existing?.source === "okx-web3" ? "okx-web3" : "alchemy",
            more: false,
            records,
          },
        };
      });
    }

    state = await readStore();
    summary = buildTransferSummary(state, { range, limit });
  }

  return NextResponse.json({ ...summary, backfill });
}
