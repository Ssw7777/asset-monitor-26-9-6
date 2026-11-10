"use client";

import { useMemo, useState } from "react";
import type { ChangeRangeKey, ChangeRow, ChangeSummary } from "@/lib/changes";
import { CHANGE_RANGES } from "@/lib/changes";
import { deltaClass, signedPct, signedUsd, timeAgo, usd } from "./format";

const TYPE_LABEL: Record<string, string> = {
  onchain: "链上",
  exchange: "交易所",
  dapp: "DApp",
  wallet: "钱包",
  manual: "手动",
};

const STATUS_LABEL: Record<string, string> = {
  live: "实时",
  cached: "上次成功数据",
  error: "读取失败",
  baseline: "基线数据",
  manual: "手动记录",
};

const PAGE_SIZE = 15;

type ChangeSortKey = "before" | "after" | "change";
type ChangeSortDir = "desc" | "asc";

/** 一个可翻页的变动表（钱包 / 交易所各一张，长期快照最多 7 天）。列头可按 USD 数值排序。 */
function ChangeTable({
  title,
  hint,
  rows,
  emptyText,
}: {
  title: string;
  hint: string;
  rows: ChangeRow[];
  emptyText: string;
}) {
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<ChangeSortKey | null>(null);
  const [sortDir, setSortDir] = useState<ChangeSortDir>("desc");

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const mul = sortDir === "desc" ? -1 : 1;
    return [...rows].sort((left, right) => {
      const diff = (left[sortKey] - right[sortKey]) * mul;
      if (diff !== 0) return diff;
      return Math.abs(right.change) - Math.abs(left.change);
    });
  }, [rows, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const slice = useMemo(
    () => sortedRows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [sortedRows, safePage]
  );
  const total = rows.reduce((sum, row) => sum + row.change, 0);

  function toggleSort(key: ChangeSortKey) {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc"); // 首次点击：从高到低
    }
    setPage(0);
  }

  function sortLabel(key: ChangeSortKey, label: string) {
    const active = sortKey === key;
    const mark = active ? (sortDir === "desc" ? "↓" : "↑") : "";
    return (
      <button
        type="button"
        className={`th-sort${active ? " active" : ""}`}
        onClick={() => toggleSort(key)}
        aria-label={`按${label}排序`}
        title={active ? (sortDir === "desc" ? "当前：从高到低，再点切换升序" : "当前：从低到高，再点切换降序") : "点击按从高到低排序"}
      >
        {label}
        {mark ? <span className="th-sort-mark" aria-hidden="true">{mark}</span> : null}
      </button>
    );
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div className="section-head" style={{ paddingBottom: 8 }}>
        <div className="section-title">
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h3>
          <span className="hint">
            {hint} · 共 {rows.length} 条
            {sortKey ? ` · 按${sortKey === "before" ? "前值" : sortKey === "after" ? "现值" : "变化"}${sortDir === "desc" ? "降序" : "升序"}` : ""}
          </span>
        </div>
        <span className={`section-total num ${deltaClass(total)}`}>{signedUsd(total)}</span>
      </div>

      {rows.length ? (
        <div className="table">
          <div className="thead grid-change">
            <div>来源</div>
            <div className="right hide-md">{sortLabel("before", "前值")}</div>
            <div className="right hide-md">{sortLabel("after", "现值")}</div>
            <div className="right">{sortLabel("change", "变化")}</div>
            <div className="right hide-md">更新时间 / 状态</div>
          </div>
          {slice.map((row) => (
            <div className="trow grid-change" key={`${title}-${row.key}`}>
              <div className="cell-token-text">
                <b>
                  <span className="tag line" style={{ marginRight: 6 }}>
                    {TYPE_LABEL[row.type] || row.type}
                  </span>
                  {row.label}
                </b>
                <span>{row.detail}</span>
              </div>
              <div className="right cell-main num hide-md">{usd(row.before)}</div>
              <div className="right cell-main num hide-md">{usd(row.after)}</div>
              <div className={`right num ${deltaClass(row.change)}`}>
                <div className="cell-main">{signedUsd(row.change)}</div>
                <div className="cell-sub">{signedPct(row.pct)}</div>
              </div>
              <div className="right hide-md">
                <div className="cell-sub">{timeAgo(row.updatedAt)}</div>
                <div className={`cell-sub ${row.dataStatus === "live" ? "pos" : ""}`}>
                  {STATUS_LABEL[row.dataStatus] || row.dataStatus}
                </div>
              </div>
            </div>
          ))}
          {pageCount > 1 && (
            <div className="pager">
              <button
                type="button"
                className="btn btn-outline !min-h-[32px]"
                disabled={safePage === 0}
                onClick={() => setPage(Math.max(0, safePage - 1))}
              >
                上一页
              </button>
              <span className="small num">
                第 {safePage + 1} / {pageCount} 页
              </span>
              <button
                type="button"
                className="btn btn-outline !min-h-[32px]"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
              >
                下一页
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="empty">{emptyText}</div>
      )}
    </div>
  );
}

/** 资产变动：钱包与交易所分成两个独立窗口，各自可翻页查看 7 天内的长期快照。
 *  compact：总览一屏用，只展示合计与分栏摘要，明细在交易所页。 */
export function ChangeSection({
  range,
  summary,
  loading,
  onRangeChange,
  compact = false,
}: {
  range: ChangeRangeKey;
  summary: ChangeSummary | null;
  loading: boolean;
  onRangeChange: (range: ChangeRangeKey) => void;
  compact?: boolean;
}) {
  const total = summary?.total ?? null;
  const rows = summary?.rows ?? [];
  const walletRows = rows.filter((row) => row.type !== "exchange");
  const exchangeRows = rows.filter((row) => row.type === "exchange");
  const walletDelta = walletRows.reduce((sum, row) => sum + row.change, 0);
  const exchangeDelta = exchangeRows.reduce((sum, row) => sum + row.change, 0);

  return (
    <section className={`section section-asset-changes${compact ? " section-compact overview-change-section" : ""}`} id="changes">
      <div className="section-head">
        <div className="section-title">
          <h2>资产变动</h2>
          <span className="hint">
            {loading
              ? "计算中…"
              : total
                ? `对比 ${summary!.from ? new Date(summary!.from.ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"} → ${summary!.to ? new Date(summary!.to.ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}`
                : summary?.reason || "暂无对比数据"}
          </span>
        </div>
        <div className="inline">
          {total && (
            <span className={`section-total num ${deltaClass(total.change)}`}>
              {signedUsd(total.change)} · {signedPct(total.pct)}
            </span>
          )}
          <span className="seg">
            {CHANGE_RANGES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={range === item.key ? "active" : ""}
                onClick={() => onRangeChange(item.key)}
              >
                {compact ? item.short : item.label}
              </button>
            ))}
          </span>
        </div>
      </div>

      {summary && !summary.enoughData && (
        <div className="notice warn" style={{ marginBottom: 10 }}>
          {summary.reason}
          {summary.partial ? " · 部分数据使用上次成功记录" : ""}
        </div>
      )}

      {compact ? (
        <div className="overview-change-grid">
          <div className="overview-change-card">
            <span className="hint">钱包变动</span>
            <strong className={`num ${deltaClass(walletDelta)}`}>{signedUsd(walletDelta)}</strong>
            <span className="small">{walletRows.length} 条 · 链上 + 手动</span>
          </div>
          <div className="overview-change-card">
            <span className="hint">交易所变动</span>
            <strong className={`num ${deltaClass(exchangeDelta)}`}>{signedUsd(exchangeDelta)}</strong>
            <span className="small">{exchangeRows.length} 条 · OKX / Binance / Gate / Bitget</span>
          </div>
          <div className="overview-change-card">
            <span className="hint">涨跌统计</span>
            <strong className="num">
              {summary?.upCount ?? 0}↑ · {summary?.downCount ?? 0}↓
            </strong>
            <span className="small">明细见「交易所」页</span>
          </div>
        </div>
      ) : (
        <>
          <ChangeTable
            title="钱包变动"
            hint="链上地址 + 手动资产"
            rows={walletRows}
            emptyText={loading ? "计算中…" : "该区间内钱包没有可归因的变化"}
          />
          <ChangeTable
            title="交易所变动"
            hint="OKX / Binance / Gate / Bitget"
            rows={exchangeRows}
            emptyText={loading ? "计算中…" : "该区间内交易所没有可归因的变化"}
          />
          <div className="table-foot" style={{ paddingLeft: 0, paddingRight: 0 }}>
            <span>
              {summary?.upCount ?? 0} 个上涨 · {summary?.downCount ?? 0} 个下降
              {summary?.dustCount ? `（${summary.dustCount} 条低于 ${summary.minUsd} USDT 已折叠）` : ""}
            </span>
            <span>波动包含链上 + 三家交易所 + 手动资产 · 快照保留 7 天</span>
          </div>
        </>
      )}
    </section>
  );
}
