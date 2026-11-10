import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { computeTotals, readStore } from "@/lib/store";
import type { OnchainBreakdown, PortfolioState, Wallet } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<Wallet["status"], string> = {
  ok: "live",
  cached: "cached",
  stale: "cached",
  error: "error",
  baseline: "baseline",
};

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows: unknown[][]): string {
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function topChainForWallet(breakdown: OnchainBreakdown | null | undefined, address: string) {
  if (!breakdown) return "";
  const target = address.toLowerCase();
  let best: { name: string; valueUsd: number } | null = null;
  for (const chain of breakdown.chains) {
    const share = chain.wallets.find((wallet) => wallet.address.toLowerCase() === target);
    if (share && (!best || share.valueUsd > best.valueUsd)) {
      best = { name: chain.name, valueUsd: share.valueUsd };
    }
  }
  return best ? `${best.name} (${best.valueUsd.toFixed(2)})` : "";
}

function topDappsForWallet(breakdown: OnchainBreakdown | null | undefined, address: string) {
  if (!breakdown) return "";
  const target = address.toLowerCase();
  const hits: Array<{ name: string; netUsd: number }> = [];
  for (const dapp of breakdown.dapps) {
    const share = dapp.wallets.find((wallet) => wallet.address.toLowerCase() === target);
    if (share && Math.abs(share.netUsd) >= 0.01) hits.push({ name: dapp.name, netUsd: share.netUsd });
  }
  return hits
    .sort((left, right) => Math.abs(right.netUsd) - Math.abs(left.netUsd))
    .slice(0, 3)
    .map((hit) => `${hit.name} (${hit.netUsd.toFixed(2)})`)
    .join(" / ");
}

function walletsCsv(state: PortfolioState): string {
  const totals = computeTotals(state);
  const rows: unknown[][] = [
    ["Asset Monitor Export于", new Date().toISOString()],
    ["总资产 USD", totals.totalUsd],
    ["链上 USD", totals.onchainUsd],
    ["交易所 USD", totals.cexUsd],
    ["手动资产 USD", totals.manualUsd],
    [],
    ["钱包名称", "地址", "类型", "当前余额 USD", "最近成功刷新", "数据状态", "Top 链", "Top DApp（仅解释组成）"],
  ];
  const sorted = [...state.wallets].sort((left, right) => right.balanceUsd - left.balanceUsd);
  for (const wallet of sorted) {
    rows.push([
      wallet.name,
      wallet.address,
      wallet.chain,
      wallet.balanceUsd.toFixed(2),
      wallet.lastSuccess?.at || wallet.lastUpdated || "",
      STATUS_LABEL[wallet.status] || wallet.status,
      topChainForWallet(state.onchainBreakdown, wallet.address),
      topDappsForWallet(state.onchainBreakdown, wallet.address),
    ]);
  }
  return toCsv(rows);
}

function dappsCsv(state: PortfolioState): string {
  const rows: unknown[][] = [
    ["协议", "链", "钱包", "地址", "资产 USD", "负债 USD", "净值 USD", "主要代币"],
  ];
  const breakdown = state.onchainBreakdown;
  if (!breakdown) return toCsv(rows);
  for (const dapp of breakdown.dapps) {
    for (const chain of dapp.chains) {
      for (const share of chain.wallets) {
        rows.push([
          dapp.name,
          chain.name,
          share.walletName,
          share.address,
          share.assetUsd.toFixed(2),
          share.debtUsd.toFixed(2),
          share.netUsd.toFixed(2),
          share.tokens
            .slice(0, 6)
            .map((token) => `${token.role === "debt" ? "-" : ""}${token.symbol} ${token.valueUsd.toFixed(2)}`)
            .join(" / "),
        ]);
      }
    }
  }
  return toCsv(rows);
}

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const type = new URL(req.url).searchParams.get("type") === "dapps" ? "dapps" : "wallets";
  const state = await readStore();
  const csv = type === "dapps" ? dappsCsv(state) : walletsCsv(state);
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="asset-monitor-${type}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
