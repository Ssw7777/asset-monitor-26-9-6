import crypto from "crypto";
import { resolveGateAccounts, type GateAccountId } from "./gate-accounts";
import { resolveCexKeys } from "../crypto";
import type { EncryptedSecretsBlob } from "../types";

export interface CexResult {
  balanceUsd: number;
  status: "ok" | "missing_keys" | "missing_passphrase" | "error";
  error?: string;
}

const BINANCE_BASE = "https://api.binance.com";
const OKX_BASE = "https://www.okx.com";
const GATE_BASE = "https://api.gateio.ws";
/** Read-only unified equity. Spot, finance/earn (including GHO lending), and other wallets are inside this total. */
export const GATE_TOTAL_BALANCE_PATH = "/api/v4/wallet/total_balance";
const BITGET_BASE = "https://api.bitget.com";

function missing(...keys: (string | undefined)[]) {
  return keys.some((k) => !k || !k.trim());
}

function roundUsd(n: number) {
  return Math.round(n * 100) / 100;
}

// ─── OKX ─────────────────────────────────────────────────────────────────────

async function okxSignedGet(
  path: string,
  apiKey: string,
  secret: string,
  passphrase: string,
  simulated: boolean,
  query = ""
): Promise<{ ok: boolean; data: any; error?: string }> {
  const ts = new Date().toISOString();
  const requestPath = query ? `${path}?${query}` : path;
  const prehash = ts + "GET" + requestPath;
  const sign = crypto.createHmac("sha256", secret).update(prehash).digest("base64");
  const headers: Record<string, string> = {
    "OK-ACCESS-KEY": apiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": passphrase,
    "Content-Type": "application/json",
  };
  if (simulated) headers["x-simulated-trading"] = "1";
  const res = await fetch(OKX_BASE + requestPath, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  const data = await res.json();
  if (!res.ok || data.code !== "0") {
    return {
      ok: false,
      data,
      error: data.msg || res.statusText || `HTTP ${res.status}`,
    };
  }
  return { ok: true, data };
}

export async function fetchOkxBalance(blob?: EncryptedSecretsBlob | null): Promise<CexResult> {
  const keys = resolveCexKeys(blob);
  const apiKey = keys.okx.apiKey;
  const secret = keys.okx.secret;
  const passphrase = keys.okx.passphrase;

  if (!missing(apiKey, secret) && missing(passphrase)) {
    return {
      balanceUsd: 0,
      status: "missing_passphrase",
      error: "OKX passphrase missing (OKX_API_PASSPHRASE or encrypted keys)",
    };
  }
  if (missing(apiKey, secret, passphrase)) {
    return { balanceUsd: 0, status: "missing_keys", error: "OKX API key/secret/passphrase not configured" };
  }

  try {
    // OKX 官方全账户估值：一次读取 Funding、Trading 与 Earn，内部划转不会改变总值。
    const valuation = await okxSignedGet(
      "/api/v5/asset/asset-valuation",
      apiKey!,
      secret!,
      passphrase!,
      keys.okx.simulated,
      "ccy=USDT"
    );
    if (!valuation.ok) {
      return { balanceUsd: 0, status: "error", error: `asset-valuation: ${valuation.error}` };
    }
    const raw = valuation.data?.data?.[0]?.totalBal;
    const total = Number(raw);
    if (raw == null || !Number.isFinite(total)) {
      return { balanceUsd: 0, status: "error", error: "OKX asset-valuation returned an invalid totalBal" };
    }
    return {
      balanceUsd: roundUsd(total),
      status: "ok",
    };
  } catch (e) {
    return { balanceUsd: 0, status: "error", error: e instanceof Error ? e.message : "okx fail" };
  }
}

// ─── Binance ─────────────────────────────────────────────────────────────────

async function binanceSigned(
  method: "GET" | "POST",
  path: string,
  apiKey: string,
  secret: string,
  extra: Record<string, string | number> = {}
): Promise<{ ok: boolean; data: any; error?: string; status: number }> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
  params.set("timestamp", String(Date.now()));
  const query = params.toString();
  const signature = crypto.createHmac("sha256", secret).update(query).digest("hex");
  const url = `${BINANCE_BASE}${path}?${query}&signature=${signature}`;
  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": apiKey },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok || (data && typeof data.code === "number" && data.code < 0)) {
    return {
      ok: false,
      data,
      status: res.status,
      error: data.msg || data.message || res.statusText || `HTTP ${res.status}`,
    };
  }
  return { ok: true, data, status: res.status };
}

export async function fetchBinanceBalance(blob?: EncryptedSecretsBlob | null): Promise<CexResult> {
  const keys = resolveCexKeys(blob);
  const apiKey = keys.binance.apiKey;
  const secret = keys.binance.secret;
  if (missing(apiKey, secret)) {
    return { balanceUsd: 0, status: "missing_keys", error: "Binance API key/secret not configured" };
  }

  try {
    // Binance 官方钱包总览：按 USDT 估值覆盖 Spot、Funding、Earn 与衍生品钱包。
    const wallets = await binanceSigned(
      "GET",
      "/sapi/v1/asset/wallet/balance",
      apiKey!,
      secret!,
      { quoteAsset: "USDT" }
    );
    if (!wallets.ok) {
      return { balanceUsd: 0, status: "error", error: `wallet-balance: ${wallets.error}` };
    }
    if (!Array.isArray(wallets.data) || wallets.data.length === 0) {
      return { balanceUsd: 0, status: "error", error: "Binance wallet-balance returned no wallets" };
    }
    let total = 0;
    for (const wallet of wallets.data) {
      const raw = wallet?.balance;
      const value = Number(raw);
      if (raw == null || !Number.isFinite(value)) {
        return { balanceUsd: 0, status: "error", error: "Binance wallet-balance returned an invalid balance" };
      }
      total += value;
    }
    return {
      balanceUsd: roundUsd(total),
      status: "ok",
    };
  } catch (e) {
    return { balanceUsd: 0, status: "error", error: e instanceof Error ? e.message : "binance fail" };
  }
}

// ─── Gate ────────────────────────────────────────────────────────────────────

async function gateSignedGet(
  urlPath: string,
  apiKey: string,
  secret: string,
  query = ""
): Promise<{ ok: boolean; data: any; error?: string }> {
  const method = "GET";
  const bodyHash = crypto.createHash("sha512").update("").digest("hex");
  const ts = Math.floor(Date.now() / 1000).toString();
  const signStr = [method, urlPath, query, bodyHash, ts].join("\n");
  const sign = crypto.createHmac("sha512", secret).update(signStr).digest("hex");
  const url = GATE_BASE + urlPath + (query ? `?${query}` : "");
  const res = await fetch(url, {
    headers: {
      KEY: apiKey,
      Timestamp: ts,
      SIGN: sign,
      Accept: "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    return {
      ok: false,
      data,
      error: typeof data === "object" ? JSON.stringify(data) : res.statusText || `HTTP ${res.status}`,
    };
  }
  return { ok: true, data };
}

export function gateEquityUsd(data: unknown): { ok: true; balanceUsd: number } | { ok: false; error: string } {
  const total = data && typeof data === "object" ? (data as { total?: Record<string, unknown> }).total : undefined;
  const raw = total?.amount;
  const amount = Number(raw);
  const unrealisedRaw = total?.unrealised_pnl;
  const borrowedRaw = total?.borrowed;
  const unrealisedPnl = unrealisedRaw == null ? 0 : Number(unrealisedRaw);
  const borrowed = borrowedRaw == null ? 0 : Number(borrowedRaw);
  if (
    raw != null &&
    Number.isFinite(amount) &&
    Number.isFinite(unrealisedPnl) &&
    Number.isFinite(borrowed)
  ) {
    // Gate 将合约未实现盈亏与杠杆借款作为独立字段返回；净资产需在总余额上加减。
    return { ok: true, balanceUsd: roundUsd(amount + unrealisedPnl - borrowed) };
  }
  return { ok: false, error: "Gate total_balance returned invalid equity fields" };
}

/** One read-only account. GET total_balance only — no trade, withdraw, or transfer. */
export async function fetchGateBalanceForKeys(
  apiKey: string | undefined,
  secret: string | undefined,
  missingError = "Gate API key/secret not configured"
): Promise<CexResult> {
  const key = apiKey?.trim();
  const secretKey = secret?.trim();
  if (missing(key, secretKey)) {
    return { balanceUsd: 0, status: "missing_keys", error: missingError };
  }

  try {
    // Unified estimated total (spot + finance/earn including GHO lending + other accounts, no double-count).
    const totalBal = await gateSignedGet(GATE_TOTAL_BALANCE_PATH, key!, secretKey!, "currency=USDT");
    if (totalBal.ok) {
      const equity = gateEquityUsd(totalBal.data);
      if (equity.ok) return { balanceUsd: equity.balanceUsd, status: "ok" };
      return { balanceUsd: 0, status: "error", error: equity.error };
    }
    // 不使用 Spot + Earn 的不完整回退；失败时由上层保留最近一次完整总额。
    return { balanceUsd: 0, status: "error", error: `total_balance: ${totalBal.error}` };
  } catch (e) {
    return { balanceUsd: 0, status: "error", error: e instanceof Error ? e.message : "gate fail" };
  }
}

export async function fetchGateBalance(blob?: EncryptedSecretsBlob | null): Promise<CexResult> {
  const keys = resolveCexKeys(blob);
  return fetchGateBalanceForKeys(keys.gate.apiKey, keys.gate.secret);
}

export interface GateAccountResult extends CexResult {
  id: GateAccountId;
  label: string;
}

/**
 * Personal account is always returned (missing keys stay missing_keys).
 * Mom and brother are omitted when their env pair is absent, so a refresh
 * does not crash or go partial just because a family account is not configured.
 */
export async function fetchConfiguredGateAccounts(
  blob?: EncryptedSecretsBlob | null
): Promise<GateAccountResult[]> {
  const accounts = resolveGateAccounts(blob);
  return Promise.all(
    accounts.map(async (account) => {
      const result = await fetchGateBalanceForKeys(account.apiKey, account.secret, account.missingError);
      return { ...result, id: account.id, label: account.label };
    })
  );
}

// ─── Bitget ──────────────────────────────────────────────────────────────────

async function bitgetSignedGet(
  path: string,
  apiKey: string,
  secret: string,
  passphrase: string,
  query = ""
): Promise<{ ok: boolean; data: any; error?: string }> {
  const ts = Date.now().toString();
  const requestPath = query ? `${path}?${query}` : path;
  const prehash = ts + "GET" + requestPath;
  const sign = crypto.createHmac("sha256", secret).update(prehash).digest("base64");
  const res = await fetch(BITGET_BASE + requestPath, {
    headers: {
      "ACCESS-KEY": apiKey,
      "ACCESS-SIGN": sign,
      "ACCESS-TIMESTAMP": ts,
      "ACCESS-PASSPHRASE": passphrase,
      "Content-Type": "application/json",
      locale: "en-US",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok || data.code !== "00000") {
    return {
      ok: false,
      data,
      error: data.msg || res.statusText || `HTTP ${res.status}`,
    };
  }
  return { ok: true, data };
}

export async function fetchBitgetBalance(blob?: EncryptedSecretsBlob | null): Promise<CexResult> {
  const keys = resolveCexKeys(blob);
  const apiKey = keys.bitget.apiKey;
  const secret = keys.bitget.secret;
  const passphrase = keys.bitget.passphrase;

  if (!missing(apiKey, secret) && missing(passphrase)) {
    return {
      balanceUsd: 0,
      status: "missing_passphrase",
      error: "Bitget passphrase missing (BITGET_API_PASSPHRASE or encrypted keys)",
    };
  }
  if (missing(apiKey, secret, passphrase)) {
    return { balanceUsd: 0, status: "missing_keys", error: "Bitget API key/secret/passphrase not configured" };
  }

  try {
    // Bitget 官方全账户估值：覆盖 spot / futures / funding / earn / bots / margin。
    const overview = await bitgetSignedGet(
      "/api/v2/account/all-account-balance",
      apiKey!,
      secret!,
      passphrase!
    );
    if (!overview.ok) {
      return { balanceUsd: 0, status: "error", error: `all-account-balance: ${overview.error}` };
    }
    const rows = overview.data?.data;
    if (!Array.isArray(rows) || rows.length === 0) {
      return { balanceUsd: 0, status: "error", error: "Bitget all-account-balance returned no accounts" };
    }
    let total = 0;
    for (const row of rows) {
      const raw = row?.usdtBalance;
      const value = Number(raw);
      if (raw == null || !Number.isFinite(value)) {
        return { balanceUsd: 0, status: "error", error: "Bitget all-account-balance returned an invalid usdtBalance" };
      }
      total += value;
    }
    return { balanceUsd: roundUsd(total), status: "ok" };
  } catch (e) {
    return { balanceUsd: 0, status: "error", error: e instanceof Error ? e.message : "bitget fail" };
  }
}

