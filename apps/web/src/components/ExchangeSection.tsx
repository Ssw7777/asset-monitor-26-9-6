"use client";

import type { ExchangeBalance } from "@/lib/types";
import type { ChangeRangeKey, ChangeSummary } from "@/lib/changes";
import { CHANGE_RANGES } from "@/lib/changes";
import { exchangeIconId, exchangeLabel } from "@/lib/exchange-labels";
import { amountNum, deltaClass, signedPct, signedUsd, timeAgo, usd } from "./format";
import { TokenIcon } from "./TokenIcon";

function statusText(exchange: ExchangeBalance) {
  switch (exchange.status) {
    case "ok":
      return { text: `实时 · ${timeAgo(exchange.lastUpdated)}`, cls: "pos" };
    case "missing_keys":
      return { text: "未配置 API · 保留上次余额", cls: "" };
    case "missing_passphrase":
      return { text: "缺少 Passphrase · 保留上次余额", cls: "" };
    case "error":
      return { text: `读取失败 · 保留上次余额`, cls: "neg" };
    default:
      return { text: `基线数据 · ${timeAgo(exchange.lastUpdated)}`, cls: "" };
  }
}

/** 交易所板块：只读余额，一家失败不影响其它平台，也不影响链上数据。 */
export function ExchangeSection({
  exchanges,
  totalUsd,
  range,
  changes,
  onRangeChange,
}: {
  exchanges: ExchangeBalance[];
  totalUsd: number;
  range: ChangeRangeKey;
  changes: ChangeSummary | null;
  onRangeChange: (range: ChangeRangeKey) => void;
}) {
  const exchangeChanges = new Map(
    (changes?.rows ?? [])
      .filter((row) => row.type === "exchange")
      .map((row) => [row.key.replace("exchange:", ""), row])
  );
  const totalChange = [...exchangeChanges.values()].reduce((sum, row) => sum + row.change, 0);

  return (
    <section className="section section-surface section-exchanges" id="exchanges">
      <div className="section-head">
        <div className="section-title">
          <h2>交易所</h2>
          <span className="hint">OKX / Binance / Gate / Gate B / Gate C / Bitget · 只读 API，密钥仅服务端</span>
        </div>
        <span className="section-total num">{usd(totalUsd)}</span>
      </div>
      <div className="exchange-layout">
        <div className="table exchange-balance-table">
          <div className="thead exchange-balance-grid">
            <div>平台</div>
            <div className="right">余额</div>
            <div className="right hide-md">状态</div>
          </div>
          {exchanges.map((exchange) => {
            const status = statusText(exchange);
            const label = exchangeLabel(exchange.exchange);
            return (
              <div className="trow exchange-balance-grid" key={exchange.exchange}>
                <div className="cell-token">
                  <TokenIcon
                    symbol={label}
                    localSrc={`/icons/exchanges/${exchangeIconId(exchange.exchange)}.png`}
                    size={28}
                    shape="square"
                  />
                  <span className="cell-token-text">
                    <b>{label}</b>
                    <span>仅读取余额，无下单 / 提现权限</span>
                  </span>
                </div>
                <div className="right cell-main num">{usd(exchange.balanceUsd)}</div>
                <div className={`right cell-sub hide-md ${status.cls}`}>{status.text}</div>
              </div>
            );
          })}
        </div>

        <aside className="exchange-change-panel" aria-label="交易所资产变动">
          <div className="exchange-change-head">
            <div>
              <b>交易所资产变动</b>
              <span>{changes?.enoughData ? `对比 ${changes.rangeLabel}` : "历史积累中"}</span>
            </div>
            <strong className={`num ${deltaClass(totalChange)}`}>{signedUsd(totalChange)}</strong>
          </div>
          <div className="seg exchange-range">
            {CHANGE_RANGES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={range === item.key ? "active" : ""}
                onClick={() => onRangeChange(item.key)}
              >
                {item.short}
              </button>
            ))}
          </div>
          <div className="exchange-change-list">
            {exchanges.map((exchange) => {
              const row = exchangeChanges.get(exchange.exchange);
              return (
                <div className="exchange-change-row" key={`change-${exchange.exchange}`}>
                  <span>{exchangeLabel(exchange.exchange)}</span>
                  <span className="num exchange-change-balance">
                    {row ? `${amountNum(row.before)} → ${usd(row.after)}` : usd(exchange.balanceUsd)}
                  </span>
                  <b className={`num ${deltaClass(row?.change ?? 0)}`}>
                    {row ? `${signedUsd(row.change)} · ${signedPct(row.pct)}` : "—"}
                  </b>
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </section>
  );
}
