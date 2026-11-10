"use client";

import { useState } from "react";
import type { ManualAsset } from "@/lib/types";
import {
  manualNativeAmount,
  manualToUsd,
  type ManualCurrency,
} from "@/lib/manual-assets";
import { cny, timeAgo, usd } from "./format";

/** 手动资产：可按 USDT / 人民币记账，改动即时并入总额与历史快照。 */
export function ManualAssets({
  items,
  usdCnyRate = 6.66,
  onChange,
}: {
  items: ManualAsset[];
  usdCnyRate?: number;
  onChange: (manual: ManualAsset[]) => void;
}) {
  const [saving, setSaving] = useState(false);
  const rate = usdCnyRate > 0 ? usdCnyRate : 6.66;
  const total = items.reduce((sum, item) => sum + manualToUsd(item, rate), 0);

  async function save(item: ManualAsset) {
    setSaving(true);
    try {
      const res = await fetch("/api/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      });
      const data = await res.json();
      if (res.ok) onChange(data.manual);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("确认删除这条手动资产？删除后立即重新计算总额。")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/manual?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (res.ok) onChange(data.manual);
    } finally {
      setSaving(false);
    }
  }

  function add() {
    void save({
      id: `m_${Date.now()}`,
      name: "新资产",
      currency: "USD",
      amount: 0,
      amountUsd: 0,
      updatedAt: new Date().toISOString(),
    });
  }

  function patchLocal(id: string, patch: Partial<ManualAsset>) {
    onChange(
      items.map((item) => {
        if (item.id !== id) return item;
        const next = { ...item, ...patch };
        const currency = (next.currency === "CNY" ? "CNY" : "USD") as ManualCurrency;
        const native = manualNativeAmount(next);
        if (currency === "CNY") {
          return {
            ...next,
            currency,
            amount: native,
            amountUsd: Math.round((native / rate) * 100) / 100,
          };
        }
        return {
          ...next,
          currency: "USD" as const,
          amount: native,
          amountUsd: native,
        };
      })
    );
  }

  function switchCurrency(item: ManualAsset, currency: ManualCurrency) {
    const current = (item.currency === "CNY" ? "CNY" : "USD") as ManualCurrency;
    if (current === currency) return;
    // 换单位时保持折合 USDT 不变，本币按当前汇率换算。
    const usdValue = manualToUsd(item, rate);
    const native = currency === "CNY" ? Math.round(usdValue * rate * 100) / 100 : usdValue;
    const next: ManualAsset = {
      ...item,
      currency,
      amount: native,
      amountUsd: usdValue,
      updatedAt: new Date().toISOString(),
    };
    patchLocal(item.id, next);
    void save(next);
  }

  return (
    <section className="section" id="manual">
      <div className="section-head">
        <div className="section-title">
          <h2>手动资产</h2>
          <span className="hint">支持 USDT / 人民币；人民币按上方 USD/CNY 汇率折算入总额</span>
        </div>
        <div className="inline">
          <span className="section-total num">{usd(total)}</span>
          <button type="button" className="btn btn-accent" onClick={add} disabled={saving}>
            + 添加
          </button>
        </div>
      </div>

      <div className="table">
        <div className="thead grid-manual">
          <div>用途</div>
          <div className="right">金额</div>
          <div>单位</div>
          <div className="right">操作</div>
        </div>
        {items.map((item) => {
          const currency = (item.currency === "CNY" ? "CNY" : "USD") as ManualCurrency;
          const native = manualNativeAmount(item);
          const asUsd = manualToUsd(item, rate);
          return (
            <div className="trow grid-manual" key={item.id}>
              <input
                className="field"
                aria-label="用途"
                value={item.name}
                onChange={(event) => patchLocal(item.id, { name: event.target.value })}
                onBlur={() =>
                  save({
                    ...item,
                    currency,
                    amount: native,
                    amountUsd: asUsd,
                    updatedAt: new Date().toISOString(),
                  })
                }
              />
              <input
                className="field num"
                style={{ textAlign: "right" }}
                type="number"
                inputMode="decimal"
                aria-label={currency === "CNY" ? "金额（人民币）" : "金额（USDT）"}
                value={native}
                onChange={(event) =>
                  patchLocal(item.id, {
                    currency,
                    amount: Number(event.target.value),
                  })
                }
                onBlur={() => {
                  const amount = native;
                  const amountUsd =
                    currency === "CNY"
                      ? Math.round((amount / rate) * 100) / 100
                      : amount;
                  void save({
                    ...item,
                    currency,
                    amount,
                    amountUsd,
                    updatedAt: new Date().toISOString(),
                  });
                }}
              />
              <select
                className="field manual-currency"
                aria-label="单位"
                value={currency}
                onChange={(event) =>
                  switchCurrency(item, event.target.value === "CNY" ? "CNY" : "USD")
                }
              >
                <option value="USD">USDT</option>
                <option value="CNY">人民币</option>
              </select>
              <div className="right">
                <button type="button" className="btn-mini danger" onClick={() => remove(item.id)}>
                  删除
                </button>
              </div>
              <div className="cell-sub" style={{ gridColumn: "1 / -1" }}>
                {currency === "CNY" ? (
                  <>
                    ≈ {usd(asUsd)} · 汇率 {rate} · 更新于 {timeAgo(item.updatedAt)}
                  </>
                ) : (
                  <>更新于 {timeAgo(item.updatedAt)}</>
                )}
                {currency === "CNY" ? (
                  <span className="manual-cny-hint"> · 本币 {cny(native)}</span>
                ) : null}
              </div>
            </div>
          );
        })}
        {!items.length && (
          <div className="trow" style={{ gridTemplateColumns: "1fr" }}>
            <div className="empty">暂无手动资产，点击「+ 添加」记录</div>
          </div>
        )}
      </div>
      <div className="table-foot">
        <span>{saving ? "保存中…" : "修改后自动保存"}</span>
        <span>{items.length} 条记录</span>
      </div>
    </section>
  );
}
