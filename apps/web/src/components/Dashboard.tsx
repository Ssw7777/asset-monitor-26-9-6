"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ChangeRangeKey, ChangeSummary } from "@/lib/changes";
import type { FlowRangeKey, FlowSummary } from "@/lib/flows";
import type { TransferSummary } from "@/lib/transfers";
import type { ProtocolPerformanceSummary } from "@/lib/protocols";
import type { OnchainBreakdown, Wallet } from "@/lib/types";
import {
  getCachedChanges,
  getCachedFlows,
  getCachedPortfolio,
  getCachedTransfers,
  isPortfolioFresh,
  setCachedChanges,
  setCachedFlows,
  setCachedTransfers,
  setCachedPortfolio,
  type PortfolioPayload,
} from "@/lib/dashboard-client-cache";
import { ChangeSection } from "./ChangeSection";
import { ExchangeSection } from "./ExchangeSection";
import { FlowSection } from "./FlowSection";
import { ManualAssets } from "./ManualAssets";
import { manualToUsd, sumManualCryptoUsd, sumManualCnyNative } from "@/lib/manual-assets";
import { PortfolioChart } from "./PortfolioChart";
import { ProtocolSections } from "./ProtocolSections";
import { TokenTable } from "./TokenTable";
import { localChainIcon, TokenIcon } from "./TokenIcon";
import { WalletsTable } from "./WalletsTable";
import { cny, timeAgo, usd } from "./format";
import { walletFreshness } from "@/lib/freshness";
import { activeRefreshWallets } from "@/lib/wallets";

/** 快照每 5 分钟记一条；钱包余额由云端接力循环每约 10 分钟滚动检查（成功时间最旧的优先）。 */
const AUTO_TICK_MS = 5 * 60 * 1000;
const AUTO_FULL_EVERY_MS = 5 * 60 * 1000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;

/** DeBank 链色，用于链卡片左侧色条；没有映射的链回退为中性色。 */
const CHAIN_COLOR: Record<string, string> = {
  eth: "#627eea",
  bsc: "#f0b90b",
  xlayer: "#1a1a1a",
  abs: "#63d2ff",
  base: "#0052ff",
  arb: "#28a0f0",
  op: "#ff0420",
  matic: "#8247e5",
  hood: "#00c087",
  monad: "#836ef9",
  avax: "#e84142",
  zora: "#5b5bd6",
  scrl: "#ffd54f",
  linea: "#61dfff",
  bera: "#b76a1a",
  plasma: "#1a1a1a",
  solana: "#9945ff",
};

export type DashboardSection =
  | "overview"
  | "flows"
  | "tokens"
  | "defi"
  | "exchanges"
  | "manual"
  | "addresses";

function isPortfolioPayload(value: unknown): value is PortfolioPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const totals = v.totals;
  if (!totals || typeof totals !== "object") return false;
  const t = totals as Record<string, unknown>;
  return (
    typeof t.totalUsd === "number" &&
    Array.isArray(v.wallets) &&
    Array.isArray(v.exchanges) &&
    Array.isArray(v.manual) &&
    Array.isArray(v.snapshots)
  );
}

/** 分页均正常滚动；总览还原基线 overview-duo，不再强塞一屏。 */

function ChainIcon({ chain }: { chain: OnchainBreakdown["chains"][number] }) {
  return (
    <TokenIcon
      symbol={chain.name || chain.id}
      localSrc={localChainIcon(chain.id)}
      logoUrl={chain.logoUrl}
      size={26}
      shape="square"
    />
  );
}

export function Dashboard({ section }: { section: DashboardSection }) {
  const router = useRouter();
  const [data, setData] = useState<PortfolioPayload | null>(() => getCachedPortfolio());
  const [loading, setLoading] = useState(() => !getCachedPortfolio());
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [rateDraft, setRateDraft] = useState("");
  const [rateSaving, setRateSaving] = useState(false);
  const [range, setRange] = useState<ChangeRangeKey>("24h");
  const [changes, setChanges] = useState<ChangeSummary | null>(() => getCachedChanges("24h")?.summary ?? null);
  const [changesLoading, setChangesLoading] = useState(() => !getCachedChanges("24h"));
  const [chainFilter, setChainFilter] = useState("all");
  const [smallChainsOpen, setSmallChainsOpen] = useState(false);
  const [exporting, setExporting] = useState("");
  const [flows, setFlows] = useState<FlowSummary | null>(() => getCachedFlows("24h", 30));
  const [protocolPerf, setProtocolPerf] = useState<ProtocolPerformanceSummary | null>(
    () => getCachedChanges("24h")?.perf ?? null
  );
  const [flowsLoading, setFlowsLoading] = useState(() => !getCachedFlows("24h", 30));
  const [flowRange, setFlowRange] = useState<FlowRangeKey>("24h");
  const [flowMin, setFlowMin] = useState(30);
  const [transfers, setTransfers] = useState<TransferSummary | null>(() => getCachedTransfers("24h"));
  const [transfersLoading, setTransfersLoading] = useState(() => !getCachedTransfers("24h"));
  const [mountedSections, setMountedSections] = useState<Set<DashboardSection>>(
    () => new Set<DashboardSection>([section])
  );
  useEffect(() => {
    setMountedSections((prev) => {
      if (prev.has(section)) return prev;
      const next = new Set(prev);
      next.add(section);
      return next;
    });
  }, [section]);

  const refreshingRef = useRef(false);
  const failStreakRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const rangeRef = useRef<ChangeRangeKey>("24h");
  const flowRangeRef = useRef<FlowRangeKey>("24h");
  const flowMinRef = useRef(30);
  const lastFullRef = useRef(Date.now());
  const [clockNow, setClockNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const applyPayload = useCallback((json: PortfolioPayload) => {
    // 快速刷新接口为了省 CPU 返回的 snapshots 是空数组；不能用它覆盖已有历史，否则趋势图变空。
    setData((prev) => {
      const next =
        (!json.snapshots || json.snapshots.length === 0) && prev?.snapshots?.length
          ? { ...json, snapshots: prev.snapshots, snapshotCount: prev.snapshotCount ?? json.snapshotCount }
          : json;
      setCachedPortfolio(next);
      return next;
    });
    if (json.usdCnyRate != null) setRateDraft(String(json.usdCnyRate));
    setError("");
  }, []);

  const load = useCallback(async () => {
    const cached = getCachedPortfolio();
    if (cached) {
      applyPayload(cached);
      setLoading(false);
    }
    try {
      const res = await fetch("/api/portfolio", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      const json: unknown = await res.json();
      // 非 2xx 或畸形 payload 绝不能 apply：否则 totals 等为 undefined 会触发 client exception
      if (!res.ok || !isPortfolioPayload(json)) {
        if (!getCachedPortfolio()) setError("加载失败");
        return;
      }
      applyPayload(json);
    } catch {
      if (!getCachedPortfolio()) setError("加载失败");
    } finally {
      setLoading(false);
    }
  }, [router, applyPayload]);

  const loadChanges = useCallback(
    async (nextRange: ChangeRangeKey) => {
      const cached = getCachedChanges(nextRange);
      if (cached) {
        setChanges(cached.summary);
        setProtocolPerf(cached.perf);
        setChangesLoading(false);
      } else {
        setChangesLoading(true);
      }
      try {
        const [res, perfRes] = await Promise.all([
          fetch(`/api/changes?range=${nextRange}`, { cache: "no-store" }),
          fetch(`/api/protocols?range=${nextRange}`, { cache: "no-store" }),
        ]);
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        let summary: ChangeSummary | null = null;
        let perf: ProtocolPerformanceSummary | null = cached?.perf ?? null;
        if (res.ok) {
          summary = (await res.json()) as ChangeSummary;
          if (mountedRef.current) setChanges(summary);
        }
        if (perfRes.ok) {
          perf = (await perfRes.json()) as ProtocolPerformanceSummary;
          if (mountedRef.current) setProtocolPerf(perf);
        }
        if (summary) setCachedChanges(nextRange, summary, perf);
      } catch {
        /* 保留上一次结果，不显示伪造的 0 */
      } finally {
        if (mountedRef.current) setChangesLoading(false);
      }
    },
    [router]
  );

  const loadFlows = useCallback(
    async (nextRange: FlowRangeKey, nextMin: number) => {
      const cached = getCachedFlows(nextRange, nextMin);
      if (cached) {
        setFlows(cached);
        setFlowsLoading(false);
      } else {
        setFlowsLoading(true);
      }
      try {
        const res = await fetch(`/api/flows?range=${nextRange}&min=${nextMin}`, { cache: "no-store" });
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        if (res.ok) {
          const json = (await res.json()) as FlowSummary;
          setCachedFlows(nextRange, nextMin, json);
          if (mountedRef.current) setFlows(json);
        }
      } catch {
        /* 保留上一次结果 */
      } finally {
        if (mountedRef.current) setFlowsLoading(false);
      }
    },
    [router]
  );

  const loadTransfers = useCallback(
    async (nextRange: FlowRangeKey) => {
      const cached = getCachedTransfers(nextRange);
      if (cached) {
        setTransfers(cached);
        setTransfersLoading(false);
      } else {
        setTransfersLoading(true);
      }
      try {
        const res = await fetch(`/api/transfers?range=${nextRange}&limit=80`, { cache: "no-store" });
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        if (res.ok) {
          const json = (await res.json()) as TransferSummary;
          setCachedTransfers(nextRange, json);
          if (mountedRef.current) setTransfers(json);
        }
      } catch {
        /* keep previous */
      } finally {
        if (mountedRef.current) setTransfersLoading(false);
      }
    },
    [router]
  );

  const quietRefresh = useCallback(
    async (mode: "fast" | "full" = "fast", manual = false) => {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      if (manual) setRefreshing(true);
      try {
        const res = await fetch(`/api/refresh?mode=${mode}`, { method: "POST" });
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        if (!res.ok) throw new Error("refresh_failed");
        const json: unknown = await res.json();
        if (!isPortfolioPayload(json)) throw new Error("refresh_invalid_payload");
        if (!mountedRef.current) return;
        applyPayload(json);
        if (!json.snapshots?.length) void load();
        failStreakRef.current = 0;
        if (mode === "full") lastFullRef.current = Date.now();
        void loadChanges(rangeRef.current);
        void loadFlows(flowRangeRef.current, flowMinRef.current);
        void loadTransfers(flowRangeRef.current);
      } catch {
        if (!mountedRef.current) return;
        failStreakRef.current += 1;
        if (manual) setError("刷新失败，界面保留上次成功数据");
      } finally {
        refreshingRef.current = false;
        if (manual) setRefreshing(false);
      }
    },
    [router, applyPayload, load, loadChanges, loadFlows, loadTransfers]
  );

  useEffect(() => {
    void load();
    // 打开页面只刷新交易所与快照。链上钱包由云端分批任务持续更新，
    // 避免浏览器每次打开都触发 25 个公共接口请求并在函数时限内超时。
    // 顶栏软切换若偶发 remount，新鲜缓存内跳过 POST，避免重复卡顿。
    if (!mountedRef.current) mountedRef.current = true;
    if (!isPortfolioFresh(30_000)) {
      void quietRefresh("fast", false);
    }
  }, [load, quietRefresh]);

  useEffect(() => {
    rangeRef.current = range;
    void loadChanges(range);
  }, [range, loadChanges]);

  useEffect(() => {
    flowRangeRef.current = flowRange;
    flowMinRef.current = flowMin;
    void loadFlows(flowRange, flowMin);
    void loadTransfers(flowRange);
  }, [flowRange, flowMin, loadFlows, loadTransfers]);

  useEffect(() => {
    mountedRef.current = true;
    const schedule = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const streak = failStreakRef.current;
      const delay =
        streak === 0 ? AUTO_TICK_MS : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, streak - 1));
      timerRef.current = setTimeout(async () => {
        // 后台每 5 分钟只刷交易所+快照；钱包余额由云端调度器每 10 分钟滚动刷新
        await quietRefresh("fast", false);
        if (mountedRef.current) schedule();
      }, delay);
    };
    schedule();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [quietRefresh]);



  async function saveRate(value?: string) {
    const rateNum = Number(value ?? rateDraft);
    if (!Number.isFinite(rateNum) || rateNum <= 0) return;
    setRateSaving(true);
    try {
      const res = await fetch("/api/rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usdCnyRate: rateNum }),
      });
      const json = await res.json();
      if (res.ok) {
        setData((prev) =>
          prev
            ? {
                ...prev,
                usdCnyRate: json.usdCnyRate,
                manual: Array.isArray(json.manual) ? json.manual : prev.manual,
                totals: json.totals ?? prev.totals,
              }
            : prev
        );
        setRateDraft(String(json.usdCnyRate));
      }
    } finally {
      setRateSaving(false);
    }
  }

  async function exportCsv(type: "wallets" | "dapps") {
    setExporting(type);
    try {
      const res = await fetch(`/api/export?type=${type}`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `asset-monitor-${type}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting("");
    }
  }

  const breakdown = data?.onchainBreakdown ?? null;
  const chains = useMemo(() => breakdown?.chains ?? [], [breakdown]);
  // 链卡片动态可见性：主列表为 ≥50 U；1–50 U 折叠；<1 U 永不显示。
  const mainChains = useMemo(() => chains.filter((chain) => chain.valueUsd >= 50), [chains]);
  const smallChains = useMemo(
    () => chains.filter((chain) => chain.valueUsd >= 1 && chain.valueUsd < 50),
    [chains]
  );
  const displayedChains = useMemo(
    () => (smallChainsOpen ? [...mainChains, ...smallChains] : mainChains),
    [mainChains, smallChains, smallChainsOpen]
  );

  if (loading || !data) {
    return (
      <main className="page">
        <div className="container" style={{ paddingTop: 80 }}>
          <div className="skeleton" style={{ height: 40, width: 260 }} />
          <div className="skeleton" style={{ height: 160, marginTop: 20 }} />
          <div className="skeleton" style={{ height: 220, marginTop: 20 }} />
          <div className="muted" style={{ marginTop: 16 }}>
            {error || "加载中…"}
          </div>
        </div>
      </main>
    );
  }

  const { totals, exchanges, wallets, manual, snapshots, usdCnyRate, lastRefresh } = data;
  const rate = usdCnyRate || 6.66;
  const freshness = walletFreshness(activeRefreshWallets(wallets ?? []), clockNow);
  const partial = breakdown?.partial === true;
  const dapps = breakdown?.dapps ?? [];
  const onchainUsd = totals.onchainUsd || chains.reduce((sum, chain) => sum + chain.valueUsd, 0);
  const usdtAssets = Math.round((onchainUsd + (totals.cexUsd || 0) + sumManualCryptoUsd(manual, rate)) * 100) / 100;
  const cnyAssets = sumManualCnyNative(manual);
  const totalAssetsUsd = Math.round((Number(totals.totalUsd) || usdtAssets + (rate > 0 ? cnyAssets / rate : 0)) * 100) / 100;
  return (
    <main className="page">
      <header className="topbar">
        <div className="container topbar-inner">
          <div className="topbar-actions">
            <span className="small">快照 {timeAgo(lastRefresh)}</span>
            <button
              type="button"
              className="btn btn-accent"
              onClick={() => quietRefresh("fast", true)}
              disabled={refreshing}
              title="立即刷新三家交易所并读取云端最近的钱包结果"
            >
              {refreshing ? "刷新中…" : "刷新数据"}
            </button>
          </div>
        </div>
      </header>

      <div className="container page-scroll" id="top">
        {mountedSections.has("overview") && (
          <div hidden={section !== "overview"} className={section === "overview" ? "overview-root" : "overview-root dash-pane-hidden"}>
            <div className="overview-duo">
              <section className="summary-panel overview-summary">
                <span className="avatar" aria-hidden="true">0x</span>
                <div className="stats">
                  <div>
                    <div className="stat-label">链上资产</div>
                    <div className="stat-value num">{usd(totals.onchainUsd)}</div>
                  </div>
                  <div>
                    <div className="stat-label">交易所资产</div>
                    <div className="stat-value num">{usd(totals.cexUsd)}</div>
                  </div>
                  <div>
                    <div className="stat-label">手动资产</div>
                    <div className="stat-value num">{usd(totals.manualUsd)}</div>
                  </div>
                  <div>
                    <div className="stat-label">DApp 协议</div>
                    <div className="stat-value num">{dapps.length}</div>
                  </div>
                  <div>
                    <div className="stat-label">地址上限</div>
                    <div className="stat-value num">{wallets.length}/50</div>
                  </div>
                </div>
                <div className="profile-right">
                  <div className="profile-status">
                    <span
                      className={`tag ${
                        error || data.refreshStatus === "failed" ? "neg" : freshness.stale || partial ? "warn" : "pos"
                      }`}
                    >
                      {error || data.refreshStatus === "failed"
                        ? "数据获取失败"
                        : freshness.stale
                          ? `${freshness.stale} 个钱包超过5分钟未更新`
                          : partial
                            ? "钱包已更新 · 部分明细待核验"
                            : `钱包已更新 ${freshness.fresh}/${freshness.total}`}
                    </span>
                    <span className="small">
                      {rateSaving
                        ? "汇率保存中…"
                        : `最旧钱包：${Number.isFinite(freshness.oldestAgeMs) ? `${Math.ceil(freshness.oldestAgeMs / 60_000)}分钟前` : "尚无成功记录"}`}
                    </span>
                  </div>
                  <div className="networth-trio">
                    <div className="networth-col">
                      <div className="summary-label">总资产</div>
                      <div className="networth-value num">{usd(totalAssetsUsd)}</div>
                      <div className="small num">{cny(totalAssetsUsd * rate)}</div>
                    </div>
                    <div className="networth-col">
                      <div className="summary-label">USDT资产</div>
                      <div className="networth-value num">{usd(usdtAssets)}</div>
                      <div className="small num">{cny(usdtAssets * rate)}</div>
                    </div>
                    <div className="networth-col">
                      <div className="summary-label">CNY资产</div>
                      <div className="networth-value networth-cny num">{cny(cnyAssets)}</div>
                    </div>
                  </div>
                  <div className="networth-rate">
                    <label htmlFor="usd-cny-rate">USD/CNY</label>
                    <input
                      id="usd-cny-rate"
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={rateDraft}
                      onChange={(event) => setRateDraft(event.target.value)}
                      onBlur={() => saveRate()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                  </div>
                </div>
              </section>

              <PortfolioChart
                snapshots={snapshots}
                usdCnyRate={rate}
                range={range}
                summary={changes}
                onRangeChange={setRange}
              />

              <FlowSection
                summary={flows}
                transfers={transfers}
                loading={flowsLoading || transfersLoading}
                range={flowRange}
                minUsd={flowMin}
                onRangeChange={setFlowRange}
                onMinChange={setFlowMin}
              />
            </div>

            <section className="section" id="chains">
              <div className="section-head">
                <div className="section-title">
                  <h2>链上分布</h2>
                  <span className="hint">
                    {displayedChains.length} 条链
                    {smallChains.length ? ` · ${smallChains.length} 条小额链${smallChainsOpen ? "已展开" : "已收起"}` : ""}
                  </span>
                </div>
                <span className="section-total num">{usd(onchainUsd)}</span>
              </div>
              {displayedChains.length || smallChains.length ? (
                <div className="chain-strip">
                  <button
                    type="button"
                    className={`chain-card${chainFilter === "all" ? " active" : ""}`}
                    style={{ ["--chain-color" as string]: "#b3bcd2" }}
                    onClick={() => setChainFilter("all")}
                  >
                    <span className="icon-fallback">ALL</span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span className="name" style={{ display: "block" }}>全部链</span>
                      <span className="value num" style={{ display: "block" }}>{usd(onchainUsd)}</span>
                    </span>
                  </button>
                  {displayedChains.map((chain) => (
                    <button
                      key={chain.id}
                      type="button"
                      className={`chain-card${chainFilter === chain.id ? " active" : ""}`}
                      style={{ ["--chain-color" as string]: CHAIN_COLOR[chain.id] || "#b3bcd2" }}
                      onClick={() => setChainFilter(chainFilter === chain.id ? "all" : chain.id)}
                    >
                      <ChainIcon chain={chain} />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span className="name" style={{ display: "block" }}>
                          {chain.name === "Robinhood Chain" ? "Robinhood" : chain.name}
                        </span>
                        <span className="value num" style={{ display: "block" }}>{usd(chain.valueUsd)}</span>
                      </span>
                    </button>
                  ))}
                  {smallChains.length > 0 && (
                    <button
                      type="button"
                      className="chain-dust-card"
                      onClick={() => setSmallChainsOpen((open) => !open)}
                      aria-expanded={smallChainsOpen}
                    >
                      <span className="icon-fallback">⋯</span>
                      <span>
                        <span className="name">小额链 {smallChains.length} 条</span>
                        <span className="value num">每条 1–50 USDT · {smallChainsOpen ? "点击收起" : "点击展开"}</span>
                      </span>
                    </button>
                  )}
                </div>
              ) : (
                <div className="empty">还没有链上明细：点击右上角刷新获取</div>
              )}
            </section>

            <ChangeSection
              range={range}
              summary={changes}
              loading={changesLoading}
              onRangeChange={setRange}
            />
          </div>
        )}

        {mountedSections.has("tokens") && (
          <div
            hidden={section !== "tokens"}
            className={section === "tokens" ? "page-pane" : "page-pane dash-pane-hidden"}
          >
            <section className="section section-compact" id="chains">
              <div className="section-head">
                <div className="section-title">
                  <h2>链筛选</h2>
                  <span className="hint">点击链卡片筛选下方代币</span>
                </div>
                <span className="section-total num">{usd(onchainUsd)}</span>
              </div>
              {displayedChains.length || smallChains.length ? (
                <div className="chain-strip">
                  <button
                    type="button"
                    className={`chain-card${chainFilter === "all" ? " active" : ""}`}
                    style={{ ["--chain-color" as string]: "#b3bcd2" }}
                    onClick={() => setChainFilter("all")}
                  >
                    <span className="icon-fallback">ALL</span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span className="name" style={{ display: "block" }}>全部链</span>
                      <span className="value num" style={{ display: "block" }}>{usd(onchainUsd)}</span>
                    </span>
                  </button>
                  {displayedChains.map((chain) => (
                    <button
                      key={chain.id}
                      type="button"
                      className={`chain-card${chainFilter === chain.id ? " active" : ""}`}
                      style={{ ["--chain-color" as string]: CHAIN_COLOR[chain.id] || "#b3bcd2" }}
                      onClick={() => setChainFilter(chainFilter === chain.id ? "all" : chain.id)}
                    >
                      <ChainIcon chain={chain} />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span className="name" style={{ display: "block" }}>
                          {chain.name === "Robinhood Chain" ? "Robinhood" : chain.name}
                        </span>
                        <span className="value num" style={{ display: "block" }}>{usd(chain.valueUsd)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty">还没有链上明细：点击右上角刷新获取</div>
              )}
            </section>
            <TokenTable
              tokens={breakdown?.tokens ?? []}
              onchainUsd={onchainUsd}
              chainFilter={chainFilter}
              partial={partial}
              tokenSource={breakdown?.tokenSource}
              tokenAudit={breakdown?.tokenAudit}
              now={clockNow}
            />
          </div>
        )}

        {mountedSections.has("defi") && (
          <div
            hidden={section !== "defi"}
            className={section === "defi" ? "page-pane page-pane-defi" : "page-pane page-pane-defi dash-pane-hidden"}
          >
            <ProtocolSections
              dapps={dapps}
              perf={protocolPerf}
              range={range}
              onRangeChange={setRange}
            />
          </div>
        )}

        {mountedSections.has("exchanges") && (
          <div
            hidden={section !== "exchanges"}
            className={
              section === "exchanges"
                ? "page-pane page-pane-exchanges"
                : "page-pane page-pane-exchanges dash-pane-hidden"
            }
          >
            <ExchangeSection
              exchanges={exchanges}
              totalUsd={totals.cexUsd}
              range={range}
              changes={changes}
              onRangeChange={setRange}
            />
            <ChangeSection
              range={range}
              summary={changes}
              loading={changesLoading}
              onRangeChange={setRange}
            />
          </div>
        )}

        {mountedSections.has("manual") && (
          <div
            hidden={section !== "manual"}
            className={
              section === "manual" ? "page-pane page-pane-manual" : "page-pane page-pane-manual dash-pane-hidden"
            }
          >
            <ManualAssets
              items={manual}
              usdCnyRate={rate}
              onChange={(next) =>
                setData((prev) => {
                  if (!prev) return prev;
                  const fx = prev.usdCnyRate || 6.66;
                  const manualUsd = next.reduce((sum, item) => sum + manualToUsd(item, fx), 0);
                  return {
                    ...prev,
                    manual: next,
                    totals: {
                      ...prev.totals,
                      manualUsd,
                      totalUsd: manualUsd + prev.totals.onchainUsd + prev.totals.cexUsd,
                    },
                  };
                })
              }
            />
            <section className="section section-compact" id="export">
              <div className="section-head">
                <div className="section-title">
                  <h2>导出</h2>
                  <span className="hint">导出当前展示的数据，不含任何密钥、密码或会话信息</span>
                </div>
                <div className="inline">
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={exporting !== ""}
                    onClick={() => exportCsv("wallets")}
                  >
                    {exporting === "wallets" ? "导出中…" : "钱包 CSV"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={exporting !== ""}
                    onClick={() => exportCsv("dapps")}
                  >
                    {exporting === "dapps" ? "导出中…" : "DApp 明细 CSV"}
                  </button>
                </div>
              </div>
              <div className="notice notice-stack">
                <p>DApp 明细单独导出一个文件，是为避免把「钱包余额」和「协议仓位」再相加（协议仓位本来就包含在钱包余额里）</p>
                <p>
                  历史快照目前 {data.snapshotCount ?? snapshots.length} / {data.snapshotLimit ?? 2016} 条：最近 24 小时每分钟一条，更早的压成每 5 分钟一条，覆盖 7 天，超过自动删除
                </p>
              </div>
            </section>
          </div>
        )}

        {mountedSections.has("addresses") && (
          <div hidden={section !== "addresses"} className={section === "addresses" ? undefined : "dash-pane-hidden"}>
            <WalletsTable
              wallets={wallets}
              onChange={(next) =>
                setData((prev) => {
                  if (!prev) return prev;
                  const round2 = (value: number) => Math.round(value * 100) / 100;
                  const active = activeRefreshWallets(next);
                  const onchain = round2(active.reduce((sum, wallet) => sum + wallet.balanceUsd, 0));
                  return {
                    ...prev,
                    wallets: next,
                    totals: {
                      ...prev.totals,
                      onchainUsd: onchain,
                      evmUsd: round2(
                        active.filter((wallet) => wallet.chain === "EVM").reduce((sum, wallet) => sum + wallet.balanceUsd, 0)
                      ),
                      abstractUsd: round2(
                        next
                          .filter((wallet) => wallet.chain === "ABSTRACT")
                          .reduce((sum, wallet) => sum + wallet.balanceUsd, 0)
                      ),
                      totalUsd: round2(prev.totals.manualUsd + onchain + prev.totals.cexUsd),
                    },
                  };
                })
              }
            />
          </div>
        )}

        <footer className="table-foot" style={{ paddingLeft: 0, paddingRight: 0 }}>
          <span>链上：DeBank（服务端缓存）· 交易所：官方只读 API</span>
          <span>密钥不下发浏览器 · 失败保留上次成功数据，绝不归零</span>
        </footer>
      </div>
    </main>
  );
}
