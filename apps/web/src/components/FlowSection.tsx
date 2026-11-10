"use client";

import type { FlowEvent, FlowRangeKey, FlowSummary } from "@/lib/flows";
import { FLOW_RANGES } from "@/lib/flows";
import type { TransferLine, TransferSummary } from "@/lib/transfers";
import { useEffect, useMemo, useState } from "react";
import { amountNum, shortAddr, timeAgo, usd } from "./format";

const DIRECTION: Record<FlowEvent["direction"], { cls: string }> = {
  in: { cls: "pos" },
  out: { cls: "neg" },
  transfer: { cls: "" },
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
  });
}

type Row =
  | { kind: "flow"; id: string; ts: string; event: FlowEvent }
  | { kind: "transfer"; id: string; ts: string; line: TransferLine };

/**
 * 资金变动流水：余额估值变动和链上转入/转出在同一张卡片里。
 * 净额只统计估值变动，避免和链上转账重复相加。
 */
export function FlowSection({
  summary,
  transfers,
  loading,
  range,
  minUsd,
  onRangeChange,
  onMinChange,
}: {
  summary: FlowSummary | null;
  transfers: TransferSummary | null;
  loading: boolean;
  range: FlowRangeKey;
  minUsd: number;
  onRangeChange: (range: FlowRangeKey) => void;
  onMinChange: (min: number) => void;
}) {
  const net = summary?.netUsd ?? 0;
  const rows = useMemo<Row[]>(() => {
    const events = summary?.events ?? [];
    const lines = transfers?.lines ?? [];
    const merged: Row[] = [
      ...events.map((event) => ({ kind: "flow" as const, id: `flow:${event.id}`, ts: event.ts, event })),
      ...lines.map((line) => ({ kind: "transfer" as const, id: `xfer:${line.id}`, ts: line.ts, line })),
    ];
    merged.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return merged;
  }, [summary, transfers]);
  const events = summary?.events ?? [];
  const lines = transfers?.lines ?? [];
  const [page, setPage] = useState(0);
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  useEffect(() => setPage(0), [range, minUsd, transfers?.generatedAt]);

  return (
    <section className="section section-surface section-flows" id="flows">
      <div className="section-head">
        <div className="section-title">
          <h2 title="同一列表里有余额估值变动和链上转入/转出。净额只算估值，不算转账。">资金变动流水</h2>
          <strong className={`flow-net num ${net >= 0 ? "pos" : "neg"}`}>
            {net > 0 ? "+" : net < 0 ? "-" : ""}
            {usd(Math.abs(net))}
          </strong>
        </div>
        <div className="inline">
          <span className="seg">
            {FLOW_RANGES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={range === item.key ? "active" : ""}
                onClick={() => onRangeChange(item.key)}
              >
                {item.key === "all" ? "全部" : item.key}
              </button>
            ))}
          </span>
          <span className="seg">
            {[1, 30, 100, 500].map((value) => (
              <button
                key={value}
                type="button"
                className={minUsd === value ? "active" : ""}
                onClick={() => onMinChange(value)}
              >
                ≥{value}U
              </button>
            ))}
          </span>
        </div>
      </div>
      <div className="flow-explanation">
        估值变动（≥{minUsd} U）与链上转入/转出（≥1 U）· 净额只统计估值 ·{" "}
        链上转入/转出流水
      </div>

      {rows.length ? (
        <div className="table">
          <div className="flow-scroll">
            <div className="thead grid-flow">
              <div>时间</div>
              <div>明细</div>
              <div className="right">变动</div>
              <div className="right">类型</div>
            </div>
            {visible.map((row) => {
              if (row.kind === "transfer") {
                const line = row.line;
                const spam = line.risk === "spam";
                const detail = spam
                  ? `${line.chain} · ${line.counterparty} · ${line.quantity} ${line.symbol} · 不计估值`
                  : `${line.chain} · ${line.counterparty}${
                      line.valueUsd == null || line.valueUsd <= 0
                        ? ""
                        : ` · ${line.quantity} ${line.symbol}`
                    }`;
                const amountNode = spam ? (
                  <span className="flow-spam-amount">钓鱼 $0</span>
                ) : line.valueUsd == null ? (
                  <span className="flow-unpriced">未定价</span>
                ) : (
                  <>
                    {line.direction === "in" ? "+" : "-"}
                    {usd(line.valueUsd)}
                  </>
                );
                return (
                  <div className={`trow grid-flow${spam ? " flow-spam-row" : ""}`} key={row.id}>
                    <div className="flow-time cell-token-text">
                      <b>{formatTime(line.ts)}</b>
                      <span>{timeAgo(line.ts)}</span>
                    </div>
                    <div className="flow-detail cell-token-text">
                      <b title={line.summary}>{line.summary}</b>
                      <span title={detail}>{detail}</span>
                    </div>
                    <div className={`flow-amount num ${spam ? "" : line.direction === "in" ? "pos" : "neg"}`}>
                      {amountNode}
                    </div>
                    <div className="flow-kind">
                      {spam ? (
                        <span className="flow-tag flow-tag-spam">钓鱼</span>
                      ) : (
                        <span className="flow-tag flow-tag-chain">链上</span>
                      )}
                    </div>
                  </div>
                );
              }
              const event = row.event;
              const direction = DIRECTION[event.direction] ?? DIRECTION.transfer;
              const who = event.entityAddress ? shortAddr(event.entityAddress) : "";
              const moved = `${amountNum(event.before)} → ${usd(event.after)}`;
              const detail = who ? `${moved} · ${who}` : moved;
              return (
                <div className="trow grid-flow" key={row.id}>
                  <div className="flow-time cell-token-text">
                    <b>{formatTime(event.ts)}</b>
                    <span>{timeAgo(event.ts)}</span>
                  </div>
                  <div className="flow-detail cell-token-text">
                    <b title={event.entityLabel}>{event.entityLabel}</b>
                    <span className="num" title={detail}>{detail}</span>
                  </div>
                  <div className={`flow-amount num ${direction.cls}`}>
                    {event.direction === "out" ? "-" : event.direction === "in" ? "+" : "±"}
                    {usd(event.amountUsd)}
                  </div>
                  <div className="flow-kind">
                    <span className="flow-tag flow-tag-value">估值</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="empty">
          {loading
            ? "读取中…"
            : `还没有超过 ${minUsd} U 的估值变动，也没有不低于 1 美元的链上转入/转出`}
        </div>
      )}
      <div className="flow-pagination">
        <span className="small">
          {currentPage + 1} / {pages} 页 · 估值 {events.length} 条 · 链上 {lines.length} 条
        </span>
        <div className="inline">
          <button className="btn btn-outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
          <button className="btn btn-outline" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>下一页</button>
        </div>
      </div>
    </section>
  );
}
