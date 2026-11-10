"use client";

import { useMemo } from "react";
import type { DappAllocation, DappWalletShare } from "@/lib/types";
import type { ProtocolPerformanceSummary } from "@/lib/protocols";
import type { ChangeRangeKey } from "@/lib/changes";
import { CHANGE_RANGES } from "@/lib/changes";
import { deltaClass, shortAddr, signedPct, signedUsd, usd } from "./format";
import { localChainIcon, TokenIcon } from "./TokenIcon";

function safeSiteUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function hostOf(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 链图标：本地已下载的图标优先，其次远端，最后字母标。 */
function ChainIcon({ id, name, size = 16 }: { id: string; name: string; size?: number }) {
  return (
    <TokenIcon
      symbol={name || id}
      localSrc={localChainIcon(id)}
      size={size}
      shape="square"
    />
  );
}

/** Token rows for asset or debt (rewards count as assets). */
function tokensOf(wallet: DappWalletShare, role: "asset" | "debt") {
  return (wallet.tokens ?? [])
    .filter((token) => (role === "asset" ? token.role !== "debt" : token.role === "debt"))
    .sort((left, right) => Math.abs(right.valueUsd) - Math.abs(left.valueUsd));
}

/** Compact symbol list for mobile meta line. */
function symbolsOf(wallet: DappWalletShare, role: "asset" | "debt") {
  const list = tokensOf(wallet, role);
  if (!list.length) return "—";
  const names = [...new Set(list.map((token) => token.symbol))];
  return names.slice(0, 4).join(" + ") + (names.length > 4 ? ` +${names.length - 4}` : "");
}

/** Asset / debt cell: USD total + per-token amount · value (not net-only). */
function PositionDetail({
  wallet,
  role,
}: {
  wallet: DappWalletShare;
  role: "asset" | "debt";
}) {
  const list = tokensOf(wallet, role);
  const total = role === "asset" ? wallet.assetUsd : wallet.debtUsd;
  const tone = role === "debt" && total > 0.01 ? "var(--neg)" : undefined;
  if (!list.length && total <= 0.01) {
    return <span style={{ color: "var(--ink-3)" }}>—</span>;
  }
  return (
    <div className="cell-token-text" style={{ color: tone }}>
      <b className="num">{usd(total)}</b>
      {list.slice(0, 4).map((token) => (
        <span key={`${token.role}-${token.symbol}-${token.amount}`}>
          {token.symbol}
          {Number.isFinite(token.amount) && Math.abs(token.amount) > 0
            ? ` ${token.amount >= 1000 ? token.amount.toFixed(2) : token.amount.toPrecision(4)}`
            : ""}
          {" · "}
          {usd(token.valueUsd)}
          {token.role === "reward" ? " (奖励)" : ""}
        </span>
      ))}
      {list.length > 4 ? <span>+{list.length - 4} 项</span> : null}
    </div>
  );
}

/** 净值（仓位 USD）低于此阈值的协议 / 钱包份额不展示。 */
const MIN_NET_USD = 10;

/** DeBank 的协议区块：协议头 + 各钱包份额表；净值低于 10 USDT 的协议 / 份额不展示。 */
export function ProtocolSections({
  dapps,
  perf,
  range,
  onRangeChange,
}: {
  dapps: DappAllocation[];
  perf?: ProtocolPerformanceSummary | null;
  range: ChangeRangeKey;
  onRangeChange: (range: ChangeRangeKey) => void;
}) {
  const perfByName = useMemo(() => {
    const map = new Map<string, ProtocolPerformanceSummary["items"][number]>();
    for (const item of perf?.items ?? []) map.set(item.name, item);
    return map;
  }, [perf]);

  const { visible, hiddenCount } = useMemo(() => {
    const list: DappAllocation[] = [];
    let hidden = 0;
    for (const dapp of dapps) {
      const wallets = (dapp.wallets ?? []).filter((wallet) => Math.abs(wallet.netUsd) >= MIN_NET_USD);
      if (Math.abs(dapp.netUsd) < MIN_NET_USD || !wallets.length) {
        hidden += 1;
        continue;
      }
      hidden += dapp.wallets.length - wallets.length;
      // 按可见钱包重算资产 / 负债 / 净值口径，避免表头仍含已隐藏份额
      const assetUsd = wallets.reduce((sum, wallet) => sum + wallet.assetUsd, 0);
      const debtUsd = wallets.reduce((sum, wallet) => sum + wallet.debtUsd, 0);
      const netUsd = wallets.reduce((sum, wallet) => sum + wallet.netUsd, 0);
      list.push({ ...dapp, wallets, assetUsd, debtUsd, netUsd });
    }
    return { visible: list, hiddenCount: hidden };
  }, [dapps]);

  if (!dapps.length) {
    return (
      <section className="section" id="defi">
        <div className="section-head">
          <div className="section-title">
            <h2>DeFi 仓位</h2>
            <span className="hint">打开页面即实时读取 · 审计快照仅展示不并入总额</span>
          </div>
        </div>
        <div className="empty">没有读到协议仓位：点击右上角刷新</div>
      </section>
    );
  }

  if (!visible.length) {
    return (
      <section className="section" id="defi">
        <div className="section-head">
          <div className="section-title">
            <h2>DeFi 仓位</h2>
            <span className="hint">净值低于 {MIN_NET_USD} USDT 的仓位已隐藏</span>
          </div>
        </div>
        <div className="empty">没有达到 {MIN_NET_USD} USDT 的协议仓位可展示</div>
      </section>
    );
  }

  const renderDapp = (dapp: DappAllocation) => {
    const site = safeSiteUrl(dapp.siteUrl);
    const host = hostOf(dapp.siteUrl);
    const debt = dapp.debtUsd > 0.01;
    const stat = perfByName.get(dapp.name);
    const reference = (perf?.rangeLabel ?? "所选区间").replace(/\s+/g, "");
    return (
      <div className="protocol" key={`${dapp.id}-${dapp.name}`}>
        <div className="protocol-head">
          <div className="protocol-id">
            <TokenIcon
              symbol={dapp.name}
              logoUrl={dapp.logoUrl}
              extraSources={
                host
                  ? [
                      `https://icons.duckduckgo.com/ip3/${host}.ico`,
                      `https://${host}/favicon.ico`,
                    ]
                  : []
              }
              size={24}
            />
            <h3>{dapp.name}</h3>
            <span className={`tag ${dapp.source === "zerion" ? "pos" : "line"}`}>
              {dapp.source === "zerion" ? "实时" : "审计快照"}
            </span>
            {site && (
              <a href={site} target="_blank" rel="noopener noreferrer">
                官网 ↗
              </a>
            )}
            <span className="small">
              {dapp.chains.length} 条链 · {dapp.wallets.length} 个钱包
              {` · 资产 ${usd(dapp.assetUsd)}`}
              {debt ? ` · 负债 ${usd(dapp.debtUsd)}` : " · 负债 $0"}
            </span>
          </div>
          <span className="protocol-summary">
            {stat && (
              stat.comparable ? (
                <span className={`small num protocol-history ${deltaClass(stat.changeUsd)}`}>
                  {reference}前净值 {usd(stat.pastUsd)} · 目前 {signedUsd(stat.changeUsd)}
                  {stat.changePct != null ? `（${signedPct(stat.changePct)}）` : ""}
                  {stat.apy != null ? ` · 年化 ${stat.apy.toFixed(1)}%` : ""}
                </span>
              ) : (
                <span className="small protocol-history">{reference}前暂无可比余额</span>
              )
            )}
            <span className="section-total num" title="净值 = 资产 − 负债">
              净值 {usd(dapp.netUsd)}
            </span>
          </span>
        </div>

        <div className="table">
          <div className="thead grid-protocol">
            <div>钱包</div>
            <div className="hide-md">链</div>
            <div className="hide-md">资产</div>
            <div className="hide-md">负债</div>
            <div className="right">净值</div>
          </div>
          {dapp.wallets.map((wallet) => {
            const chain =
              dapp.chains.find((item) =>
                item.wallets.some((share) => share.walletId === wallet.walletId)
              ) || dapp.chains[0];
            const chainId = chain?.id || "unknown";
            const chainName = chain?.name || "—";
            return (
              <div className="trow grid-protocol" key={wallet.walletId}>
                <div className="cell-token-text">
                  <b>{wallet.walletName}</b>
                  <span>{shortAddr(wallet.address)}</span>
                </div>
                <div className="cell-token hide-md">
                  <ChainIcon id={chainId} name={chainName} />
                  <span className="cell-main">{chainName}</span>
                </div>
                <div className="cell-main hide-md">
                  <PositionDetail wallet={wallet} role="asset" />
                </div>
                <div className="cell-main hide-md">
                  <PositionDetail wallet={wallet} role="debt" />
                </div>
                <div className="right cell-main num" title="净值 = 资产 − 负债">
                  {usd(wallet.netUsd)}
                </div>

                <div className="flow-meta cell-sub">
                  {chainName} · 资产 {usd(wallet.assetUsd)}（{symbolsOf(wallet, "asset")}）
                  {wallet.debtUsd > 0.01
                    ? ` · 负债 ${usd(wallet.debtUsd)}（${symbolsOf(wallet, "debt")}）`
                    : " · 负债 $0"}
                  {" · "}净值 {usd(wallet.netUsd)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <section className="section" id="defi">
      <div className="section-head">
        <div className="section-title">
          <h2>DeFi 仓位</h2>
          <span className="hint">
            {visible.length} 个协议 · 展示资产与负债明细，净值=资产−负债；不重复计入总额
            {hiddenCount > 0 ? ` · 已隐藏净值低于 ${MIN_NET_USD} USDT 的 ${hiddenCount} 项` : ""}
          </span>
        </div>
        <span className="inline">
          {perf?.available ? (
            <span className="small">
              按 {perf.rangeLabel}对比 · 年化为区间线性推算{perf.partial ? " · 含缓存" : ""}
            </span>
          ) : (
            <span className="small">{perf?.reason ?? ""}</span>
          )}
          <span className="seg">
            {CHANGE_RANGES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={range === item.key ? "active" : ""}
                onClick={() => onRangeChange(item.key)}
              >
                {item.label}
              </button>
            ))}
          </span>
          <span className="section-total num">
            {usd(visible.reduce((sum, dapp) => sum + dapp.netUsd, 0))}
          </span>
        </span>
      </div>

      {visible.map(renderDapp)}
    </section>
  );
}
