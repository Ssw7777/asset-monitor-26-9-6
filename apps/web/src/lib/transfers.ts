import type { PortfolioState } from "./types";
import type { TransactionRecord } from "./transaction-records";
import { isWalletRefreshEnabled } from "./wallets";
import { isFakeTokenContract, isJunkTokenSymbol } from "./onchain/junk-tokens";

export type TransferRangeKey = "24h" | "7d" | "30d" | "all";

export const TRANSFER_RANGES: Array<{ key: TransferRangeKey; label: string; ms: number | null }> = [
  { key: "24h", label: "24 小时", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7 天", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", label: "30 天", ms: 30 * 24 * 60 * 60 * 1000 },
  { key: "all", label: "全部缓存", ms: null },
];

export interface TransferLine {
  id: string;
  ts: string;
  walletName: string;
  walletAddress: string;
  direction: "in" | "out";
  /** 展示文案：转入 | 转出 */
  directionLabel: string;
  symbol: string;
  quantity: string;
  valueUsd: number | null;
  chain: string;
  hash: string;
  counterparty: string;
  source: string;
  /** 单行摘要：xx钱包 转入/转出 xx数量 符号 */
  summary: string;
  /** phishing / airdrop spam — show as 钓鱼 $0, never count toward USD totals */
  risk?: "spam" | null;
}

export interface TransferSummary {
  range: TransferRangeKey;
  rangeLabel: string;
  generatedAt: string;
  lines: TransferLine[];
  totalIn: number;
  totalOut: number;
  walletCoverage: number;
  walletTotal: number;
  sources: string[];
  lookbackDays: number;
  note: string;
}

function shortAddress(address: string) {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatQty(raw: string): string {
  if (!raw || raw === "—") return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw.length > 18 ? `${raw.slice(0, 16)}…` : raw;
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

/** Cached history window. OKX can serve ~6 months; 30 days fits the overview without unbounded JSON. */
export const TRANSFER_RETENTION_MS = 30 * 86_400_000;
export const MIN_TRANSFER_USD = 1;

const STABLES = new Set([
  "USDT","USDC","USDG","USD1","USDT0","USDE","DAI","FRXUSD","AUSD","PYUSD","FDUSD","USDS","USDAI","SUSDAI","CASH",
]);

function normalizeSymbol(symbol: string) {
  return symbol.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
}

interface PriceBook {
  byContract: Map<string, number>;
  bySymbol: Map<string, number>;
}

/** Spot marks already on the portfolio (value / amount). Not a historical trade price. */
export function priceBookFromState(state: PortfolioState): PriceBook {
  const byContract = new Map<string, number>();
  const bySymbol = new Map<string, number>();
  const weight = new Map<string, number>();
  for (const entry of Object.values(state.tokenCache ?? {})) {
    for (const token of entry?.tokens ?? []) {
      if (isJunkTokenSymbol(token.symbol)) continue;
      const amount = Number(token.amount);
      const marked = Number(token.valuationPrice);
      const fromBalance = amount > 0 && Number(token.valueUsd) > 0 ? Number(token.valueUsd) / amount : 0;
      const price = marked > 0 ? marked : fromBalance;
      if (!(price > 0) || !Number.isFinite(price)) continue;
      const contract = token.contractAddress?.toLowerCase();
      if (contract) byContract.set(`${token.chain}:${contract}`, price);
      const symbol = normalizeSymbol(token.symbol || "");
      if (!symbol) continue;
      const key = `${token.chain}:${symbol}`;
      const mass = Number(token.valueUsd) > 0 ? Number(token.valueUsd) : amount;
      if ((weight.get(key) ?? 0) < mass) {
        weight.set(key, mass);
        bySymbol.set(key, price);
      }
    }
  }
  return { byContract, bySymbol };
}

export function estimateTransferUsd(
  book: PriceBook,
  transfer: { symbol: string; quantity: string; contractAddress?: string },
  chain: string
): number | null {
  const qty = Number(transfer.quantity);
  if (!(qty > 0) || !Number.isFinite(qty)) return null;
  // Never price phishing / homoglyph / brand-hijack tickers as USD.
  if (isJunkTokenSymbol(transfer.symbol)) return null;
  const contract = transfer.contractAddress?.toLowerCase();
  const symbol = normalizeSymbol(transfer.symbol);
  const marked = contract ? book.byContract.get(`${chain}:${contract}`) : undefined;
  if (marked != null && marked > 0) {
    const usd = qty * marked;
    return Number.isFinite(usd) ? usd : null;
  }
  // Symbol marks are only for natives. A token contract must not borrow another asset's ticker price.
  if (!contract) {
    const native = book.bySymbol.get(`${chain}:${symbol}`);
    if (native != null && native > 0) {
      const usd = qty * native;
      return Number.isFinite(usd) ? usd : null;
    }
  }
  // Canonical stables are ~$1 even when this wallet no longer holds them.
  if (STABLES.has(symbol)) return qty;
  return null;
}

function obviousUnknownDust(transfer: { symbol: string; quantity: string; contractAddress?: string }) {
  const qty = Number(transfer.quantity);
  if (!(qty > 0) || !Number.isFinite(qty)) return true;
  const symbol = transfer.symbol || "";
  // Junk is handled as labeled spam rows (not dropped here).
  if (isJunkTokenSymbol(symbol)) return false;
  const normalized = normalizeSymbol(symbol);
  if (!transfer.contractAddress) return qty < 1e-4;
  // Only plain ASCII stables get the $1 dust gate — never homoglyph lookalikes.
  if (STABLES.has(normalized) && !/[^\u0000-\u007F]/.test(symbol)) return qty < MIN_TRANSFER_USD;
  if (/www\.|https?:/i.test(symbol)) return true;
  if (/[^\u0000-\u007F]/.test(symbol)) return true;
  return qty < 1e-8;
}

/**
 * Flatten cached provider transaction history into wallet-centric transfer lines.
 * Only confirmed provider transfers; never invents counterparties from balance deltas.
 * Drops rows worth under $1 when a price is known. Unknown prices keep non-dust amounts.
 */
export function buildTransferSummary(
  state: PortfolioState,
  opts: { range?: TransferRangeKey; limit?: number } = {}
): TransferSummary {
  const rangeKey = opts.range ?? "7d";
  const range = TRANSFER_RANGES.find((item) => item.key === rangeKey) ?? TRANSFER_RANGES[1];
  const limit = Math.max(1, Math.min(200, opts.limit ?? 80));
  const now = Date.now();
  const activeWallets = state.wallets.filter(isWalletRefreshEnabled);
  const activeAddrs = new Set(activeWallets.map((wallet) => wallet.address.toLowerCase()));
  const walletByAddr = new Map(
    state.wallets.map((wallet) => [wallet.address.toLowerCase(), wallet])
  );
  // Keep paused Abstract history visible; coverage / totals only count active wallets.
  const tracked = new Set(walletByAddr.keys());
  const history = state.transactionHistory ?? {};
  const sources = new Set<string>();
  const lines: TransferLine[] = [];
  const book = priceBookFromState(state);

  for (const [address, entry] of Object.entries(history)) {
    if (!tracked.has(address)) continue;
    const wallet = walletByAddr.get(address)!;
    const walletName = wallet.name || shortAddress(address);
    if (entry.source) sources.add(entry.source);
    for (const tx of entry.records ?? []) {
      const minedMs = Date.parse(tx.minedAt);
      if (!Number.isFinite(minedMs)) continue;
      if (range.ms != null && minedMs < now - range.ms) continue;
      for (let index = 0; index < tx.transfers.length; index += 1) {
        const transfer = tx.transfers[index];
        const sender = transfer.sender.toLowerCase();
        const recipient = transfer.recipient.toLowerCase();
        const isOut = sender === address;
        const isIn = recipient === address;
        if (!isOut && !isIn) continue;
        if (!transfer.symbol || transfer.quantity === "—" || transfer.quantity === "0") continue;
        const junk =
          isJunkTokenSymbol(transfer.symbol) ||
          isFakeTokenContract(tx.chain, transfer.symbol, transfer.contractAddress);
        const providerUsd =
          !junk && transfer.valueUsd != null && Number.isFinite(transfer.valueUsd)
            ? Math.abs(transfer.valueUsd)
            : null;
        const estimated = junk ? null : providerUsd ?? estimateTransferUsd(book, transfer, tx.chain);
        // Unpriced ERC-20 airdrops (MTO/ZEST/…) and junk tickers: label spam, $0 valuation.
        const unpricedAirdrop =
          !junk &&
          estimated == null &&
          Boolean(transfer.contractAddress) &&
          !STABLES.has(normalizeSymbol(transfer.symbol || ""));
        const spam = junk || unpricedAirdrop;
        const valueUsd = spam ? 0 : estimated;
        // Phishing / airdrop spam is hidden from 资金变动 entirely and never counted.
        if (spam) continue;
        if (valueUsd != null) {
          if (valueUsd < MIN_TRANSFER_USD) continue;
          // Testnet faucet / broken-decimal amounts (e.g. Arc testnet USDC 1e12+) are never real.
          if (valueUsd > 10_000_000) continue;
        } else if (obviousUnknownDust(transfer)) continue;
        const direction: "in" | "out" = isOut ? "out" : "in";
        const directionLabel = direction === "in" ? "转入" : "转出";
        const qty = formatQty(transfer.quantity);
        const counterparty = direction === "out" ? transfer.recipient : transfer.sender;
        const counterpartyLabel =
          walletByAddr.get(counterparty.toLowerCase())?.name ?? shortAddress(counterparty);
        const summary = spam
          ? `${walletName} ${directionLabel} ${qty} ${transfer.symbol}（钓鱼/垃圾币）`
          : `${walletName} ${directionLabel} ${qty} ${transfer.symbol}`;
        lines.push({
          id: `${tx.chain}:${tx.hash}:${index}:${direction}`,
          ts: tx.minedAt,
          walletName,
          walletAddress: address,
          direction,
          directionLabel,
          symbol: transfer.symbol,
          quantity: qty,
          valueUsd: spam ? 0 : valueUsd,
          chain: tx.chain,
          hash: tx.hash,
          counterparty: counterpartyLabel,
          source: entry.source,
          summary,
          risk: spam ? "spam" : null,
        });
      }
    }
  }

  // Prefer real-value transfers in the capped window; keep a few spam rows visible as warnings.
  lines.sort((a, b) => {
    const spamA = a.risk === "spam" ? 1 : 0;
    const spamB = b.risk === "spam" ? 1 : 0;
    if (spamA !== spamB) return spamA - spamB;
    return Date.parse(b.ts) - Date.parse(a.ts);
  });
  const real = lines.filter((line) => line.risk !== "spam");
  const spamLines = lines.filter((line) => line.risk === "spam").slice(0, 12);
  const limited = [...real.slice(0, Math.max(0, limit - Math.min(6, spamLines.length))), ...spamLines].slice(0, limit);
  limited.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const withUsd = limited.filter(
    (line) => line.risk !== "spam" && line.valueUsd != null && Number.isFinite(line.valueUsd) && line.valueUsd > 0
  );
  const totalIn = withUsd
    .filter((line) => line.direction === "in")
    .reduce((sum, line) => sum + (line.valueUsd ?? 0), 0);
  const totalOut = withUsd
    .filter((line) => line.direction === "out")
    .reduce((sum, line) => sum + (line.valueUsd ?? 0), 0);
  const covered = Object.keys(history).filter((address) => activeAddrs.has(address)).length;

  return {
    range: range.key,
    rangeLabel: range.label,
    generatedAt: new Date().toISOString(),
    lines: limited,
    totalIn: Math.round(totalIn * 100) / 100,
    totalOut: Math.round(totalOut * 100) / 100,
    walletCoverage: covered,
    walletTotal: activeWallets.length,
    sources: [...sources],
    lookbackDays: range.ms == null ? 30 : Math.round(range.ms / 86_400_000),
    note:
      "链上转入/转出来自已确认交易（OKX OnchainOS / Alchemy），不是余额估值差。低于 1 美元的不展示；有持仓价或稳定币面值时按美元判断，没有价格时只去掉极小原生币和异常符号，不丢大额未知代币。",
  };
}

export function mergeTransactionRecords(
  existing: TransactionRecord[] | undefined,
  incoming: TransactionRecord[],
  maxAgeMs = TRANSFER_RETENTION_MS,
  limit = 100
): TransactionRecord[] {
  const combined = new Map<string, TransactionRecord>();
  const now = Date.now();
  for (const tx of [...(existing ?? []), ...incoming]) {
    if (now - Date.parse(tx.minedAt) > maxAgeMs) continue;
    const id = `${tx.chain}:${tx.hash}`;
    const previous = combined.get(id);
    if (previous) {
      for (const t of tx.transfers) {
        if (
          !previous.transfers.some(
            (p) =>
              p.sender === t.sender &&
              p.recipient === t.recipient &&
              p.quantity === t.quantity &&
              p.contractAddress === t.contractAddress
          )
        ) {
          previous.transfers.push(t);
        }
      }
    } else {
      combined.set(id, { ...tx, transfers: [...tx.transfers] });
    }
  }
  return [...combined.values()]
    .sort((a, b) => Date.parse(b.minedAt) - Date.parse(a.minedAt))
    .slice(0, limit);
}
