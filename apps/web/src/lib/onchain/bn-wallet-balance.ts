import type { TokenLine, WalletTokenCacheEntry } from "../types";
import { bnWeb3Credentials, bnWeb3Read, type BnWeb3Credentials } from "./bn-web3";
import { isFakeTokenContract, isJunkTokenSymbol } from "./junk-tokens";
import { OKX_CHAIN_IDS } from "./okx-web3-observation";
import { tokenIdentity } from "./token-cache-policy";

/**
 * Wallet totals from Binance Web3 token balances.
 * The published figure is filtered tokens plus app balances plus DeFi position
 * value that is not already in those tokens. Rabby total_balance is a
 * once-per-day reconciliation check and must not replace a fresh Binance total.
 * Until a Rabby list/total anchors a wallet OR a previous published total
 * already exists, the candidate is not written. With a previous total, gap
 * vs that total (or a fresh Rabby total) decides publish vs hold-gap — so a
 * 429 / empty token_list cannot freeze every wallet forever. Without a Rabby
 * token_list, moderate upward bn-web3 corrections soft-exit hold-gap (primary
 * source); downward and list-reconcile checks stay strict. Token list is
 * preferred for junk filtering; total_balance alone is enough when the list
 * is empty. A failed Binance read keeps the last good value until it is stale,
 * then Rabby may fill in once — never on the next tick.
 */

export const RABBY_TOTAL_RECONCILE_MS = 24 * 60 * 60 * 1000;
/** One Rabby reconcile at a time, a few minutes apart, so the public limit can recover. */
export const RABBY_RECONCILE_GAP_MS = 3 * 60 * 1000;
/** Backoff after HTTP 429 / a dropped call. Doubles from the gap and stops here. */
export const RABBY_RECONCILE_BACKOFF_MAX_MS = 15 * 60 * 1000;
/**
 * After Rabby token_list returns a confirmed empty array, skip re-fetching that
 * list for this long. Do NOT use this as the shared rabbySlot backoff — that
 * would freeze every wallet's total_balance reconcile for hours.
 */
export const RABBY_EMPTY_LIST_RETRY_MS = 6 * 60 * 60 * 1000;
/** Binance miss shorter than this keeps the last Binance total (no source flip). */
export const BN_TOTAL_STALE_FALLBACK_MS = 6 * 60 * 60 * 1000;
const ALL_TOKEN_BALANCES = "/api/v1/dex/balance/all-token-balances-by-address";
const MARKET_PRICE = "/api/v1/dex/market/price";
const PAGE_SIZE = 100;
const MAX_PAGES = 15;
/**
 * Binance rejects `chains=1,56` with code 40001. One chain per request.
 * A few reads stay in flight; the shared client still starts them 250ms apart.
 */
const CHAIN_READ_CONCURRENCY = 4;
const DUST_USD = 0.05;
const ABSURD_TOKEN_USD = 2_000_000;
const ILLIQUID_VALUE_USD = 50;
const LIQUID_KEEP_USD = 50_000;
/** Unknown, weakly priced tokens at or above this are held out until Rabby has seen them. */
const UNKNOWN_HOLD_USD = 500;
const AIRDROP_MIN_WALLETS = 3;
const YIELD_PRICE_BAND: [number, number] = [0.5, 3];
const STOCK_PRICE_BAND: [number, number] = [0.01, 20_000];

const CHAIN_BY_BN: Record<string, string> = Object.fromEntries(
  Object.entries(OKX_CHAIN_IDS).map(([slug, id]) => [id, slug])
);

const CHAIN_NAMES: Record<string, string> = {
  eth: "Ethereum",
  bsc: "BNB Chain",
  base: "Base",
  arb: "Arbitrum",
  op: "Optimism",
  matic: "Polygon",
  avax: "Avalanche",
  linea: "Linea",
  hood: "Robinhood Chain",
  abs: "Abstract",
  scrl: "Scroll",
  blast: "Blast",
  era: "zkSync Era",
  katana: "Katana",
  arc: "ARC",
  opbnb: "opBNB",
  xlayer: "X Layer",
  ink: "Ink",
  megaeth: "MegaETH",
  monad: "Monad",
  plasma: "Plasma",
  bera: "Berachain",
  zora: "Zora",
};

/** Gas coin per chain. Polygon accepts POL or MATIC. */
const NATIVE_SYMBOL: Record<string, string> = {
  eth: "ETH",
  arb: "ETH",
  op: "ETH",
  base: "ETH",
  linea: "ETH",
  hood: "ETH",
  abs: "ETH",
  era: "ETH",
  scrl: "ETH",
  blast: "ETH",
  katana: "ETH",
  ink: "ETH",
  zora: "ETH",
  megaeth: "ETH",
  uni: "ETH",
  world: "ETH",
  mode: "ETH",
  bob: "ETH",
  taiko: "ETH",
  bsc: "BNB",
  opbnb: "BNB",
  matic: "POL",
  avax: "AVAX",
  merlin: "BTC",
};

const NATIVE_PRICE_BAND: Record<string, [number, number]> = {
  ETH: [50, 100_000],
  BNB: [10, 20_000],
  POL: [0.02, 100],
  MATIC: [0.02, 100],
  AVAX: [1, 5_000],
  BTC: [1_000, 1_000_000],
};

/** Wrapped gas token. Its market price replaces Binance's native-row price. */
const WRAPPED_NATIVE: Record<string, string> = {
  eth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  arb: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  op: "0x4200000000000000000000000000000000000006",
  base: "0x4200000000000000000000000000000000000006",
  linea: "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f",
  scrl: "0x5300000000000000000000000000000000000004",
  blast: "0x4300000000000000000000000000000000000004",
  era: "0x5aea5775959fbc2557cc8789bc1bf90a239d9a91",
  zora: "0x4200000000000000000000000000000000000006",
  ink: "0x4200000000000000000000000000000000000006",
  mode: "0x4200000000000000000000000000000000000006",
  bsc: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  opbnb: "0x4200000000000000000000000000000000000006",
  matic: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
  avax: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
};

const NATIVE_CONTRACTS = new Set([
  "",
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);

const STABLE_SYMBOLS = new Set([
  "USDT", "USDC", "USDG", "USDE", "USD1", "USDT0", "USD0", "DAI", "FDUSD", "TUSD",
  "BUSD", "USDD", "PYUSD", "GHO", "USDS", "SUSDE", "SUSDS", "FRAX", "LUSD", "USDX",
  "USDP", "USDR", "USDF", "USDY", "SUSD", "CRVUSD",
]);

const BN_BY_CHAIN: Record<string, string> = Object.fromEntries(
  Object.entries(OKX_CHAIN_IDS).map(([slug, id]) => [slug, id])
);

export interface BnRawToken {
  chainId: string;
  bnChainId: string;
  contract: string;
  symbol: string;
  name: string;
  amount: number;
  amountExact: string;
  price: number;
  verified: boolean | null;
  risk: boolean;
  liquidity: number | null;
}

export interface BnWalletChain {
  id: string;
  name: string;
  valueUsd: number;
}

export interface RabbyHeldToken {
  chain: string;
  id: string;
  symbol: string;
  amount: number;
}

export interface RoundHolding {
  chain: string;
  symbol: string;
  amount: number;
}

export interface ExcludedToken {
  chain: string;
  symbol: string;
  amount: number;
  valueUsd: number;
  reason: string;
}

export interface BnWalletValuation {
  totalUsd: number;
  chains: BnWalletChain[];
  tokens: Array<TokenLine & { chain: string }>;
  /** A material native balance had no trusted price. Do not publish this sum. */
  incompleteNative: boolean;
  explicitEmpty: boolean;
  dropped: Record<string, number>;
  excluded: ExcludedToken[];
  /** Large round balances, kept so the same airdrop can be recognized on later wallets. */
  roundHoldings: RoundHolding[];
}

export type WalletTotalChoice = "bn-web3" | "rabby" | "last-good";

let loggedMissingKeys = false;
let wrappedPriceCache: { at: number; prices: Record<string, number> } | null = null;

function finite(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function bnWalletChainIds(): string[] {
  return [...new Set(Object.values(OKX_CHAIN_IDS))].filter((id) => /^\d+$/.test(id));
}

/** Wrapped-native quotes, one request per chain. Cached across a wallet lap. */
export function wrappedNativePriceRequests(): number {
  return Object.keys(WRAPPED_NATIVE).filter((chain) => BN_BY_CHAIN[chain]).length;
}

/**
 * Cron treats `succeeded > 0` as a completed wallet-batch round.
 * Keeping the last good total (success clock unchanged) still counts.
 * `observed` is a real new success and is the only thing that should refresh observation time.
 */
export function countWalletBatch(
  wallets: Array<{
    attempted: boolean;
    status: string;
    successAt?: string | null;
    previousSuccessAt?: string | null;
  }>
): { attempted: number; succeeded: number; observed: number } {
  let attempted = 0;
  let succeeded = 0;
  let observed = 0;
  for (const wallet of wallets) {
    if (!wallet.attempted) continue;
    attempted += 1;
    if (wallet.status !== "ok") continue;
    succeeded += 1;
    const successAt = wallet.successAt || null;
    const previousSuccessAt = wallet.previousSuccessAt || null;
    if (successAt && successAt !== previousSuccessAt) observed += 1;
  }
  return { attempted, succeeded, observed };
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export function chainSlugForBn(bnChainId: string): string {
  return CHAIN_BY_BN[bnChainId] || (/^\d+$/.test(bnChainId) ? `c${bnChainId}` : "");
}

export function isNativeCoin(chain: string, contract: string, symbol: string): boolean {
  const expected = NATIVE_SYMBOL[chain];
  if (!expected) return false;
  const sym = symbol.trim().toUpperCase();
  const matches = sym === expected || (expected === "POL" && sym === "MATIC");
  if (!matches) return false;
  return NATIVE_CONTRACTS.has(contract.trim().toLowerCase());
}

function nativeBandSymbol(chain: string, symbol: string): string {
  const sym = symbol.trim().toUpperCase();
  if (sym === "MATIC") return "MATIC";
  return NATIVE_SYMBOL[chain] || sym;
}

export function acceptNativePrice(chain: string, symbol: string, price: number): boolean {
  if (!(price > 0) || price > 1e7) return false;
  const band = NATIVE_PRICE_BAND[nativeBandSymbol(chain, symbol)];
  if (!band) return true;
  return price >= band[0] && price <= band[1];
}

/** Copy one chain's trusted native price onto every chain that uses the same coin. */
export function expandNativePrices(prices: Record<string, number>): Record<string, number> {
  const bySymbol: Record<string, number> = {};
  for (const [chain, price] of Object.entries(prices)) {
    const symbol = NATIVE_SYMBOL[chain];
    if (symbol && acceptNativePrice(chain, symbol, price)) bySymbol[symbol] = price;
  }
  const out = { ...prices };
  for (const [chain, symbol] of Object.entries(NATIVE_SYMBOL)) {
    if (!(out[chain] > 0) && bySymbol[symbol] > 0) out[chain] = bySymbol[symbol];
  }
  return out;
}

export function nativePricesFromTokenCache(
  entries: Iterable<WalletTokenCacheEntry | undefined>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of entries) {
    for (const token of entry?.tokens ?? []) {
      if (token.priceSource !== "coinstats") continue;
      if (!isNativeCoin(token.chain, token.contractAddress || "", token.symbol)) continue;
      const price = token.valuationPrice ?? (token.amount > 0 ? token.valueUsd / token.amount : 0);
      if (acceptNativePrice(token.chain, token.symbol, price)) out[token.chain] = price;
    }
  }
  return expandNativePrices(out);
}

function contractOf(row: Record<string, unknown>): string {
  if ("tokenContractAddress" in row) return String(row.tokenContractAddress ?? "").trim().toLowerCase();
  if ("contractAddress" in row) return String(row.contractAddress ?? "").trim().toLowerCase();
  if ("tokenAddress" in row) return String(row.tokenAddress ?? "").trim().toLowerCase();
  if ("address" in row && !("tokenAssets" in row)) return String(row.address ?? "").trim().toLowerCase();
  return "";
}

function readVerified(row: Record<string, unknown>): boolean | null {
  const value = "isVerified" in row ? row.isVerified : "is_verified" in row ? row.is_verified : undefined;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return null;
}

function readRisk(row: Record<string, unknown>): boolean {
  const flagged = row.isRiskToken;
  if (flagged === true || flagged === "true" || flagged === 1 || flagged === "1") return true;
  if (row.isSpam === true || row.isPhishing === true || row.is_scam === true || row.is_suspicious === true) return true;
  const level = String(row.riskLevel ?? "").trim().toUpperCase();
  if (level === "HIGH" || level === "MEDIUM" || level === "SPAM" || level === "PHISHING" || level === "RISK") return true;
  const levelInt = finite(row.riskLevelInt);
  return Number.isFinite(levelInt) && levelInt >= 3;
}

function readLiquidity(row: Record<string, unknown>): number | null {
  if (row.lowLiquidity === 1 || row.lowLiquidity === true || row.lowLiquidity === "1") return 0;
  for (const key of ["liquidityUsd", "liquidity", "tokenLiquidity", "poolLiquidity"]) {
    if (row[key] == null || row[key] === "") continue;
    const value = finite(row[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function tokenArray(bucket: Record<string, unknown>): unknown[] | null {
  for (const key of ["tokenAssets", "tokenBalances", "tokenList", "balances", "list", "tokens"]) {
    if (Array.isArray(bucket[key])) return bucket[key] as unknown[];
  }
  return null;
}

function pushToken(out: BnRawToken[], row: Record<string, unknown>, inheritedChain: string) {
  const symbol = String(row.symbol ?? row.tokenSymbol ?? "").trim();
  const amountRaw = row.balance ?? row.tokenAmount ?? row.amount ?? row.remainQty;
  const amount = finite(amountRaw);
  if (!symbol || !Number.isFinite(amount) || amount < 0) return;
  const bnChainId = String(row.binanceChainId ?? row.chainId ?? row.chainIndex ?? inheritedChain ?? "").trim();
  if (!bnChainId || bnChainId.startsWith("CT_")) return;
  const chainId = chainSlugForBn(bnChainId);
  if (!chainId) return;
  const price = finite(row.tokenPrice ?? row.price);
  out.push({
    chainId,
    bnChainId,
    contract: contractOf(row),
    symbol,
    name: String(row.tokenName ?? row.name ?? "").trim(),
    amount,
    amountExact: typeof amountRaw === "string" ? amountRaw : String(amountRaw),
    price: Number.isFinite(price) && price > 0 ? price : 0,
    verified: readVerified(row),
    risk: readRisk(row),
    liquidity: readLiquidity(row),
  });
}

function visit(out: BnRawToken[], value: unknown, inheritedChain = "") {
  const row = asRecord(value);
  if (!row) return;
  const chainHint = String(row.binanceChainId ?? row.chainId ?? row.chainIndex ?? inheritedChain ?? "");
  const nested = tokenArray(row);
  const looksLikeToken = row.symbol != null || row.tokenSymbol != null || row.balance != null || row.remainQty != null;
  if (nested && !looksLikeToken) {
    for (const item of nested) visit(out, item, chainHint);
    return;
  }
  if (looksLikeToken) pushToken(out, row, chainHint);
  else if (nested) for (const item of nested) visit(out, item, chainHint);
}

/** Accept OKX-shaped tokenAssets, per-chain buckets, and flat balance rows. */
export function extractBnRawTokens(payload: unknown): BnRawToken[] {
  const root = asRecord(payload);
  const data = root && "data" in root ? root.data : payload;
  const out: BnRawToken[] = [];
  if (Array.isArray(data)) {
    for (const item of data) visit(out, item);
    return out;
  }
  visit(out, data);
  return out;
}

function bump(dropped: Record<string, number>, reason: string) {
  dropped[reason] = (dropped[reason] || 0) + 1;
}

function canonicalSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\.E$/, "");
}

function stableSymbol(symbol: string): boolean {
  const upper = canonicalSymbol(symbol);
  // "U" on BSC is a real dollar token. A non-dollar price still fails the stable band.
  return STABLE_SYMBOLS.has(upper) || upper === "U";
}

const YIELD_SYMBOLS = new Set(["SUSDAI", "SUSDE", "SUSDS", "SDAI", "SFRAX", "USDAI"]);
const MAJOR_SYMBOLS = new Set([
  "ETH", "WETH", "BNB", "WBNB", "BTC", "WBTC", "POL", "WPOL", "MATIC", "AVAX", "WAVAX",
]);

/** 1inch tokenized stocks use a lowercase trailing c (NVDAc). USDC does not match. */
export function isTokenizedStock(symbol: string): boolean {
  return /^[A-Z][A-Z0-9]{0,7}c$/.test(symbol.trim());
}

/**
 * Robinhood Chain lists cash equities (MCD, PONS) without the 1inch suffix.
 * Other chains qualify only for the c-suffix or a known issuer name.
 */
const STOCK_CHAINS = new Set(["hood"]);
const STOCK_ISSUER = /dinari|backed|ondo|swarm|xstock|tokenized stock|robinhood stock/i;

export function isStockOrRwa(token: { chainId: string; symbol: string; name: string }): boolean {
  if (isTokenizedStock(token.symbol)) return true;
  if (STOCK_ISSUER.test(token.name) || STOCK_ISSUER.test(token.symbol)) return true;
  if (!STOCK_CHAINS.has(token.chainId)) return false;
  const symbol = canonicalSymbol(token.symbol);
  return symbol.length >= 1 && symbol.length <= 8 && /^[A-Z][A-Z0-9]*$/.test(symbol);
}

function isYieldSymbol(symbol: string): boolean {
  return YIELD_SYMBOLS.has(canonicalSymbol(symbol));
}

function isKnownToken(raw: BnRawToken, native: boolean, stable: boolean): boolean {
  if (native || stable) return true;
  const upper = canonicalSymbol(raw.symbol);
  if (MAJOR_SYMBOLS.has(upper) || isYieldSymbol(raw.symbol) || isStockOrRwa(raw)) return true;
  const allow = (process.env.BN_WALLET_TOKEN_ALLOWLIST || "")
    .split(/[,;\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const contract = raw.contract.toLowerCase();
  return allow.some((item) => item === `${raw.chainId}:${raw.symbol.toLowerCase()}` || (contract && item === `${raw.chainId}:${contract}`));
}

/** Identical round airdrop amounts (62000, 60000), not ordinary dust. */
export function roundHoldingKey(chain: string, symbol: string, amount: number): string | null {
  if (!(amount >= 1000)) return null;
  const nearest = Math.round(amount);
  if (Math.abs(amount - nearest) > 0.05) return null;
  if (nearest % 1000 !== 0) return null;
  return `${chain}:${canonicalSymbol(symbol)}:${nearest}`;
}

export function repeatedRoundKeys(
  groups: Array<{ wallet: string; rows: RoundHolding[] }>,
  minWallets = AIRDROP_MIN_WALLETS
): Set<string> {
  const seen = new Map<string, Set<string>>();
  for (const group of groups) {
    const local = new Set<string>();
    for (const row of group.rows) {
      const key = roundHoldingKey(row.chain, row.symbol, row.amount);
      if (key) local.add(key);
    }
    for (const key of local) {
      const wallets = seen.get(key) ?? new Set<string>();
      wallets.add(group.wallet);
      seen.set(key, wallets);
    }
  }
  const out = new Set<string>();
  for (const [key, wallets] of seen) if (wallets.size >= minWallets) out.add(key);
  return out;
}

export function parseRabbyHeldTokens(payload: unknown): RabbyHeldToken[] | null {
  if (!Array.isArray(payload) || payload.length === 0 || payload.length > 5_000) return null;
  const out: RabbyHeldToken[] = [];
  for (const item of payload) {
    const row = asRecord(item);
    if (!row || row.is_scam === true || row.is_suspicious === true) continue;
    const chain = String(row.chain || "").trim().toLowerCase();
    const id = String(row.id || "").trim().toLowerCase();
    const symbol = String(row.optimized_symbol || row.display_symbol || row.symbol || "").trim();
    const amount = finite(row.amount);
    const value = finite(row.usd_value);
    if (!chain || !symbol || !(amount > 0)) continue;
    if (Number.isFinite(value) && value < DUST_USD) continue;
    out.push({ chain, id, symbol, amount });
    if (out.length >= 200) break;
  }
  return out.length ? out : null;
}

function rabbyHolds(raw: BnRawToken, held: RabbyHeldToken[] | undefined): boolean {
  if (!held?.length) return false;
  const symbol = canonicalSymbol(raw.symbol);
  const contract = raw.contract.toLowerCase();
  return held.some((token) => {
    if (token.chain !== raw.chainId) return false;
    const id = token.id.toLowerCase();
    if (contract && id === contract) return true;
    if (!contract && (id === raw.chainId || id === symbol.toLowerCase())) return true;
    return canonicalSymbol(token.symbol) === symbol && Math.abs(token.amount - raw.amount) / Math.max(raw.amount, 1) < 0.05;
  });
}

export function explainedTransferUsd(
  records: Array<{ minedAt: string; transfers: Array<{ sender: string; recipient: string; valueUsd: number | null }> }>,
  address: string,
  sinceMs: number
): number {
  const owner = address.toLowerCase();
  let net = 0;
  for (const record of records) {
    const mined = Date.parse(record.minedAt);
    if (!Number.isFinite(mined) || mined < sinceMs) continue;
    for (const transfer of record.transfers) {
      const value = transfer.valueUsd;
      if (value == null || !Number.isFinite(value)) continue;
      const sender = transfer.sender.toLowerCase();
      const recipient = transfer.recipient.toLowerCase();
      if (recipient === owner && sender !== owner) net += Math.abs(value);
      else if (sender === owner && recipient !== owner) net -= Math.abs(value);
    }
  }
  return round2(net);
}

/**
 * Block a publish when the filtered Binance total is far from the reference
 * and transfers do not explain the gap.
 * softUpward: when Rabby token_list is missing, allow a moderate upward
 * bn-web3 correction (primary source) so a stale Rabby-era total cannot
 * freeze forever. Downward moves and Rabby-list reconciles stay strict
 * (3% / $150) so empty/junk reads cannot wipe a real balance, and absurd
 * spam candidates (e.g. 1000× jumps) still hold-gap.
 */
export function binanceGapBlocked(
  binanceUsd: number,
  referenceUsd: number,
  flowUsd: number,
  options?: { softUpward?: boolean }
): { unexplained: number; threshold: number } | null {
  if (!Number.isFinite(binanceUsd) || !Number.isFinite(referenceUsd) || referenceUsd < 0) return null;
  const flow = Number.isFinite(flowUsd) ? flowUsd : 0;
  const delta = binanceUsd - referenceUsd - flow;
  const unexplained = Math.abs(delta);
  const softUp = Boolean(options?.softUpward) && delta > 0;
  const scale = Math.max(Math.abs(binanceUsd), Math.abs(referenceUsd));
  const threshold = softUp ? Math.max(8_000, scale * 0.15) : Math.max(150, scale * 0.03);
  return unexplained > threshold ? { unexplained: round2(unexplained), threshold: round2(threshold) } : null;
}

/** Next wait after a Rabby reconcile attempt. A 429 doubles the previous wait. */
export function rabbyBackoffMs(previousMs: number | undefined, limited: boolean): number {
  if (!limited) return RABBY_RECONCILE_GAP_MS;
  const previous = previousMs && previousMs >= RABBY_RECONCILE_GAP_MS ? previousMs : RABBY_RECONCILE_GAP_MS;
  return Math.min(RABBY_RECONCILE_BACKOFF_MAX_MS, previous * 2);
}

/** The most recent attempt's own wait applies to every wallet, so a 429 slows the whole queue. */
export function rabbySlotOpen(
  entries: Array<{ rabbyListAttemptAt?: string; rabbyListBackoffMs?: number } | null | undefined>,
  nowMs: number
): boolean {
  let latest = Number.NEGATIVE_INFINITY;
  let wait = RABBY_RECONCILE_GAP_MS;
  for (const entry of entries) {
    const at = Date.parse(entry?.rabbyListAttemptAt ?? "");
    if (!Number.isFinite(at) || at < latest) continue;
    latest = at;
    wait = entry?.rabbyListBackoffMs && entry.rabbyListBackoffMs > 0 ? entry.rabbyListBackoffMs : RABBY_RECONCILE_GAP_MS;
  }
  if (!Number.isFinite(latest)) return true;
  return nowMs - latest >= wait;
}

function protocolNetUsd(protocol: Record<string, unknown>): number {
  const reported = Number(protocol._bnProtocolTotalValue);
  if (Number.isFinite(reported) && reported !== 0) return reported;
  const items = Array.isArray(protocol.portfolio_item_list) ? protocol.portfolio_item_list : [];
  let net = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const stats = (item as Record<string, unknown>).stats;
    if (!stats || typeof stats !== "object") continue;
    const value = Number((stats as Record<string, unknown>).net_usd_value);
    if (Number.isFinite(value)) net += value;
  }
  return net;
}

function protocolReceiptKeys(protocol: Record<string, unknown>): string[] {
  const chain = String(protocol.chain || "").toLowerCase();
  if (!chain) return [];
  const keys: string[] = [];
  const items = Array.isArray(protocol.portfolio_item_list) ? protocol.portfolio_item_list : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const pool = String(row._bnPoolCa || "").toLowerCase();
    if (pool.startsWith("0x")) keys.push(`${chain}:${pool}`);
    const detail = row.detail && typeof row.detail === "object" ? (row.detail as Record<string, unknown>) : {};
    for (const listName of ["supply_token_list", "borrow_token_list", "reward_token_list"]) {
      const list = detail[listName];
      if (!Array.isArray(list)) continue;
      for (const token of list) {
        if (!token || typeof token !== "object") continue;
        const id = String((token as Record<string, unknown>).id || "").toLowerCase();
        if (id.startsWith("0x")) keys.push(`${chain}:${id}`);
      }
    }
  }
  return keys;
}

/**
 * DeFi net that is not already sitting in the filtered token list as a receipt.
 * App rows are skipped; those are added from the app chain cache instead.
 */
export function uncoveredPositionUsd(
  tokens: Array<{ chain: string; contractAddress?: string; tokenId?: string; valueUsd: number }>,
  protocols: ReadonlyArray<Record<string, unknown>> | undefined
): { usd: number; byChain: Array<{ id: string; valueUsd: number }> } {
  const remaining = tokens.map((token) => {
    const id = String(token.contractAddress || token.tokenId || "").toLowerCase();
    const chain = token.chain.toLowerCase();
    return {
      key: id.startsWith("0x") ? `${chain}:${id}` : "",
      left: Number(token.valueUsd) || 0,
    };
  });
  const byChain = new Map<string, number>();
  for (const protocol of protocols ?? []) {
    const id = String(protocol.id || "");
    const chain = String(protocol.chain || "").toLowerCase();
    if (id.startsWith("app:") || chain.startsWith("app:")) continue;
    const net = protocolNetUsd(protocol);
    if (!(net > 0.5)) continue;
    let matched = 0;
    for (const key of protocolReceiptKeys(protocol)) {
      if (matched >= net) break;
      for (const token of remaining) {
        if (token.key !== key || !(token.left > 0)) continue;
        const take = Math.min(token.left, net - matched);
        token.left -= take;
        matched += take;
      }
    }
    const extra = net - matched;
    if (extra < 0.5) continue;
    const bucket = chain || "defi";
    byChain.set(bucket, (byChain.get(bucket) || 0) + extra);
  }
  const rows = [...byChain.entries()].map(([chainId, valueUsd]) => ({ id: chainId, valueUsd: round2(valueUsd) }));
  return { usd: round2(rows.reduce((sum, row) => sum + row.valueUsd, 0)), byChain: rows };
}

export type PublishDecision = "publish" | "hold-gap" | "hold-bootstrap" | "hold-incomplete";

/**
 * The candidate is the number a successful publish writes: filtered tokens,
 * plus app USD, plus DeFi that is not already in the token list.
 * referenceUsd must be the same composition (Rabby total + app, or the
 * current published total). Without a Rabby list/total AND without a previous
 * published total, the candidate is not written (cold start). If a previous
 * total exists, gap-check against it until Rabby catches up.
 */
export function decideWalletPublish(input: {
  tokenUsd: number;
  appUsd: number;
  positionUsd: number;
  incompleteNative: boolean;
  hasRabbyList: boolean;
  /** True when Rabby total_balance is available this cycle or still within the daily window. */
  hasRabbyTotal?: boolean;
  referenceUsd: number | null;
  flowUsd: number;
  previousUsd: number;
}): {
  candidateUsd: number;
  keptUsd: number;
  decision: PublishDecision;
  unexplained: number | null;
} {
  const candidateUsd = round2(
    Math.max(0, input.tokenUsd) + Math.max(0, input.appUsd) + Math.max(0, input.positionUsd)
  );
  const kept = round2(Number(input.previousUsd) || 0);
  if (input.incompleteNative) {
    return { candidateUsd, keptUsd: kept, decision: "hold-incomplete", unexplained: null };
  }
  // Soft exit: a prior published total is enough to leave cold-start hold and
  // gap-check (vs referenceUsd, which callers set to Rabby+app or previous).
  // Otherwise Rabby 429 / empty token_list freezes every wallet forever.
  if (!input.hasRabbyList && !input.hasRabbyTotal && !(kept > 0)) {
    return { candidateUsd, keptUsd: kept, decision: "hold-bootstrap", unexplained: null };
  }
  const reference = input.referenceUsd;
  if (reference != null && Number.isFinite(reference) && (input.previousUsd > 0 || reference > 0)) {
    // Without a Rabby token_list, treat bn-web3 as primary: soft-exit moderate
    // upward corrections vs a stale previous total (e.g. 币安钱包 90k→96k).
    const blocked = binanceGapBlocked(candidateUsd, reference, input.flowUsd, {
      softUpward: !input.hasRabbyList,
    });
    if (blocked) {
      return { candidateUsd, keptUsd: kept, decision: "hold-gap", unexplained: blocked.unexplained };
    }
  }
  return { candidateUsd, keptUsd: candidateUsd, decision: "publish", unexplained: null };
}

interface KeptToken {
  raw: BnRawToken;
  price: number;
  valueUsd: number;
  native: boolean;
  stable: boolean;
  priceSource?: "coinstats";
}

function wrappedPriceFromRows(rows: BnRawToken[], chain: string): number {
  const wrapped = WRAPPED_NATIVE[chain];
  if (!wrapped) return 0;
  const symbol = NATIVE_SYMBOL[chain] || "";
  for (const row of rows) {
    if (row.chainId !== chain || row.contract !== wrapped || row.risk) continue;
    if (acceptNativePrice(chain, symbol, row.price)) return row.price;
  }
  return 0;
}

/**
 * Filter spam / unverified / illiquid / absurd rows and reprice native coins
 * from a trusted price. Binance's native tokenPrice is never used.
 */
export function valueBnWalletTokens(
  rows: BnRawToken[],
  options: {
    nativePrices?: Record<string, number>;
    marketPrices?: Record<string, number>;
    rabbyHeld?: RabbyHeldToken[];
    repeatedRounds?: Iterable<string>;
  } = {}
): BnWalletValuation {
  const trusted = expandNativePrices(options.nativePrices ?? {});
  const market = expandNativePrices(options.marketPrices ?? {});
  const repeated = new Set(options.repeatedRounds ?? []);
  const dedup = new Map<string, BnRawToken>();
  for (const row of rows) {
    const key = `${row.chainId}:${row.contract}:${row.symbol.toUpperCase()}`;
    const previous = dedup.get(key);
    if (!previous || row.amount > previous.amount) dedup.set(key, row);
  }
  const unique = [...dedup.values()];
  const dropped: Record<string, number> = {};
  const excluded: ExcludedToken[] = [];
  const kept: KeptToken[] = [];
  let incompleteNative = false;
  const drop = (raw: BnRawToken, valueUsd: number, reason: string) => {
    bump(dropped, reason);
    excluded.push({
      chain: raw.chainId,
      symbol: raw.symbol,
      amount: raw.amount,
      valueUsd: round2(Number.isFinite(valueUsd) ? valueUsd : 0),
      reason,
    });
  };

  for (const raw of unique) {
    const native = isNativeCoin(raw.chainId, raw.contract, raw.symbol);
    if (!raw.symbol || isJunkTokenSymbol(raw.symbol, raw.name)) {
      drop(raw, raw.amount * raw.price, "junk");
      continue;
    }
    if (isFakeTokenContract(raw.chainId, raw.symbol, raw.contract)) {
      drop(raw, raw.amount * raw.price, "fake");
      continue;
    }
    if (raw.risk) {
      drop(raw, raw.amount * raw.price, "risk");
      continue;
    }
    if (!(raw.amount > 0)) {
      drop(raw, 0, "zero");
      continue;
    }

    let price = raw.price;
    let priceSource: "coinstats" | undefined;
    if (native) {
      const fromCache = trusted[raw.chainId] || 0;
      const fromWrapped = wrappedPriceFromRows(unique, raw.chainId);
      const fromMarket = market[raw.chainId] || 0;
      const chosen = [fromCache, fromWrapped, fromMarket].find((candidate) =>
        acceptNativePrice(raw.chainId, raw.symbol, candidate)
      );
      if (chosen) {
        price = chosen;
        if (chosen === fromCache) priceSource = "coinstats";
      } else if (raw.amount > 1e-6) {
        incompleteNative = true;
        drop(raw, 0, "native-unpriced");
        continue;
      } else {
        drop(raw, 0, "dust");
        continue;
      }
    } else if (!(price > 0)) {
      drop(raw, 0, "unpriced");
      continue;
    }

    const stable = stableSymbol(raw.symbol);
    const known = isKnownToken(raw, native, stable);
    const rabbyOk = rabbyHolds(raw, options.rabbyHeld);
    const valueUsd = raw.amount * price;
    if (!Number.isFinite(valueUsd) || valueUsd < 0) {
      drop(raw, 0, "unpriced");
      continue;
    }
    if (valueUsd < DUST_USD) {
      drop(raw, valueUsd, "dust");
      continue;
    }
    if (stable && (price < 0.5 || price > 1.5)) {
      drop(raw, valueUsd, "bad-stable");
      continue;
    }
    if (isYieldSymbol(raw.symbol) && (price < YIELD_PRICE_BAND[0] || price > YIELD_PRICE_BAND[1])) {
      drop(raw, valueUsd, "bad-price");
      continue;
    }
    if (
      !native &&
      !stable &&
      !MAJOR_SYMBOLS.has(canonicalSymbol(raw.symbol)) &&
      isStockOrRwa(raw) &&
      (price < STOCK_PRICE_BAND[0] || price > STOCK_PRICE_BAND[1])
    ) {
      drop(raw, valueUsd, "bad-price");
      continue;
    }
    const roundKey = roundHoldingKey(raw.chainId, raw.symbol, raw.amount);
    // Same round balance on many wallets is an airdrop, even when the ticker looks familiar.
    if (roundKey && repeated.has(roundKey) && !native && !stable && !isYieldSymbol(raw.symbol) && valueUsd >= ILLIQUID_VALUE_USD) {
      drop(raw, valueUsd, "airdrop");
      continue;
    }
    if (!known && !rabbyOk && !native && valueUsd >= UNKNOWN_HOLD_USD) {
      // Once Rabby has named this wallet's tokens, anything valuable it has not
      // seen waits for the next reconcile or a manual allowlist entry.
      const seenByRabby = (options.rabbyHeld?.length ?? 0) > 0;
      const weak = raw.liquidity == null || raw.liquidity < LIQUID_KEEP_USD;
      if (seenByRabby || weak) {
        drop(raw, valueUsd, seenByRabby && !weak ? "unlisted" : "unknown");
        continue;
      }
      if (raw.verified === false) {
        drop(raw, valueUsd, "unverified");
        continue;
      }
      if (valueUsd > ABSURD_TOKEN_USD) {
        drop(raw, valueUsd, "absurd");
        continue;
      }
    }
    kept.push({ raw, price, valueUsd, native, stable, priceSource });
  }

  const list = kept;

  const chainTotals = new Map<string, number>();
  const tokens: Array<TokenLine & { chain: string }> = [];
  for (const token of list) {
    chainTotals.set(token.raw.chainId, (chainTotals.get(token.raw.chainId) || 0) + token.valueUsd);
    const kind = token.stable ? "stable" : token.native ? "native" : "spot";
    tokens.push({
      chain: token.raw.chainId,
      symbol: token.raw.symbol,
      amount: token.raw.amount,
      amountExact: token.raw.amountExact,
      valueUsd: token.valueUsd,
      valuationPrice: token.price,
      priceSource: token.priceSource,
      tokenId: token.native ? token.raw.chainId : token.raw.contract || token.raw.symbol,
      contractAddress: token.native ? undefined : token.raw.contract || undefined,
      kind,
      isCore: token.native || token.stable || token.raw.verified === true,
    });
  }
  tokens.sort((left, right) => right.valueUsd - left.valueUsd);
  const totalUsd = round2([...chainTotals.values()].reduce((sum, value) => sum + value, 0));
  const chains = [...chainTotals.entries()]
    .map(([id, valueUsd]) => ({
      id,
      name: CHAIN_NAMES[id] || id,
      valueUsd: round2(valueUsd),
    }))
    .filter((chain) => chain.valueUsd >= 0.01)
    .sort((left, right) => right.valueUsd - left.valueUsd);
  const roundHoldings: RoundHolding[] = [];
  const seenRound = new Set<string>();
  for (const raw of unique) {
    const key = roundHoldingKey(raw.chainId, raw.symbol, raw.amount);
    if (!key || seenRound.has(key)) continue;
    seenRound.add(key);
    roundHoldings.push({ chain: raw.chainId, symbol: canonicalSymbol(raw.symbol), amount: Math.round(raw.amount) });
    if (roundHoldings.length >= 40) break;
  }
  return {
    totalUsd,
    chains,
    tokens,
    incompleteNative,
    explicitEmpty: totalUsd < 0.01 && !incompleteNative,
    dropped,
    excluded,
    roundHoldings,
  };
}

export function applyBnWalletTokens(
  previous: WalletTokenCacheEntry | undefined,
  lines: Array<TokenLine & { chain: string }>,
  coveredChains: string[],
  at: string
): WalletTokenCacheEntry {
  const base = previous ?? { at: "", tokens: [], unpricedCount: 0, unpricedByChain: {}, coveredChains: [] };
  if (!coveredChains.length) return { ...base, lastAttemptAt: at };
  const covered = new Set(coveredChains);
  const rpcByKey = new Map<string, (typeof base.tokens)[number]>();
  for (const token of base.tokens) {
    if (token.quantitySource === "rpc" && covered.has(token.chain)) {
      rpcByKey.set(`${token.chain}:${tokenIdentity(token)}`, token);
    }
  }
  const tokens = lines.map((line) => {
    const rpc = rpcByKey.get(`${line.chain}:${tokenIdentity(line)}`);
    if (!rpc) return { ...line, updatedAt: at };
    const exact = Number(rpc.amountExact);
    const amount = Number.isFinite(exact) && exact >= 0 ? exact : rpc.amount;
    const price = line.valuationPrice ?? (line.amount > 0 ? line.valueUsd / line.amount : 0);
    return {
      ...line,
      amount,
      amountExact: rpc.amountExact ?? line.amountExact,
      valueUsd: amount * (price > 0 ? price : 0),
      quantitySource: "rpc" as const,
      quantityBlock: rpc.quantityBlock,
      updatedAt: rpc.updatedAt,
    };
  });
  const retained = base.tokens.filter(
    (token) => !covered.has(token.chain) && !isJunkTokenSymbol(token.symbol, "")
  );
  const inventory = { ...base.inventory };
  for (const token of tokens) {
    const id = tokenIdentity(token);
    inventory[`${token.chain}:${id}`] = {
      ...inventory[`${token.chain}:${id}`],
      amount: token.amount,
      amountExact: token.amountExact,
      updatedAt: token.quantitySource === "rpc" ? token.updatedAt || at : at,
    };
  }
  return {
    ...base,
    at,
    lastAttemptAt: at,
    lastError: undefined,
    source: "bn-web3",
    tokens: [...retained, ...tokens].sort((left, right) => right.valueUsd - left.valueUsd),
    unpricedCount: 0,
    unpricedByChain: {},
    coveredChains: [...new Set([...base.coveredChains.filter((id) => id !== "*"), ...coveredChains])],
    inventory,
  };
}

function parseMarketPrices(payload: unknown): Record<string, number> {
  const root = asRecord(payload);
  const data = root && "data" in root ? root.data : payload;
  const record = asRecord(data);
  const rows = Array.isArray(data) ? data : record && Array.isArray(record.list) ? record.list : [];
  const out: Record<string, number> = {};
  for (const item of rows) {
    const row = asRecord(item);
    if (!row) continue;
    const bnChainId = String(row.binanceChainId ?? row.chainId ?? row.chainIndex ?? "");
    const chain = chainSlugForBn(bnChainId);
    const contract = String(row.tokenContractAddress ?? row.contractAddress ?? "").trim().toLowerCase();
    const price = finite(row.price ?? row.tokenPrice);
    if (!chain || !contract || !acceptNativePrice(chain, NATIVE_SYMBOL[chain] || "", price)) continue;
    if (WRAPPED_NATIVE[chain] === contract) out[chain] = price;
  }
  return expandNativePrices(out);
}

/** One wrapped-native quote per chain, reused across wallets. A miss leaves cached or empty prices. */
export async function fetchWrappedNativePrices(
  options: { credentials?: BnWeb3Credentials; request?: typeof fetch } = {}
): Promise<Record<string, number>> {
  const now = Date.now();
  if (wrappedPriceCache && now - wrappedPriceCache.at < 10 * 60_000) return wrappedPriceCache.prices;
  if (!options.credentials && !bnWeb3Credentials()) return wrappedPriceCache?.prices ?? {};
  const pairs = Object.entries(WRAPPED_NATIVE).filter(([chain]) => BN_BY_CHAIN[chain]);
  try {
    const parts = await mapLimited(pairs, CHAIN_READ_CONCURRENCY, async ([chain, contract]) => {
      try {
        const payload = await bnWeb3Read(
          MARKET_PRICE,
          [{ binanceChainId: BN_BY_CHAIN[chain], tokenContractAddress: contract }],
          options
        );
        return parseMarketPrices(payload);
      } catch {
        return {};
      }
    });
    const prices: Record<string, number> = {};
    for (const part of parts) Object.assign(prices, part);
    if (Object.keys(prices).length) wrappedPriceCache = { at: now, prices };
    return Object.keys(prices).length ? prices : wrappedPriceCache?.prices ?? {};
  } catch {
    return wrappedPriceCache?.prices ?? {};
  }
}

export async function fetchBnWalletValuation(
  address: string,
  options: {
    nativePrices?: Record<string, number>;
    marketPrices?: Record<string, number>;
    rabbyHeld?: RabbyHeldToken[];
    repeatedRounds?: Iterable<string>;
    deadlineMs?: number;
    credentials?: BnWeb3Credentials;
    request?: typeof fetch;
    chainIds?: string[];
  } = {}
): Promise<(BnWalletValuation & { queriedChains: string[]; rawRows: BnRawToken[] }) | null> {
  const normalized = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return null;
  if (!options.credentials && !bnWeb3Credentials()) {
    if (!loggedMissingKeys) {
      loggedMissingKeys = true;
      console.warn("[wallet-total] bn_web3_keys_missing");
    }
    return null;
  }
  const chainIds = (options.chainIds?.length ? options.chainIds : bnWalletChainIds()).filter((id) => /^\d+$/.test(id));
  if (!chainIds.length) return null;
  const rows: BnRawToken[] = [];
  const queried = new Set<string>();
  try {
    const chainRows = await mapLimited(chainIds, CHAIN_READ_CONCURRENCY, async (chainId) => {
      if (options.deadlineMs != null && Date.now() >= options.deadlineMs - 1_500) {
        throw new Error("bn_web3_deadline");
      }
      const slug = chainSlugForBn(chainId);
      const seen = new Set<string>();
      const chainTokens: BnRawToken[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        if (options.deadlineMs != null && Date.now() >= options.deadlineMs - 1_500) {
          throw new Error("bn_web3_deadline");
        }
        const params = new URLSearchParams({
          address: normalized,
          chains: chainId,
          excludeRiskToken: "true",
          page: String(page),
          pageSize: String(PAGE_SIZE),
        });
        const payload = await bnWeb3Read(`${ALL_TOKEN_BALANCES}?${params.toString()}`, undefined, options);
        const parsed = extractBnRawTokens(payload);
        if (!parsed.length) break;
        let added = 0;
        for (const row of parsed) {
          const key = `${row.chainId}:${row.contract}:${row.symbol.toUpperCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          chainTokens.push(row);
          added += 1;
        }
        if (added === 0 || parsed.length < PAGE_SIZE) break;
      }
      return { slug, chainTokens };
    });
    for (const chain of chainRows) {
      if (chain.slug) queried.add(chain.slug);
      rows.push(...chain.chainTokens);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "bn_web3_failed";
    console.warn(
      `[wallet-total] bn_unavailable ${normalized.slice(0, 8)} ${/^bn_web3_[a-z0-9_]+$/.test(message) ? message : "bn_web3_failed"}`
    );
    return null;
  }
  const valuation = valueBnWalletTokens(rows, {
    nativePrices: options.nativePrices,
    marketPrices: options.marketPrices,
    rabbyHeld: options.rabbyHeld,
    repeatedRounds: options.repeatedRounds,
  });
  return { ...valuation, queriedChains: [...queried], rawRows: rows };
}

export function binanceTotalIsFresh(
  source: string | null | undefined,
  successAt: string | null | undefined,
  nowMs: number
): boolean {
  if (source !== "bn-web3") return false;
  const at = successAt ? Date.parse(successAt) : Number.NaN;
  return Number.isFinite(at) && nowMs >= at && nowMs - at < BN_TOTAL_STALE_FALLBACK_MS;
}

/** Daily check only. Over max($150, 3%) is logged; it does not change the published total. */
export function rabbyTotalDiscrepancy(
  binanceUsd: number,
  rabbyUsd: number
): { delta: number; threshold: number } | null {
  if (!Number.isFinite(binanceUsd) || !Number.isFinite(rabbyUsd)) return null;
  const delta = Math.abs(binanceUsd - rabbyUsd);
  const threshold = Math.max(150, Math.max(Math.abs(binanceUsd), Math.abs(rabbyUsd)) * 0.03);
  return delta > threshold ? { delta, threshold } : null;
}

/**
 * Binance wins whenever the read succeeded. Rabby is used only after Binance
 * has been failing longer than the stale window (or there has never been a
 * Binance total). A fresh Binance total is never replaced by Rabby.
 */
export function chooseWalletTotal(input: {
  nowMs: number;
  previousUsd: number;
  previousAtMs: number | null;
  previousSource?: string | null;
  binanceUsd: number | null;
  rabbyUsd: number | null;
}): { usd: number; source: WalletTotalChoice; status: "ok" | "error" } {
  if (input.binanceUsd != null && Number.isFinite(input.binanceUsd) && input.binanceUsd >= 0) {
    return { usd: round2(input.binanceUsd), source: "bn-web3", status: "ok" };
  }
  const age = input.previousAtMs == null ? Number.POSITIVE_INFINITY : input.nowMs - input.previousAtMs;
  // Explicit 0 is a successful Binance read. Rabby must not replace it while it is fresh.
  const freshBinance =
    input.previousSource === "bn-web3" &&
    Number.isFinite(input.previousUsd) &&
    input.previousUsd >= 0 &&
    age >= 0 &&
    age < BN_TOTAL_STALE_FALLBACK_MS;
  if (freshBinance || input.rabbyUsd == null || !Number.isFinite(input.rabbyUsd) || input.rabbyUsd < 0) {
    return {
      usd: round2(Number(input.previousUsd) || 0),
      source: "last-good",
      status: freshBinance || input.previousUsd > 0 ? "ok" : "error",
    };
  }
  return { usd: round2(input.rabbyUsd), source: "rabby", status: "ok" };
}
