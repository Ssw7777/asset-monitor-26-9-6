import type { PortfolioState, SnapshotPoint } from "./types";
import { isWalletRefreshEnabled } from "./wallets";
import { exchangeLabel } from "./exchange-labels";
import { cnyManualNames, isCryptoManual, stripCnyManualFromSnapshot } from "./manual-assets";

export type ChangeRangeKey = "1h" | "12h" | "24h" | "7d";

export const CHANGE_RANGES: Array<{ key: ChangeRangeKey; label: string; short: string; ms: number }> = [
  { key: "1h", label: "1 小时", short: "1h", ms: 60 * 60 * 1000 },
  { key: "12h", label: "12 小时", short: "12h", ms: 12 * 60 * 60 * 1000 },
  { key: "24h", label: "24 小时", short: "24h", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7 天", short: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
];

export type ChangeRowType = "onchain" | "exchange" | "dapp" | "wallet" | "manual";
export type ChangeDataStatus = "live" | "cached" | "error" | "baseline" | "manual";

export interface ChangeRow {
  key: string;
  type: ChangeRowType;
  label: string;
  detail: string;
  address: string | null;
  before: number;
  after: number;
  change: number;
  pct: number | null;
  updatedAt: string | null;
  dataStatus: ChangeDataStatus;
}

export interface ChangeSummary {
  range: ChangeRangeKey;
  rangeLabel: string;
  rangeMs: number;
  /** 是否已有足够的真实历史快照来比较该窗口 */
  enoughData: boolean;
  reason?: string;
  from: { ts: string; totalUsd: number } | null;
  to: { ts: string; totalUsd: number } | null;
  total: { before: number; after: number; change: number; pct: number; partial: boolean } | null;
  rows: ChangeRow[];
  upCount: number;
  downCount: number;
  /** 低于阈值被折叠的变动条数（默认 1 USDT 以下折叠） */
  dustCount: number;
  minUsd: number;
  partial: boolean;
  snapshotCount: number;
  /** 实际覆盖的时间跨度（毫秒） */
  coverageMs: number;
  /** 目标时间点是否带有钱包 / DApp / 手动明细；false 表示只有演示基线，无法归因到具体来源 */
  detailAvailable: boolean;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function tsOf(point: SnapshotPoint) {
  const value = new Date(point.ts).getTime();
  return Number.isFinite(value) ? value : 0;
}

/**
 * 选择“目标时间点之前或最接近目标时间点的真实快照”。
 * 没有更早的快照时退化为最早的一条，并标记为覆盖不完整。
 */
function pickPastSnapshot(
  snapshots: SnapshotPoint[],
  targetMs: number
): { point: SnapshotPoint; complete: boolean } | null {
  if (!snapshots.length) return null;
  let best: SnapshotPoint | null = null;
  for (const point of snapshots) {
    const ts = tsOf(point);
    if (ts <= targetMs && (!best || ts > tsOf(best))) best = point;
  }
  if (best) return { point: best, complete: true };
  return { point: snapshots[0], complete: false };
}

function changePct(before: number, after: number): number | null {
  if (!Number.isFinite(before) || Math.abs(before) < 0.01) return null;
  return ((after - before) / Math.abs(before)) * 100;
}

function walletStatus(status: string | undefined): ChangeDataStatus {
  if (status === "ok") return "live";
  if (status === "cached" || status === "stale") return "cached";
  if (status === "error") return "error";
  return "baseline";
}

function shortAddress(address: string) {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function buildChangeSummary(
  state: PortfolioState,
  rangeKey: ChangeRangeKey,
  opts: { minUsd?: number; includeDapps?: boolean; now?: number } = {}
): ChangeSummary {
  /** 小于 1 USDT 的变动默认折叠，不占列表（用户要求：只看钱包，且小额不显示） */
  const minUsd = Math.max(0, opts.minUsd ?? 1);
  const includeDapps = opts.includeDapps === true;
  const now = opts.now ?? Date.now();
  const range = CHANGE_RANGES.find((item) => item.key === rangeKey) ?? CHANGE_RANGES[2];
  // 变动区间与 K 线一致：人民币手动资产不计入加密资产趋势。
  const cnyNames = cnyManualNames(state.manual);
  const snapshots = state.snapshots.map((point) => stripCnyManualFromSnapshot(point, cnyNames));
  const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const picked = pickPastSnapshot(snapshots, now - range.ms);

  const empty: ChangeSummary = {
    range: range.key,
    rangeLabel: range.label,
    rangeMs: range.ms,
    enoughData: false,
    reason: "数据不足以计算该区间的变化",
    from: null,
    to: latest ? { ts: latest.ts, totalUsd: latest.totalUsd } : null,
    total: null,
    rows: [],
    upCount: 0,
    downCount: 0,
    dustCount: 0,
    minUsd,
    partial: false,
    snapshotCount: snapshots.length,
    coverageMs: 0,
    detailAvailable: false,
  };

  if (snapshots.length < 2 || !latest || !picked) return empty;

  const past = picked.point;
  const coverageMs = Math.max(0, tsOf(latest) - tsOf(past));
  // 覆盖不足即为“历史不够”：少于目标窗口的 80%，或找不到目标时间点之前的快照。
  const enoughData = picked.complete && coverageMs >= range.ms * 0.8 && coverageMs > 0;

  if (coverageMs <= 0) {
    return { ...empty, snapshotCount: snapshots.length, from: { ts: past.ts, totalUsd: past.totalUsd } };
  }

  const rows: ChangeRow[] = [];
  const push = (row: Omit<ChangeRow, "change" | "pct">) => {
    const change = round2(row.after - row.before);
    if (Math.abs(change) < 0.01) return;
    rows.push({ ...row, change, pct: changePct(row.before, row.after) });
  };

  /**
   * 演示基线快照没有逐钱包 / 逐 DApp / 逐条手动资产明细。
   * 这种情况不能把“从 0 到当前值”当成变动，否则会出现 +13,630 这种虚假结论。
   */
  const detailAvailable = !!(past.wallets || past.dapps || past.manualItems);

  // 1) 链上 / 交易所 / 手动 三大来源
  push({
    key: "onchain",
    type: "onchain",
    label: "链上资产",
    detail: `${state.wallets.filter(isWalletRefreshEnabled).length} 个钱包合计`,
    address: null,
    before: round2(past.onchain ?? 0),
    after: round2(latest.onchain ?? 0),
    updatedAt: latest.ts,
    dataStatus: state.onchainBreakdown?.partial ? "cached" : "live",
  });

  for (const exchange of state.exchanges) {
    const pastMap = past.exchanges;
    // A newly published account (Gate B / Gate C) is a baseline, not a deposit.
    if (pastMap && !Object.prototype.hasOwnProperty.call(pastMap, exchange.exchange)) continue;
    push({
      key: `exchange:${exchange.exchange}`,
      type: "exchange",
      label: exchangeLabel(exchange.exchange),
      detail: "交易所余额",
      address: null,
      before: round2(pastMap?.[exchange.exchange] ?? 0),
      after: round2(latest.exchanges?.[exchange.exchange] ?? exchange.balanceUsd),
      updatedAt: exchange.lastUpdated,
      dataStatus:
        exchange.status === "ok"
          ? "live"
          : exchange.status === "error" || exchange.status === "missing_passphrase"
            ? "error"
            : exchange.status === "missing_keys"
              ? "cached"
              : "baseline",
    });
  }

  if (detailAvailable) {
    for (const item of state.manual) {
      if (!isCryptoManual(item)) continue;
      push({
        key: `manual:${item.id}`,
        type: "manual",
        label: item.name || "手动资产",
        detail: "手动记账",
        address: null,
        before: round2(past.manualItems?.[item.name] ?? item.amountUsd),
        after: round2(item.amountUsd),
        updatedAt: item.updatedAt,
        dataStatus: "manual",
      });
    }
  }

  // 2) DApp 协议仓位变化（仅解释来源，不改变总额口径）
  // DApp 仓位是钱包总额的组成部分，默认不参与变动归因（用户要求：只记录钱包）
  const dappKeys =
    detailAvailable && includeDapps
      ? new Set<string>([...Object.keys(past.dapps || {}), ...Object.keys(latest.dapps || {})])
      : new Set<string>();
  for (const name of dappKeys) {
    push({
      key: `dapp:${name}`,
      type: "dapp",
      label: name,
      detail: "DApp 净值（仅解释组成）",
      address: null,
      before: round2(past.dapps?.[name] ?? 0),
      after: round2(latest.dapps?.[name] ?? 0),
      updatedAt: latest.ts,
      dataStatus: state.onchainBreakdown?.partial ? "cached" : "live",
    });
  }

  // 3) 钱包级变化：定位到具体地址
  const byAddress = new Map(state.wallets.map((wallet) => [wallet.address.toLowerCase(), wallet]));
  const walletKeys = detailAvailable
    ? new Set<string>([...Object.keys(past.wallets || {}), ...Object.keys(latest.wallets || {})])
    : new Set<string>();
  for (const address of walletKeys) {
    const wallet = byAddress.get(address);
    if (wallet && !isWalletRefreshEnabled(wallet)) continue;
    push({
      key: `wallet:${address}`,
      type: "wallet",
      label: wallet?.name || shortAddress(address),
      detail: wallet ? `${wallet.chain} · ${shortAddress(wallet.address)}` : shortAddress(address),
      address,
      before: round2(past.wallets?.[address] ?? 0),
      after: round2(latest.wallets?.[address] ?? wallet?.balanceUsd ?? 0),
      updatedAt: wallet?.lastUpdated ?? latest.ts,
      dataStatus: walletStatus(wallet?.status),
    });
  }

  rows.sort((left, right) => Math.abs(right.change) - Math.abs(left.change));
  const kept = rows.filter((row) => Math.abs(row.change) >= minUsd);
  const dustCount = rows.length - kept.length;
  const upCount = kept.filter((row) => row.change > 0).length;
  const downCount = kept.filter((row) => row.change < 0).length;

  const before = past.totalUsd;
  const after = latest.totalUsd;
  const change = round2(after - before);

  return {
    range: range.key,
    rangeLabel: range.label,
    rangeMs: range.ms,
    enoughData,
    reason: enoughData ? undefined : "历史数据不足，仅展示已覆盖区间的对比",
    from: { ts: past.ts, totalUsd: before },
    to: { ts: latest.ts, totalUsd: after },
    total: {
      before: round2(before),
      after: round2(after),
      change,
      pct: changePct(before, after) ?? 0,
      partial: !picked.complete,
    },
    rows: kept,
    upCount,
    downCount,
    dustCount,
    minUsd,
    partial: past.partial === true || latest.partial === true,
    snapshotCount: snapshots.length,
    coverageMs,
    detailAvailable,
  };
}
