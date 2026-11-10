import { createHmac, randomUUID } from "node:crypto";

/**
 * Binance Web3 Developer Portal client — READ-ONLY DeFi positions, wallet token
 * balances, and market prices. Never call trading / transaction / calldata-build
 * endpoints from this module.
 */

const BASE = "https://web3.binance.com";

/** Only these path prefixes may leave this process. */
const READ_ONLY_ALLOW = [
  "/api/v1/defi/data/position/list",
  "/api/v1/defi/data/protocol/list",
  "/api/v1/dex/balance/supported/chain",
  "/api/v1/dex/balance/all-token-balances-by-address",
  "/api/v1/dex/market/price",
] as const;

const POSITION_LIST = "/api/v1/defi/data/position/list";
const MARKET_PRICE = "/api/v1/dex/market/price";

/** Stay under the documented 5 RPS per endpoint; leave headroom. */
const MIN_INTERVAL_MS = 250;
const MAX_ADDRESSES_PER_BATCH = 3;

export interface BnWeb3Credentials {
  key: string;
  secret: string;
}

export function bnWeb3Credentials(): BnWeb3Credentials | null {
  const key = process.env.BN_WEB3_API_KEY?.trim();
  const secret = process.env.BN_WEB3_API_SECRET?.trim();
  if (!key || !secret) return null;
  // Never fall back to exchange BINANCE_API_KEY/SECRET — different product.
  return { key, secret };
}

function assertReadOnly(path: string) {
  if (!READ_ONLY_ALLOW.some((prefix) => path === prefix || path.startsWith(prefix + "?"))) {
    throw new Error("bn_web3_non_read_endpoint");
  }
}

/** ISO-8601 UTC with millisecond precision, matching the Python connector. */
export function bnWeb3Timestamp(now = new Date()): string {
  return now.toISOString().replace(/\.(\d{3})\d*Z$/, ".$1Z");
}

/**
 * Sign: Base64(HMAC-SHA256(secret, timestamp + method + /build+path[+query] + body)).
 * Path in the signature MUST include the `/build` prefix; the request URL uses the same.
 */
export function bnWeb3Sign(
  secret: string,
  timestamp: string,
  method: "GET" | "POST",
  requestPathWithBuild: string,
  body = ""
): string {
  return createHmac("sha256", secret)
    .update(timestamp + method + requestPathWithBuild + body)
    .digest("base64");
}

export function bnWeb3Headers(
  credentials: BnWeb3Credentials,
  method: "GET" | "POST",
  requestPathWithBuild: string,
  body = "",
  timestamp = bnWeb3Timestamp(),
  nonce = randomUUID()
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": "asset-monitor/bn-web3-readonly",
    "X-OC-APIKEY": credentials.key,
    "X-OC-TIMESTAMP": timestamp,
    "X-OC-SIGN": bnWeb3Sign(credentials.secret, timestamp, method, requestPathWithBuild, body),
    "X-OC-NONCE": nonce,
  };
}

let lastRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

function waitForSlot(): Promise<void> {
  const turn = requestQueue.then(async () => {
    const delay = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now());
    if (delay) await new Promise((r) => setTimeout(r, delay));
    lastRequestAt = Date.now();
  });
  requestQueue = turn.catch(() => undefined);
  return turn;
}

export async function bnWeb3Read(
  path: string,
  body?: unknown,
  options: {
    credentials?: BnWeb3Credentials;
    request?: typeof fetch;
    maxRetries?: number;
  } = {}
): Promise<Record<string, unknown>> {
  assertReadOnly(path.split("?")[0]);
  const method: "GET" | "POST" = body === undefined ? "GET" : "POST";
  const bare = path.split("?")[0];
  const postAllowed =
    bare === POSITION_LIST || bare === "/api/v1/defi/data/protocol/list" || bare === MARKET_PRICE;
  if (method === "POST" && !postAllowed) throw new Error("bn_web3_invalid_method");
  if (method === "GET" && postAllowed) throw new Error("bn_web3_invalid_method");
  const credentials = options.credentials ?? bnWeb3Credentials();
  if (!credentials) throw new Error("bn_web3_keys_missing");

  const serialized = body === undefined ? "" : JSON.stringify(body);
  const requestPathWithBuild = "/build" + path;
  const url = BASE + requestPathWithBuild;
  const maxRetries = options.maxRetries ?? 3;
  const doFetch = options.request ?? fetch;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await waitForSlot();
    const headers = bnWeb3Headers(credentials, method, requestPathWithBuild, serialized);
    const response = await doFetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: serialized }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") || "1");
      const waitMs = Math.min(5_000, Math.max(1_000, (Number.isFinite(retryAfter) ? retryAfter : 1) * 1_000));
      if (attempt >= maxRetries) throw new Error("bn_web3_http_429");
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    const text = await response.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`bn_web3_http_${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`bn_web3_http_${response.status}`);
    }
    if (!data || String(data.code) !== "0") {
      const code = /^\d{1,8}$/.test(String(data?.code)) ? data.code : "invalid";
      throw new Error(`bn_web3_code_${code}`);
    }
    return data;
  }
  throw new Error("bn_web3_http_429");
}

/**
 * Fetch DeFi positions for up to 3 addresses. Returns the raw `data` object
 * (addresses request → addressList response) or throws. Does not touch wallet-balance APIs.
 */
export async function fetchBnPositionList(
  addresses: string[],
  options?: Parameters<typeof bnWeb3Read>[2]
): Promise<Record<string, unknown>> {
  const unique = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (!unique.length) throw new Error("bn_web3_empty_addresses");
  if (unique.length > MAX_ADDRESSES_PER_BATCH) throw new Error("bn_web3_batch_too_large");
  const data = await bnWeb3Read(
    POSITION_LIST,
    { addresses: unique },
    options
  );
  const payload = data.data;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("bn_web3_invalid_position_payload");
  }
  return payload as Record<string, unknown>;
}

export const BN_WEB3_MAX_BATCH = MAX_ADDRESSES_PER_BATCH;
