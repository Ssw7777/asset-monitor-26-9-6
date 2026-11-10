"use client";

import { useMemo, useState } from "react";
import type { TokenAuditSummary, TokenHolding } from "@/lib/types";
import { amountNum, priceUsd, shortAddr, timeAgo, usd } from "./format";
import { localChainIcon, TokenIcon } from "./TokenIcon";

function percent(value: number, total: number) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

interface TokenGroup {
  key: string;
  symbol: string;
  identityConflict: boolean;
  chains: TokenHolding[];
  amount: number;
  valueUsd: number;
  price: number;
  logoUrl?: string;
  kind: TokenHolding["kind"];
  wallets: Array<{ walletId: string; walletName: string; address: string; amount: number; valueUsd: number }>;
}

/** Symbols group display rows only. Any same-chain identity conflict splits the whole symbol group. */
function groupTokens(tokens: TokenHolding[]): TokenGroup[] {
  const identities = new Map<string, Set<string>>();
  const conflictingSymbols = new Set<string>();
  for (const token of tokens) {
    const symbol = token.symbol.toUpperCase();
    const chainKey = `${symbol}:${token.chain}`;
    const ids = identities.get(chainKey) ?? new Set<string>();
    ids.add(token.id);
    identities.set(chainKey, ids);
    if (ids.size > 1) conflictingSymbols.add(symbol);
  }
  const map = new Map<string, TokenGroup>();
  for (const token of tokens) {
    const symbol = token.symbol.toUpperCase();
    const identityConflict = conflictingSymbols.has(symbol);
    const key = identityConflict ? `${symbol}:${token.chain}:${token.id}` : symbol;
    const group =
      map.get(key) ||
      ({
        key,
        symbol: token.symbol,
        identityConflict,
        chains: [],
        amount: 0,
        valueUsd: 0,
        price: 0,
        logoUrl: token.logoUrl,
        kind: token.kind,
        wallets: [],
      } satisfies TokenGroup);
    group.chains.push(token);
    group.amount += token.amount;
    group.valueUsd += token.valueUsd;
    if (!group.logoUrl && token.logoUrl) group.logoUrl = token.logoUrl;
    for (const wallet of token.wallets) {
      const existing = group.wallets.find((item) => item.walletId === wallet.walletId);
      if (existing) {
        existing.amount += wallet.amount;
        existing.valueUsd += wallet.valueUsd;
      } else {
        group.wallets.push({ ...wallet });
      }
    }
    map.set(key, group);
  }
  const list = [...map.values()];
  for (const group of list) {
    group.chains.sort((left, right) => right.valueUsd - left.valueUsd);
    group.wallets.sort((left, right) => right.valueUsd - left.valueUsd);
    group.price = group.amount > 0 ? group.valueUsd / group.amount : 0;
  }
  return list.sort((left, right) => right.valueUsd - left.valueUsd);
}

function auditWalletStatus(wallet: TokenAuditSummary["wallets"][number], now: number) {
  if (wallet.status === "error") return "error";
  if (wallet.status === "missing" || !wallet.updatedAt) return "missing";
  const at = Date.parse(wallet.updatedAt);
  return Number.isFinite(at) && at <= now && now - at <= 10 * 60 * 1000 ? "fresh" : "stale";
}

/** Token quantities and their freshness are independent of wallet-total refreshes. */
export function TokenTable({
  tokens,
  onchainUsd,
  chainFilter,
  partial,
  tokenSource,
  tokenAudit,
  now = Date.now(),
}: {
  tokens: TokenHolding[];
  onchainUsd: number;
  chainFilter: string;
  partial?: boolean;
  tokenSource?: string;
  tokenAudit?: TokenAuditSummary;
  now?: number;
}) {
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [dustOpen, setDustOpen] = useState(false);
  const walletAudits = useMemo(
    () => new Map(tokenAudit?.wallets.map((wallet) => [wallet.walletId, wallet]) ?? []),
    [tokenAudit]
  );
  const auditCounts = useMemo(() => {
    const counts = { fresh: 0, stale: 0, missing: 0, error: 0 };
    for (const wallet of tokenAudit?.wallets ?? []) counts[auditWalletStatus(wallet, now)] += 1;
    return counts;
  }, [tokenAudit, now]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return tokens.filter(
      (token) =>
        (chainFilter === "all" || token.chain === chainFilter) &&
        (!keyword || token.symbol.toLowerCase().includes(keyword))
    );
  }, [tokens, chainFilter, query]);

  const groups = useMemo(() => groupTokens(filtered), [filtered]);
  const shownTotal = useMemo(
    () => groups.reduce((sum, group) => sum + group.valueUsd, 0),
    [groups]
  );
  /** 小于 50 USDT 的一律折叠成一行，避免一堆小额代币把主列表冲散。 */
  const mainGroups = useMemo(() => groups.filter((group) => group.valueUsd >= 50), [groups]);
  const dustGroups = useMemo(() => groups.filter((group) => group.valueUsd < 50), [groups]);
  const dustTotal = useMemo(
    () => dustGroups.reduce((sum, group) => sum + group.valueUsd, 0),
    [dustGroups]
  );
  const dustWallets = useMemo(() => {
    const set = new Set<string>();
    for (const group of dustGroups) for (const wallet of group.wallets) set.add(wallet.walletId);
    return set.size;
  }, [dustGroups]);
  const coverage = onchainUsd > 0 ? (shownTotal / onchainUsd) * 100 : 0;

  const renderCard = (group: TokenGroup) => {
    const key = group.key;
    const open = openKey === key;
    const share = percent(group.valueUsd, shownTotal);
    const topChain = group.chains[0];
    return (
      <div
        key={key}
        className={`token-card clickable${open ? " open" : ""}`}
        onClick={() => setOpenKey(open ? null : key)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpenKey(open ? null : key);
          }
        }}
      >
        <div className="token-card-head">
          <div className="cell-token">
            <TokenIcon symbol={group.symbol} logoUrl={group.logoUrl} />
            <span className="cell-token-text">
              <b>{group.symbol}</b>
              <span>
                {group.kind === "stable" ? "稳定币" : group.kind === "native" ? "主链币" : "现货"}
                {group.identityConflict ? " · 同名资产独立显示" : ""}
              </span>
            </span>
          </div>
          <div className="token-card-metrics">
            <div>
              <span>价格</span>
              <b className="num">{priceUsd(group.price)}</b>
            </div>
            <div>
              <span>数量</span>
              <b className="num" title={`${group.amount} ${group.symbol}`}>
                {amountNum(group.amount)} {group.symbol}
              </b>
            </div>
            <div>
              <span>分布</span>
              <b className="token-card-location">
                {group.chains.length === 1 && topChain ? (
                  <TokenIcon
                    symbol={topChain.chainName}
                    localSrc={localChainIcon(topChain.chain)}
                    size={15}
                    shape="square"
                  />
                ) : null}
                {group.chains.length === 1 ? topChain?.chainName : `${group.chains.length} 条链`}
                {` · ${group.wallets.length} 个钱包`}
              </b>
            </div>
          </div>
          <div className="token-card-value value-cell num">
            <div className="cell-main">{usd(group.valueUsd)}</div>
            <div className="value-bar" aria-hidden="true">
              <i style={{ width: `${share}%` }} />
            </div>
            <div className="cell-sub">{share.toFixed(2)}%</div>
          </div>
        </div>

        {open && (
          <div className="row-detail">
            <div className="small" style={{ marginBottom: 8 }}>
              各链明细（{group.chains.length} 条链 · {group.wallets.length} 个钱包）
            </div>
            <div className="detail-grid">
              {group.chains.map((chain) => (
                <div className="detail-item" key={chain.id} style={{ alignItems: "flex-start" }}>
                  <span className="name" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <TokenIcon
                      symbol={chain.chainName}
                      localSrc={localChainIcon(chain.chain)}
                      size={16}
                      shape="square"
                    />
                    {chain.chainName}
                  </span>
                  <span className="amount" title={`${chain.amount} ${chain.symbol} · ${chain.id}`}>
                    {amountNum(chain.amount)} · {usd(chain.valueUsd)}
                  </span>
                </div>
              ))}
            </div>
            <div className="small" style={{ margin: "10px 0 8px" }}>
              各钱包持仓
            </div>
            <div className="detail-grid">
              {group.wallets.map((wallet) => {
                const audit = walletAudits.get(wallet.walletId);
                const status = audit ? auditWalletStatus(audit, now) : "missing";
                const statusLabel = status === "fresh" ? "10 分钟内" : status === "error" ? "读取失败" : status === "stale" ? "明细过期" : "未获取明细";
                return (
                <div className="detail-item" key={wallet.walletId}>
                  <span className="name">
                    {wallet.walletName}
                    <span className="small" style={{ marginLeft: 6 }}>
                      {shortAddr(wallet.address)}
                    </span>
                    <span className="small" style={{ marginLeft: 6 }} title={audit?.updatedAt ?? "无成功更新记录"}>
                      明细 {timeAgo(audit?.updatedAt ?? null)} · {statusLabel}
                    </span>
                  </span>
                  <span className="amount" title={`${wallet.amount} ${group.symbol}`}>
                    {amountNum(wallet.amount)} · {usd(wallet.valueUsd)}
                  </span>
                </div>
              );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="section section-surface section-tokens" id="tokens">
      <div className="section-head">
        <div className="section-title">
          <h2>代币</h2>
          <span className="hint">
            {groups.length} 项
            {chainFilter !== "all" ? "（已按链筛选）" : " · 按符号分组"}
          </span>
        </div>
        <div className="inline">
          <span className="search" style={{ height: 36, minWidth: 190 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.2-3.2" />
            </svg>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索代币"
              aria-label="搜索代币"
            />
          </span>
          <span className="section-total num">{usd(shownTotal)}</span>
        </div>
      </div>

      <div className="small" style={{ marginBottom: 10 }} role="status">
        {tokenAudit?.rpc && <div>已知持币数量链上核验：{tokenAudit.rpc.fresh}/{tokenAudit.rpc.total} 项在 10 分钟内 · 失败 {tokenAudit.rpc.failed}；不代表价格、DeFi 和钱包总额同时更新。</div>}
        {tokenAudit ? (
          <>
            全部代币巡检 {auditCounts.fresh}/{tokenAudit.walletCount} 钱包在 10 分钟内
            {` · 过期 ${auditCounts.stale} · 失败 ${auditCounts.error}`}
            {auditCounts.missing > 0 ? ` · 未获取 ${auditCounts.missing}` : ""}
            <span title={tokenAudit.oldestUpdatedAt ?? "无成功更新记录"}>
              {` · 最早明细 ${timeAgo(tokenAudit.oldestUpdatedAt)}`}
            </span>
          </>
        ) : "全部代币巡检：尚无明细核验结果"}
      </div>

      {groups.length ? (
        <div className="token-table-shell">
          <div className="token-card-grid">
            {mainGroups.map(renderCard)}
            {dustGroups.length > 0 && (
              <button
                type="button"
                className="token-dust-card"
                onClick={() => setDustOpen((value) => !value)}
                aria-expanded={dustOpen}
              >
                <div className="cell-token">
                  <span className="token-icon fallback" style={{ width: 28, height: 28 }}>
                    ⋯
                  </span>
                  <span className="cell-token-text">
                    <b>小额资产 {dustGroups.length} 项</b>
                    <span>每项低于 50 USDT · {dustOpen ? "点击收起" : "点击展开"}</span>
                  </span>
                </div>
                <div className="token-dust-value value-cell num">
                  <div className="cell-main">{usd(dustTotal)}</div>
                  <div className="value-bar" aria-hidden="true">
                    <i style={{ width: `${percent(dustTotal, shownTotal)}%` }} />
                  </div>
                  <div className="cell-sub">{percent(dustTotal, shownTotal).toFixed(2)}%</div>
                </div>
                <span className="token-dust-meta">多链 · {dustWallets} 个钱包</span>
              </button>
            )}
            {dustOpen && dustGroups.map(renderCard)}
          </div>
          <div className="table-foot">
            <span>代币明细合计 {usd(shownTotal)} · 占链上总额 {coverage.toFixed(1)}%</span>
            <span>
              {tokenSource === "debank"
                ? "数据源：DeBank Pro"
                : tokenSource === "zerion"
                  ? "数据源：Zerion"
                  : tokenSource === "rpc" ? "数量：链上 RPC · 价格／发现：聚合接口" : "数据源：公共接口（限流时会缺）"}
              {tokens.some(token=>token.priceSource==='coinstats') && <> · <a href="https://coinstats.app" target="_blank" rel="noreferrer">Powered by CoinStats</a></>}
              {coverage < 95 ? " · 差额为未取到明细或未计价资产，不计入总额" : partial ? " · 本轮有地址使用上次成功数据" : ""}
            </span>
          </div>
        </div>
      ) : (
        <div className="empty">
          {tokens.length
            ? "没有匹配当前筛选条件的代币"
            : "还没有代币明细，点击右上角刷新即可获取"}
        </div>
      )}
    </section>
  );
}
