/**
 * 浏览器内存级看板缓存：同标签页内跨路由切换可瞬间回填，避免重复拉全量。
 * 不落盘、不含密钥；刷新 / 关标签即清空。鉴权仍走 cookie + API requireAuth。
 */
import type { ChangeRangeKey, ChangeSummary } from "@/lib/changes";
import type { FlowRangeKey, FlowSummary } from "@/lib/flows";
import type { TransferRangeKey, TransferSummary } from "@/lib/transfers";
import type { ProtocolPerformanceSummary } from "@/lib/protocols";
import type {
  ExchangeBalance,
  ManualAsset,
  OnchainBreakdown,
  SnapshotPoint,
  Wallet,
} from "@/lib/types";

export interface PortfolioPayload {
  manual: ManualAsset[];
  wallets: Wallet[];
  exchanges: ExchangeBalance[];
  snapshots: SnapshotPoint[];
  lastRefresh: string | null;
  usdCnyRate: number;
  totals: {
    manualUsd: number;
    onchainUsd: number;
    cexUsd: number;
    evmUsd: number;
    abstractUsd: number;
    totalUsd: number;
  };
  onchainBreakdown?: OnchainBreakdown | null;
  snapshotCount?: number;
  snapshotLimit?: number;
  refreshStatus?: "ok" | "partial" | "failed";
}

type Box<T> = { data: T; at: number };

let portfolioBox: Box<PortfolioPayload> | null = null;
let changesBox: Box<{ range: ChangeRangeKey; summary: ChangeSummary; perf: ProtocolPerformanceSummary | null }> | null =
  null;
let flowsBox: Box<{ range: FlowRangeKey; min: number; summary: FlowSummary }> | null = null;
let transfersBox: Box<{ range: TransferRangeKey; summary: TransferSummary }> | null = null;

export function getCachedPortfolio(): PortfolioPayload | null {
  return portfolioBox?.data ?? null;
}

export function setCachedPortfolio(data: PortfolioPayload) {
  portfolioBox = { data, at: Date.now() };
}

export function portfolioCacheAgeMs(): number | null {
  return portfolioBox ? Date.now() - portfolioBox.at : null;
}

/** 缓存仍新鲜时跳过挂载期 quietRefresh，避免顶栏切换误触发 POST。 */
export function isPortfolioFresh(ttlMs = 30_000): boolean {
  return portfolioBox != null && Date.now() - portfolioBox.at < ttlMs;
}

export function getCachedChanges(range: ChangeRangeKey): {
  summary: ChangeSummary;
  perf: ProtocolPerformanceSummary | null;
} | null {
  if (!changesBox || changesBox.data.range !== range) return null;
  return { summary: changesBox.data.summary, perf: changesBox.data.perf };
}

export function setCachedChanges(
  range: ChangeRangeKey,
  summary: ChangeSummary,
  perf: ProtocolPerformanceSummary | null
) {
  changesBox = { data: { range, summary, perf }, at: Date.now() };
}

export function getCachedFlows(range: FlowRangeKey, min: number): FlowSummary | null {
  if (!flowsBox || flowsBox.data.range !== range || flowsBox.data.min !== min) return null;
  return flowsBox.data.summary;
}

export function setCachedFlows(range: FlowRangeKey, min: number, summary: FlowSummary) {
  flowsBox = { data: { range, min, summary }, at: Date.now() };
}

export function getCachedTransfers(range: TransferRangeKey): TransferSummary | null {
  if (!transfersBox || transfersBox.data.range !== range) return null;
  return transfersBox.data.summary;
}

export function setCachedTransfers(range: TransferRangeKey, summary: TransferSummary) {
  transfersBox = { data: { range, summary }, at: Date.now() };
}
