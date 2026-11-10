import type { TokenLine } from "../types";
import { nextZerionKey, zerionKeys, zerionRequest } from "./zerion-keys";
import { readZerionPositionPages, type PositionPartialReason } from "./zerion-position-parser";
import { isDustTokenValue, isJunkTokenSymbol } from "./junk-tokens";

export type TokenSource = "debank" | "zerion" | "rabby-public" | "none";

export interface ProviderToken extends TokenLine {
  chain: string;
  /** Provider-qualified identity; do not group assets by ticker alone. */
  assetId?: string;
  contractAddress?: string;
  /** Lossless provider decimal; amount remains a Number for existing chart consumers. */
  amountExact?: string;
}

export interface ProviderResult {
  tokens: ProviderToken[];
  unpricedCount: number;
  unpricedByChain: Record<string, number>;
  coveredChains: string[];
  /** Complete provider response, not a guarantee that the provider supports every chain. */
  complete?: boolean;
  pagesFetched?: number;
  partialReason?: PositionPartialReason;
  /** 全部原始仓位行（含 position_type），供直连层做仓位代币分类。 */
  raw?: Array<{ symbol: string; chain: string; type: string; amount: number; valueUsd: number }>;
}

const STABLE_SYMBOLS = new Set([
  "USDT", "USDC", "USDG", "USDE", "USD1", "USDT0", "USD0", "DAI", "FDUSD", "TUSD",
  "BUSD", "USDD", "PYUSD", "GHO", "USDS", "SUSDE", "SUSDS", "FRAX", "LUSD", "USDX",
  "USDP", "USDR", "USDF", "USDY", "SUSD", "CRVUSD",
]);

const MIN_VALUE_USD = 0.01;

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function tokenKind(symbol: string, isCore: boolean): TokenLine["kind"] {
  const upper = symbol.toUpperCase();
  if (STABLE_SYMBOLS.has(upper)) return "stable";
  if (upper.endsWith(".E") && STABLE_SYMBOLS.has(upper.slice(0, -2))) return "stable";
  return isCore ? "native" : "spot";
}

/**
 * 各家数据源的链 id 不统一（ethereum / eth / eth-mainnet …）。
 * 统一映射到本项目的 DeBank 链 id，避免同一个链被拆成两张卡片。
 */
const CHAIN_ALIASES: Record<string, string> = {
  ethereum: "eth",
  mainnet: "eth",
  "eth-mainnet": "eth",
  eth: "eth",
  "binance-smart-chain": "bsc",
  "bsc-mainnet": "bsc",
  bnb: "bsc",
  bsc: "bsc",
  polygon: "matic",
  "polygon-mainnet": "matic",
  matic: "matic",
  arbitrum: "arb",
  "arbitrum-mainnet": "arb",
  arb: "arb",
  "optimism-mainnet": "op",
  optimism: "op",
  op: "op",
  "base-mainnet": "base",
  base: "base",
  "avalanche-mainnet": "avax",
  avalanche: "avax",
  avax: "avax",
  "zksync-era": "era",
  "zksync": "era",
  era: "era",
  scroll: "scrl",
  scrl: "scrl",
  linea: "linea",
  abstract: "abs",
  abs: "abs",
  "x-layer": "xlayer",
  xlayer: "xlayer",
  okbc: "xlayer",
  okbchain: "xlayer",
  "okex-chain": "xlayer",
  "x-layer-mainnet": "xlayer",
  blast: "blast",
  celo: "celo",
  gnosis: "xdai",
  "gnosis-chain": "xdai",
  gnosischain: "xdai",
  xdai: "xdai",
  mantle: "mnt",
  mnt: "mnt",
  berachain: "bera",
  bera: "bera",
  ronin: "ron",
  ron: "ron",
  ink: "ink",
  zora: "zora",
  mode: "mode",
  taiko: "taiko",
  world: "world",
  "world-chain": "world",
  unichain: "uni",
  uni: "uni",
  monad: "monad",
  megaeth: "megaeth",
  apechain: "ape",
  ape: "ape",
  rootstock: "rsk",
  rsk: "rsk",
  opbnb: "opbnb",
  core: "core",
  merlin: "merlin",
  gravity: "gravity",
  plume: "plume",
  hyperevm: "hyper",
  hyper: "hyper",
  sonic: "sonic",
  fraxtal: "frax",
  "robinhood-chain": "hood",
  robinhood: "hood",
  hood: "hood",
  katana: "katana",
  bob: "bob",
  plasma: "plasma",
  stable: "stable",
  sei: "sei",
  kava: "kava",
  "kava-mainnet": "kava",
  kaia: "klay",
  klaytn: "klay",
  klay: "klay",
  manta: "manta",
  metis: "metis",
  flare: "flr",
  flr: "flr",
  fuse: "fuse",
  bittorrent: "btt",
  "cronos-mainnet": "cro",
  cronos: "cro",
  cro: "cro",
  solana: "solana",
};

export function normalizeChainId(raw: string): string {
  const key = String(raw || "").trim().toLowerCase();
  if (!key) return "unknown";
  return CHAIN_ALIASES[key] || key;
}

/** 当前生效的代币数据源（在环境变量里按优先级选择）。 */
export function activeTokenSource(): TokenSource {
  if (process.env.DEBANK_ACCESS_KEY) return "debank";
  if (zerionKeys().length) return "zerion";
  return "rabby-public";
}

function collect(
  rows: Array<Omit<ProviderToken, "kind" | "isCore"> & { isCore?: boolean }>
): ProviderResult {
  const tokens: ProviderToken[] = [];
  const unpricedByChain: Record<string, number> = {};
  let unpricedCount = 0;
  for (const row of rows) {
    const symbol = String(row.symbol || "").trim();
    if (!symbol || isJunkTokenSymbol(symbol)) continue;
    const amount = number(row.amount);
    if (!amount) continue;
    const valueUsd = Math.abs(number(row.valueUsd));
    if (valueUsd < MIN_VALUE_USD || isDustTokenValue(valueUsd)) {
      unpricedCount += 1;
      unpricedByChain[row.chain] = (unpricedByChain[row.chain] || 0) + 1;
      continue;
    }
    tokens.push({
      symbol,
      amount,
      valueUsd,
      tokenId: String(row.tokenId || symbol),
      kind: tokenKind(symbol, row.isCore === true || row.tokenId===row.chain),
      isCore: row.isCore === true || row.tokenId===row.chain,
      logoUrl: row.logoUrl,
      chain: row.chain,
      assetId: row.assetId,
      contractAddress: row.contractAddress,
      amountExact: row.amountExact,
    });
  }
  tokens.sort((left, right) => right.valueUsd - left.valueUsd);
  return { tokens, unpricedCount, unpricedByChain, coveredChains: [] as string[] };
}

/**
 * Zerion 服务商覆盖范围内的仓位；分页未完成绝不可当作全量缓存。
 * 官方文档：https://developers.zerion.io — 用 Basic 认证，key 作为用户名。
 */
export async function fetchZerionTokens(
  address: string,
  opts: {
    deadlineMs?: number;
    includeAllPositions?: boolean;
    maxPages?: number;
    beforeRequest?: () => boolean | Promise<boolean>;
  } = {}
): Promise<ProviderResult | null> {
  const key = nextZerionKey();
  if (!key) return null;
  const deadlineMs = opts.deadlineMs ?? Date.now() + 20_000;
  if (deadlineMs - Date.now() < 750) return null;
  const filter = opts.includeAllPositions ? "no_filter" : "only_simple";
  const initialUrl = `https://api.zerion.io/v1/wallets/${encodeURIComponent(address)}/positions/?currency=usd&filter[positions]=${filter}&filter[trash]=only_non_trash`;
  const pages = await readZerionPositionPages(initialUrl, (url) => zerionRequest(async () => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs < 750) throw new Error("zerion_deadline");
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
        Accept: "application/json",
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(20_000, remainingMs)),
    });
    return { status: response.status, body: response.status === 200 ? await response.json() : null };
  }), normalizeChainId, { ...opts, deadlineMs });
  if (!pages) return null;
  const result = collect(pages.rows);
  result.complete = pages.complete;
  result.pagesFetched = pages.pagesFetched;
  result.partialReason = pages.partialReason;
  result.coveredChains = pages.complete ? ["*"] : [];
  result.raw = pages.rows.map((row) => ({
    symbol: row.symbol,
    chain: row.chain,
    type: row.type,
    amount: row.amount,
    valueUsd: row.valueUsd,
  }));
  return result;
}
