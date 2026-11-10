import type {
  FlowDirection,
  FlowEntityType,
  FlowEvent,
  PortfolioState,
  SnapshotPoint,
} from "./types";
import { EXCHANGE_LABEL } from "./exchange-labels";
import { isWalletRefreshEnabled } from "./wallets";

export type { FlowDirection, FlowEntityType, FlowEvent } from "./types";

export type FlowRangeKey = "24h" | "7d" | "30d" | "all";

export const FLOW_RANGES: Array<{ key: FlowRangeKey; label: string; ms: number | null }> = [
  { key: "24h", label: "24 小时", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7 天", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", label: "30 天", ms: 30 * 24 * 60 * 60 * 1000 },
  { key: "all", label: "全部记录", ms: null },
];

export interface FlowSummary {
  range: FlowRangeKey;
  rangeLabel: string;
  minUsd: number;
  generatedAt: string;
  events: FlowEvent[];
  totalIn: number;
  totalOut: number;
  netUsd: number;
  /** 实际扫描的相邻快照对数 */
  intervals: number;
  scannedFrom: string | null;
  scannedTo: string | null;
  note: string;
}

/** 间隔超过 6 小时就不做归因：中间可能发生了多次变动，硬算会得出错误结论。 */
const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** UI 的最低提示档。达到这个金额的记录会立即持久化，不随七天快照淘汰。 */
export const PERSISTED_FLOW_MIN_USD = 1;
/** 约可保存多年日常记录，同时限制单行 Turso JSON 的无限增长。 */
export const PERSISTED_FLOW_LIMIT = 10_000;

const round2 = (value: number) => Math.round(value * 100) / 100;

function flowBaselineMs(state: PortfolioState): number {
  const parsed = state.flowBaselineAt ? new Date(state.flowBaselineAt).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortAddress(address: string) {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

interface Delta {
  entityType: FlowEntityType;
  entityKey: string;
  entityLabel: string;
  entityAddress: string | null;
  before: number;
  after: number;
  change: number;
}

function collectDeltas(state: PortfolioState, prev: SnapshotPoint, cur: SnapshotPoint): Delta[] {
  const out: Delta[] = [];
  const walletByAddress = new Map(
    state.wallets.map((wallet) => [wallet.address.toLowerCase(), wallet])
  );

  const walletKeys = new Set([
    ...Object.keys(prev.wallets || {}),
    ...Object.keys(cur.wallets || {}),
  ]);
  for (const address of walletKeys) {
    // 任一侧是 Zerion 兜底读数就不记账：「公共源 → 兜底 → 公共源」的估值口径切换
    // 不是真实资金变动，记进去会制造假流水。
    if (prev.zerionWallets?.includes(address) || cur.zerionWallets?.includes(address)) continue;
    // 余额口径切换（公共源 ↔ 直连层）的那一轮同样不做归因：同一资产在两套估值
    // 体系里的差异不是真实资金变动。口径稳定后（相邻两轮一致）恢复记账。
    const prevBasis = prev.walletBasis?.[address] ?? "public";
    const curBasis = cur.walletBasis?.[address] ?? "public";
    if (prevBasis !== curBasis) continue;
    // Discovery/removal and incomplete valuations are not comparable observations.
    if (!(address in (prev.wallets ?? {})) || !(address in (cur.wallets ?? {}))) continue;
    // public-partial = fresh Rabby total with a held (stale) App slice. Same-basis
    // partial→partial deltas are like-for-like token movements; basis switches and
    // Zerion fallbacks above/below stay excluded so App re-audits never fake a flow.
    if ([prevBasis, curBasis].some((basis) => basis === "zerion")) continue;
    const before = Number(prev.wallets?.[address]);
    const after = Number(cur.wallets?.[address]);
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    const wallet = walletByAddress.get(address);
    if (wallet && !isWalletRefreshEnabled(wallet)) continue;
    out.push({
      entityType: "wallet",
      entityKey: `wallet:${address}`,
      entityLabel: wallet?.name || shortAddress(address),
      entityAddress: address,
      before,
      after,
      change: after - before,
    });
  }

  const suppressedExchanges = new Set(cur.suppressExchangeFlows ?? []);
  const suppressedManual = new Set(cur.suppressManualFlows ?? []);
  for (const [key, label] of Object.entries(EXCHANGE_LABEL)) {
    if (suppressedExchanges.has(key)) continue;
    const before = Number(prev.exchanges?.[key] ?? 0);
    const after = Number(cur.exchanges?.[key] ?? before);
    out.push({
      entityType: "exchange",
      entityKey: `exchange:${key}`,
      entityLabel: label,
      entityAddress: null,
      before,
      after,
      change: after - before,
    });
  }

  const manualKeys = new Set([
    ...Object.keys(prev.manualItems || {}),
    ...Object.keys(cur.manualItems || {}),
  ]);
  for (const name of manualKeys) {
    if (suppressedManual.has(name)) continue;
    const before = Number(prev.manualItems?.[name] ?? 0);
    const after = Number(cur.manualItems?.[name] ?? before);
    out.push({
      entityType: "manual",
      entityKey: `manual:${name}`,
      entityLabel: name,
      entityAddress: null,
      before,
      after,
      change: after - before,
    });
  }

  return out;
}

function pct(before: number, after: number) {
  if (Math.abs(before) < 0.01) return null;
  return ((after - before) / Math.abs(before)) * 100;
}

/** Detect one refresh interval. The caller persists the returned records immediately. */
export function detectFlowEventsBetween(
  state: PortfolioState,
  prev: SnapshotPoint,
  cur: SnapshotPoint,
  minUsd = PERSISTED_FLOW_MIN_USD
): FlowEvent[] {
  if (!prev.wallets || !cur.wallets || prev.seeded || cur.seeded) return [];
  const prevTs = new Date(prev.ts).getTime();
  const curTs = new Date(cur.ts).getTime();
  const intervalMs = curTs - prevTs;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > MAX_INTERVAL_MS) return [];

  const events: FlowEvent[] = [];
  const status: FlowEvent["status"] = cur.partial ? "partial" : "live";
  const deltas = collectDeltas(state, prev, cur).filter(
    (delta) => Math.abs(delta.change) >= Math.max(0, minUsd)
  );
  // Balance snapshots contain no transaction hash or counterparty evidence.
  // Record each entity independently; never infer transfers from matching amounts.
  for (const delta of deltas) {
    const direction = delta.change < 0 ? "out" : "in";
    events.push({
      id: `${cur.ts}-${delta.entityKey}-${direction}`,
      ts: cur.ts,
      direction,
      amountUsd: round2(Math.abs(delta.change)),
      before: round2(delta.before),
      after: round2(delta.after),
      changePct: pct(delta.before, delta.after),
      entityType: delta.entityType,
      entityKey: delta.entityKey,
      entityLabel: delta.entityLabel,
      entityAddress: delta.entityAddress,
      from: delta.entityLabel,
      to: "",
      matched: false,
      counterparty: null,
      status,
    });
  }

  return events;
}

/** Preserve historical measurements, but revoke unsupported transfer attribution. */
export function asBalanceObservation(event: FlowEvent): FlowEvent {
  const change = event.after - event.before;
  const direction = change < 0 ? "out" : "in";
  return {
    ...event,
    id: `${event.ts}-${event.entityKey}-${direction}`,
    direction,
    amountUsd: round2(Math.abs(change)),
    from: event.entityLabel,
    to: "",
    matched: false,
    counterparty: null,
  };
}

/** Rebuild detectable records from retained snapshots (used once for storage migration and dedupe). */
export function deriveFlowEventsFromSnapshots(
  state: PortfolioState,
  source: SnapshotPoint[] = state.snapshots,
  minUsd = PERSISTED_FLOW_MIN_USD
): FlowEvent[] {
  const baselineMs = flowBaselineMs(state);
  const snapshots = source
    .filter((point) => point.wallets && new Date(point.ts).getTime() >= baselineMs)
    .sort((left, right) => new Date(left.ts).getTime() - new Date(right.ts).getTime());
  const events: FlowEvent[] = [];
  for (let index = 1; index < snapshots.length; index += 1) {
    events.push(...detectFlowEventsBetween(state, snapshots[index - 1], snapshots[index], minUsd));
  }
  return events;
}

/**
 * 大额资金变动流水。
 * 逐张快照对比“每个钱包 / 每家交易所 / 每条手动资产”的余额差，
 * 超过阈值就记一条。只代表估值变化，不代表已发生转账。
 */
export function buildFlowSummary(
  state: PortfolioState,
  opts: { range?: FlowRangeKey; minUsd?: number; limit?: number } = {}
): FlowSummary {
  const rangeKey = opts.range ?? "24h";
  const range = FLOW_RANGES.find((item) => item.key === rangeKey) ?? FLOW_RANGES[0];
  const minUsd = Math.max(0, opts.minUsd ?? 1);
  const limit = Math.max(1, opts.limit ?? 120);
  const now = Date.now();
  const baselineMs = flowBaselineMs(state);

  // 只比较“真实刷新”写入的快照：演示基线快照没有逐钱包明细，
  // 拿它做基准会把“从 0 到当前值”误报成大额转入。
  const snapshots = state.snapshots
    .filter((point) => point.wallets && new Date(point.ts).getTime() >= baselineMs)
    .sort((left, right) => new Date(left.ts).getTime() - new Date(right.ts).getTime());

  const recentEvents: FlowEvent[] = [];
  let intervals = 0;

  for (let index = 1; index < snapshots.length; index += 1) {
    const prev = snapshots[index - 1];
    const cur = snapshots[index];
    if (!prev.wallets || !cur.wallets) continue;
    const prevTs = new Date(prev.ts).getTime();
    const curTs = new Date(cur.ts).getTime();
    const intervalMs = curTs - prevTs;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > MAX_INTERVAL_MS) continue;
    if (range.ms != null && curTs < now - range.ms) continue;
    intervals += 1;
    recentEvents.push(...detectFlowEventsBetween(state, prev, cur, minUsd));
  }

  // Persistent events survive snapshot rotation. Union with recent derived events to
  // preserve records created before this storage migration and deduplicate by stable id.
  const persistent = (state.flowEvents ?? []).map(asBalanceObservation).filter((event) => {
    const ts = new Date(event.ts).getTime();
    return (
      ts >= baselineMs &&
      event.amountUsd >= minUsd &&
      (range.ms == null || ts >= now - range.ms)
    );
  });
  const byId = new Map<string, FlowEvent>();
  for (const event of [...persistent, ...recentEvents]) byId.set(event.id, event);
  const events = [...byId.values()].sort(
    (left, right) => new Date(right.ts).getTime() - new Date(left.ts).getTime()
  );
  const limited = events.slice(0, limit);
  const totalIn = round2(
    events.filter((event) => event.direction === "in").reduce((sum, event) => sum + event.amountUsd, 0)
  );
  const totalOut = round2(
    events.filter((event) => event.direction === "out").reduce((sum, event) => sum + event.amountUsd, 0)
  );

  return {
    range: range.key,
    rangeLabel: range.label,
    minUsd,
    generatedAt: new Date().toISOString(),
    events: limited,
    totalIn,
    totalOut,
    netUsd: round2(totalIn - totalOut),
    intervals,
    scannedFrom: events.length ? events[events.length - 1].ts : snapshots.length ? snapshots[0].ts : null,
    scannedTo: events.length ? events[0].ts : snapshots.length ? snapshots[snapshots.length - 1].ts : null,
    note: "余额估值变化，不代表转账；价格波动、仓位变化或数据修正均可能影响估值。交易记录需单独核验。",
  };
}
