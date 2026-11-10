"use client";

import { useMemo, useState } from "react";
import { Area, ComposedChart, Customized, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChangeRangeKey, ChangeSummary } from "@/lib/changes";
import { CHANGE_RANGES } from "@/lib/changes";
import type { SnapshotPoint } from "@/lib/types";
import { cny, deltaClass, signedPct, signedUsd, usd } from "./format";

function formatPointTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface ChartPoint {
  ts: string;
  t: string;
  v: number;
  onchain: number | null;
  cex: number | null;
  manual: number;
}

interface Delta {
  change: number;
  pct: number | null;
}

const EXCHANGE_COLOR = "var(--blue)";
const ONCHAIN_COLOR = "var(--accent)";

function seriesValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatSeries(value: number | null) {
  return value == null ? "—" : usd(value);
}

/** 各轴按自身高低留出呼吸空间，避免一条线被另一条的量级压扁。 */
function paddedDomain(values: Array<number | null>): [number, number] {
  const nums = values.filter((value): value is number => value != null);
  if (!nums.length) return [0, 1];
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const pad = Math.max((max - min) * 0.12, Math.max(Math.abs(max) * 0.01, 0.5));
  return [min - pad, max + pad];
}

/** Y 轴刻度：窄区间也能看出差异（79.0K / 79.1K），不再是清一色的 79K。 */
function formatAxisTick(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(abs < 1_000_000 ? 1 : 0)}K`;
  if (abs >= 1_000) return `${(value / 1000).toFixed(2)}K`;
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function axisTickFormatter(domain: [number, number]) {
  const span = domain[1] - domain[0];
  return (value: number) =>
    span < 1000
      ? Number(value).toLocaleString("en-US", { maximumFractionDigits: span < 10 ? 2 : 0 })
      : formatAxisTick(Number(value));
}

function deltaOf(before: number, after: number): Delta {
  const change = Math.round((after - before) * 100) / 100;
  const pct = Number.isFinite(before) && Math.abs(before) >= 0.01 ? ((after - before) / Math.abs(before)) * 100 : null;
  return { change, pct };
}

/** 用窗口内第一条和最后一条有效读数计算区间变化。 */
function spanDelta(values: Array<number | null>): Delta | null {
  let first: number | null = null;
  let last: number | null = null;
  let count = 0;
  for (const value of values) {
    if (value == null) continue;
    if (first == null) first = value;
    last = value;
    count += 1;
  }
  if (count < 2 || first == null || last == null) return null;
  return deltaOf(first, last);
}

function latestNumber(values: Array<number | null>): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] != null) return values[index];
  }
  return null;
}

function ChartTooltip({
  active,
  payload,
  rate,
}: {
  active?: boolean;
  payload?: Array<{ payload?: ChartPoint }>;
  rate: number;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="chart-tooltip">
      <div className="time">{formatPointTime(point.ts)}</div>
      <div className="grid">
        <span>
          <i className="tip-dot" style={{ background: EXCHANGE_COLOR }} />
          交易所余额
        </span>
        <b>{formatSeries(point.cex)}</b>
        <span>
          <i className="tip-dot" style={{ background: ONCHAIN_COLOR }} />
          链上资金
        </span>
        <b>{formatSeries(point.onchain)}</b>
        <span>
          <i className="tip-dot" style={{ background: "var(--ink-3)" }} />
          手动
        </span>
        <b>{usd(point.manual)}</b>
      </div>
      <div className="time num">
        合计 {usd(point.v)} · {cny(point.v * rate)}
      </div>
    </div>
  );
}

const TAG_W = 136;
const TAG_H = 34;
/** 标签水平锚在绘图区略偏左中（0 为左缘，1 为右缘），不跟序列最右端。 */
const TAG_X_RATIO = 0.38;

interface PlotPoint {
  x: number;
  y: number;
}

interface PlotBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function boxesOverlap(a: { x: number; y: number }, b: { x: number; y: number }) {
  return a.x < b.x + TAG_W + 6 && a.x + TAG_W + 6 > b.x && a.y < b.y + TAG_H + 6 && a.y + TAG_H + 6 > b.y;
}

function tagBox(point: PlotPoint, otherY: number | null, plot: PlotBox) {
  const minX = plot.left + 2;
  const maxX = Math.max(minX, plot.left + plot.width - TAG_W - 2);
  const minY = plot.top + 2;
  const maxY = Math.max(minY, plot.top + plot.height - TAG_H - 2);
  const preferAbove = otherY == null ? point.y > plot.top + plot.height / 2 : point.y <= otherY;
  let y = preferAbove ? point.y - TAG_H - 8 : point.y + 8;
  if (y < minY) y = point.y + 8;
  if (y > maxY) y = point.y - TAG_H - 8;
  y = clamp(y, minY, maxY);
  const x = clamp(point.x - TAG_W / 2, minX, maxX);
  return { x, y };
}

/** 水平位置固定在绘图区略偏左中；竖直仍贴着各自曲线的当前高度。 */
function seriesAnchor(points: PlotPoint[], plot: PlotBox): PlotPoint {
  return {
    x: plot.left + plot.width * TAG_X_RATIO,
    y: points[points.length - 1].y,
  };
}

/** 两块标签挤在一起时，保持同一水平锚点，只在竖直方向错开，避免被推回右缘。 */
function separateVertically(
  cexY: number,
  onY: number,
  plot: PlotBox,
  x: number
) {
  const minY = plot.top + 2;
  const maxY = Math.max(minY, plot.top + plot.height - TAG_H - 2);
  const onchainAbove = onY <= cexY;
  let upperY = clamp(Math.min(cexY, onY) - TAG_H - 8, minY, maxY);
  let lowerY = upperY + TAG_H + 6;
  if (lowerY > maxY) {
    lowerY = maxY;
    upperY = clamp(maxY - TAG_H - 6, minY, maxY);
  }
  const upper = { x, y: upperY };
  const lower = { x, y: clamp(lowerY, minY, maxY) };
  return {
    cexBox: onchainAbove ? lower : upper,
    onBox: onchainAbove ? upper : lower,
  };
}

/** 把图例放在绘图区略偏左中，并保证两块标签都落在绘图区内且互不遮挡。 */
function placeSeriesTags(cex: PlotPoint[], onchain: PlotPoint[], plot: PlotBox) {
  if (plot.width < TAG_W + 8 || plot.height < TAG_H + 8) return null;
  if (!cex.length && !onchain.length) return null;
  if (!cex.length) return { cexBox: null, onBox: tagBox(seriesAnchor(onchain, plot), null, plot) };
  if (!onchain.length) return { cexBox: tagBox(seriesAnchor(cex, plot), null, plot), onBox: null };

  const cexPt = seriesAnchor(cex, plot);
  const onPt = seriesAnchor(onchain, plot);
  const cexBox = tagBox(cexPt, onPt.y, plot);
  const onBox = tagBox(onPt, cexPt.y, plot);
  if (!boxesOverlap(cexBox, onBox)) return { cexBox, onBox };
  return separateVertically(cexPt.y, onPt.y, plot, cexBox.x);
}

interface GraphicalEntry {
  props?: { dataKey?: unknown; points?: Array<{ x?: number; y?: number }> };
  item?: { type?: { displayName?: string }; props?: { dataKey?: unknown } };
}

function seriesPoints(items: GraphicalEntry[] | undefined, dataKey: string): PlotPoint[] {
  if (!items?.length) return [];
  for (const entry of items) {
    const name = entry.item?.type?.displayName;
    if (name !== "Line") continue;
    const key = entry.props?.dataKey ?? entry.item?.props?.dataKey;
    if (key !== dataKey) continue;
    const points = entry.props?.points;
    if (!Array.isArray(points)) continue;
    const parsed = points.filter(
      (point): point is PlotPoint => typeof point.x === "number" && typeof point.y === "number" && Number.isFinite(point.x) && Number.isFinite(point.y)
    );
    if (parsed.length) return parsed;
  }
  return [];
}

function SeriesTag({
  x,
  y,
  title,
  value,
  color,
}: {
  x: number;
  y: number;
  title: string;
  value: string;
  color: string;
}) {
  return (
    <g className="chart-series-tag" pointerEvents="none">
      <rect className="chart-series-tag-bg" x={x} y={y} width={TAG_W} height={TAG_H} rx={7} stroke={color} />
      <text className="chart-series-tag-title" x={x + 8} y={y + 13} fill={color}>
        {title}
      </text>
      <text className="chart-series-tag-value" x={x + 8} y={y + 27} fill={color}>
        {value}
      </text>
    </g>
  );
}

function SeriesCallouts(props: {
  formattedGraphicalItems?: GraphicalEntry[];
  offset?: PlotBox;
  cexLabel?: string;
  onchainLabel?: string;
}) {
  const plot = props.offset;
  if (!plot || (!props.cexLabel && !props.onchainLabel)) return null;
  const placed = placeSeriesTags(
    props.cexLabel ? seriesPoints(props.formattedGraphicalItems, "cex") : [],
    props.onchainLabel ? seriesPoints(props.formattedGraphicalItems, "onchain") : [],
    plot
  );
  if (!placed) return null;
  return (
    <g>
      {placed.cexBox && props.cexLabel ? (
        <SeriesTag x={placed.cexBox.x} y={placed.cexBox.y} title="交易所余额" value={props.cexLabel} color={EXCHANGE_COLOR} />
      ) : null}
      {placed.onBox && props.onchainLabel ? (
        <SeriesTag x={placed.onBox.x} y={placed.onBox.y} title="链上资金" value={props.onchainLabel} color={ONCHAIN_COLOR} />
      ) : null}
    </g>
  );
}

function PnlBlock({
  label,
  dot,
  delta,
}: {
  label: string;
  dot: string;
  delta: Delta | null;
}) {
  return (
    <div className="chart-pnl-item">
      <span className="chart-pnl-k">
        <i className="tip-dot" style={{ background: dot }} />
        {label}
      </span>
      {delta ? (
        <span className="chart-pnl-v">
          <strong className={`num ${deltaClass(delta.change)}`}>{signedUsd(delta.change)}</strong>
          {delta.pct != null ? <em className={`num ${deltaClass(delta.change)}`}>{signedPct(delta.pct)}</em> : null}
        </span>
      ) : (
        <span className="chart-pnl-v">
          <strong className="num flat">—</strong>
        </span>
      )}
    </div>
  );
}

/** 资产趋势：交易所走左轴，链上走右轴；区间盈亏跟 1h / 12h / 24h / 7d 切换。 */
export function PortfolioChart({
  snapshots,
  usdCnyRate = 6.66,
  range,
  summary,
  onRangeChange,
}: {
  snapshots: SnapshotPoint[];
  usdCnyRate?: number;
  range: ChangeRangeKey;
  summary?: ChangeSummary | null;
  onRangeChange: (range: ChangeRangeKey) => void;
}) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const rate = usdCnyRate || 6.66;
  const activeRange = CHANGE_RANGES.find((item) => item.key === range) ?? CHANGE_RANGES[2];

  const { data, covered } = useMemo(() => {
    const cutoff = Date.now() - activeRange.ms;
    const inWindow = snapshots.filter((point) => new Date(point.ts).getTime() >= cutoff - 60_000);
    const covered = inWindow.length >= 2;
    const source = covered ? inWindow : snapshots.slice(-2);
    return {
      covered,
      data: source.map((point) => ({
        ts: point.ts,
        t: formatPointTime(point.ts),
        v: point.totalUsd,
        onchain: seriesValue(point.onchain),
        cex: seriesValue(point.cex),
        manual: point.manual ?? 0,
      })),
    };
  }, [snapshots, activeRange.ms]);

  const cexDomain = useMemo(() => paddedDomain(data.map((point) => point.cex)), [data]);
  const onchainDomain = useMemo(() => paddedDomain(data.map((point) => point.onchain)), [data]);
  const hasCex = data.some((point) => point.cex != null);
  const hasOnchain = data.some((point) => point.onchain != null);
  const pnl = useMemo(() => {
    if (!covered || data.length < 2) return null;
    return {
      cex: spanDelta(data.map((point) => point.cex)),
      onchain: spanDelta(data.map((point) => point.onchain)),
      total: spanDelta(data.map((point) => point.v)),
    };
  }, [covered, data]);

  const lastPoint = data.length ? data[data.length - 1] : null;
  const latestCex = latestNumber(data.map((point) => point.cex));
  const latestOnchain = latestNumber(data.map((point) => point.onchain));
  void activeIdx;

  return (
    <section className="section" id="trend">
      <div className="section-head">
        <div className="section-title">
          <h2>资产趋势</h2>
          <span className="hint">
            交易所 · 链上 · 快照 {summary?.snapshotCount ?? snapshots.length} 条
          </span>
        </div>
        <span className="seg">
          {CHANGE_RANGES.map((item) => (
            <button
              key={item.key}
              type="button"
              className={range === item.key ? "active" : ""}
              onClick={() => {
                onRangeChange(item.key);
                setActiveIdx(null);
              }}
            >
              {item.short}
            </button>
          ))}
        </span>
      </div>

      <div className="chart-pnl" aria-label={`过去 ${activeRange.label}盈亏`}>
        <PnlBlock label="交易所" dot={EXCHANGE_COLOR} delta={pnl?.cex ?? null} />
        <PnlBlock label="链上" dot={ONCHAIN_COLOR} delta={pnl?.onchain ?? null} />
        <PnlBlock label="总资产" dot="var(--ink)" delta={pnl?.total ?? null} />
      </div>
      <div className="chart-pnl-note muted">
        过去 {activeRange.label}
        {!covered && snapshots.length >= 2 ? " · 区间内快照不足，盈亏暂不计算" : ""}
        {summary && summary.upCount + summary.downCount > 0
          ? ` · ${summary.upCount} 个上涨 · ${summary.downCount} 个下降`
          : ""}
      </div>

      <div className="chart-head">
        {lastPoint ? (
          <div className="muted num">
            最新快照 {formatPointTime(lastPoint.ts)} · {usd(lastPoint.v)}
          </div>
        ) : (
          <div className="muted">{summary?.reason || `数据不足以计算${activeRange.label}变化`}</div>
        )}
      </div>

      {summary && !summary.enoughData && pnl != null && (
        <div className="notice" style={{ marginBottom: 10 }}>
          {summary.reason}
          {summary.partial ? " · 部分数据使用上次成功记录" : ""}
        </div>
      )}

      {data.length < 2 ? (
        <div className="notice" style={{ marginBottom: 10 }}>
          暂无足够快照绘制趋势（当前 {snapshots.length} 条）。每分钟 CEX 刷新会写入总资产快照，稍候再看。
        </div>
      ) : !hasCex || !hasOnchain ? (
        <div className="notice" style={{ marginBottom: 10 }}>
          {!hasCex && !hasOnchain
            ? "快照里还没有交易所余额和链上资金分项，双轴曲线会在之后的刷新里出现。"
            : !hasCex
              ? "快照里还没有交易所余额分项，左轴暂无曲线。"
              : "快照里还没有链上资金分项，右轴暂无曲线。"}
        </div>
      ) : null}
      <div className="chart-canvas" aria-label="资产趋势图：交易所余额，链上资金">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 4, left: 0, bottom: 0 }}
            onMouseMove={(state) => {
              if (state && state.activeTooltipIndex != null) {
                setActiveIdx(Number(state.activeTooltipIndex));
              }
            }}
            onMouseLeave={() => setActiveIdx(null)}
          >
            <defs>
              <linearGradient id="cexFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={EXCHANGE_COLOR} stopOpacity={0.2} />
                <stop offset="100%" stopColor={EXCHANGE_COLOR} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="onchainFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ONCHAIN_COLOR} stopOpacity={0.18} />
                <stop offset="100%" stopColor={ONCHAIN_COLOR} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="t"
              tick={{ fontSize: 12, fill: "var(--ink-3)" }}
              axisLine={false}
              tickLine={false}
              minTickGap={48}
            />
            <YAxis
              yAxisId="cex"
              orientation="left"
              domain={cexDomain}
              allowDataOverflow
              tick={{ fontSize: 12, fill: "var(--blue)" }}
              axisLine={false}
              tickLine={false}
              width={58}
              tickCount={5}
              tickFormatter={axisTickFormatter(cexDomain)}
            />
            <YAxis
              yAxisId="onchain"
              orientation="right"
              domain={onchainDomain}
              allowDataOverflow
              tick={{ fontSize: 12, fill: "var(--accent)" }}
              axisLine={false}
              tickLine={false}
              width={58}
              tickCount={5}
              tickFormatter={axisTickFormatter(onchainDomain)}
            />
            <Tooltip
              content={<ChartTooltip rate={rate} />}
              cursor={{ stroke: "var(--line)", strokeWidth: 1 }}
              isAnimationActive={false}
              allowEscapeViewBox={{ x: true, y: true }}
              wrapperStyle={{ zIndex: 40, pointerEvents: "none" }}
            />
            <Area
              yAxisId="cex"
              type="monotone"
              dataKey="cex"
              stroke="none"
              fill="url(#cexFill)"
              connectNulls={false}
              isAnimationActive={false}
              activeDot={false}
            />
            <Area
              yAxisId="onchain"
              type="monotone"
              dataKey="onchain"
              stroke="none"
              fill="url(#onchainFill)"
              connectNulls={false}
              isAnimationActive={false}
              activeDot={false}
            />
            <Line
              yAxisId="cex"
              type="monotone"
              dataKey="cex"
              name="交易所余额"
              stroke={EXCHANGE_COLOR}
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              connectNulls={false}
              activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2, fill: EXCHANGE_COLOR }}
              isAnimationActive={false}
            />
            <Line
              yAxisId="onchain"
              type="monotone"
              dataKey="onchain"
              name="链上资金"
              stroke={ONCHAIN_COLOR}
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              connectNulls={false}
              activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2, fill: ONCHAIN_COLOR }}
              isAnimationActive={false}
            />
            <Customized
              component={SeriesCallouts}
              cexLabel={latestCex != null ? usd(latestCex) : ""}
              onchainLabel={latestOnchain != null ? usd(latestOnchain) : ""}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
