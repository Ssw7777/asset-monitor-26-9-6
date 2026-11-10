import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import type {
  EncryptedSecretsBlob,
  ExchangeBalance,
  ManualAsset,
  OnchainBreakdown,
  PortfolioState,
  SnapshotPoint,
  WalletProtocolCacheEntry,
  WalletChainCacheEntry,
  WalletTokenCacheEntry,
  ZerionDefiCacheEntry,
  WalletLongtailCacheEntry,
  Wallet,
} from "./types";
import { deriveFlowEventsFromSnapshots, PERSISTED_FLOW_LIMIT, PERSISTED_FLOW_MIN_USD } from "./flows";
import { reconcileSnapshotTotalsToWallets, sanitizeOscillatingBasisBands, sanitizeOscillatingTotals, sanitizeRoundTripBasisBands, sanitizeSpuriousWalletSpikes, sanitizeValueRoundTrips } from "./onchain/snapshot-sanitize";
import { BASELINE, MIGRATION_WALLETS, SEED_MANUAL, seedWallets } from "./seed";
import { WALLET_LIMIT, normalizeAddress, PAUSED_ABSTRACT_ADDRESSES, PAUSED_ABSTRACT_RESCANNED_USD, isWalletRefreshEnabled } from "./wallets";
import { auditTokens } from "./token-audit";
import {preserveRpcProtocols} from './onchain/protocol-observation';
import {serializedFields,changedFields,deltaSql} from './store-delta';
import { cnyManualNames, manualToUsd, normalizeManualAsset, revalueManualForRate, stripCnyManualFromSnapshot } from "./manual-assets";

const DATA_DIR = path.join(process.cwd(), "data");
const LOCAL_STORE = path.join(DATA_DIR, "store.json");
const TMP_STORE = "/tmp/asset-monitor-store.json";
const TURSO_ROW_KEY = "portfolio";
/**
 * 快照每 ~1 分钟写一次。最近 24 小时保留全部（约 1440 条），更早的压成每 5 分钟 1 条
 * （6 天 × 288 ≈ 1728 条），合计 ≈ 3170 条覆盖 7 天；上限 3600 只是兜底。
 */
export const SNAPSHOT_LIMIT = 3600;
const SNAPSHOT_FULL_RES_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_THIN_BUCKET_MS = 5 * 60 * 1000;
const FLOW_DATA_VERSION = 4;
/** 保留全部快照的逐钱包 / 逐 DApp 明细（2016 条 ≈ 7 天），这样 7 天窗口也能按钱包归因。 */
const SNAPSHOT_DETAIL_KEEP = 2016;

/** Keep every snapshot from the last 24h; older ones thinned to one per 5-minute bucket. */
export function thinSnapshots(list: SnapshotPoint[], nowMs = Date.now()): SnapshotPoint[] {
  const cutoff = nowMs - SNAPSHOT_FULL_RES_MS;
  const seen = new Set<number>();
  const out: SnapshotPoint[] = [];
  for (const point of list) {
    const ms = Date.parse(point.ts);
    if (!Number.isFinite(ms) || ms >= cutoff || point.seeded) {
      out.push(point);
      continue;
    }
    const bucket = Math.floor(ms / SNAPSHOT_THIN_BUCKET_MS);
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    out.push(point);
  }
  return out;
}

const gThin = globalThis as unknown as { __amLastThinAt?: number };
/** At most every 20 min: compact old snapshots so 7 days fit under SNAPSHOT_LIMIT. */
async function maybeThinSnapshots() {
  const now = Date.now();
  if (gThin.__amLastThinAt && now - gThin.__amLastThinAt < 20 * 60 * 1000) return;
  gThin.__amLastThinAt = now;
  try {
    const n = await countSnapshots();
    if (n < 1500) return;
    await mutateStore((s) => {
      const thinned = thinSnapshots(s.snapshots, now);
      if (thinned.length !== s.snapshots.length) s.snapshots = trimSnapshots(thinned);
    });
  } catch (error) {
    console.error("[store] snapshot thinning failed", error);
  }
}

export class StoreConflictError extends Error {
  constructor(message = "Portfolio store revision conflict") {
    super(message);
    this.name = "StoreConflictError";
  }
}

function trimSnapshots(list: SnapshotPoint[]): SnapshotPoint[] {
  const sliced = list.length > SNAPSHOT_LIMIT ? list.slice(-SNAPSHOT_LIMIT) : list;
  const cutoff = sliced.length - SNAPSHOT_DETAIL_KEEP;
  if (cutoff <= 0) return sliced;
  let changed = false;
  const out = sliced.map((point, index) => {
    if (index >= cutoff || (!point.wallets && !point.dapps && !point.manualItems)) return point;
    changed = true;
    return {
      ts: point.ts,
      totalUsd: point.totalUsd,
      onchain: point.onchain,
      cex: point.cex,
      manual: point.manual,
      exchanges: point.exchanges,
      partial: point.partial,
      seeded: point.seeded,
      suppressExchangeFlows: point.suppressExchangeFlows,
      suppressManualFlows: point.suppressManualFlows,
    };
  });
  return changed ? out : sliced;
}

type GlobalCache = {
  __amStore?: PortfolioState;
  __amStoreLock?: Promise<void>;
  __amRefreshLease?: { owner: string; expiresAt: number };
};
const g = globalThis as unknown as GlobalCache;

function isServerless(): boolean {
  return !!(
    process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.FUNCTION_NAME
  );
}

function preferTurso(): boolean {
  return !!(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
}

function defaultExchanges(): ExchangeBalance[] {
  const now = new Date().toISOString();
  return [
    { exchange: "okx", balanceUsd: BASELINE.okx, lastUpdated: now, status: "baseline" },
    { exchange: "binance", balanceUsd: BASELINE.binance, lastUpdated: now, status: "baseline" },
    { exchange: "gate", balanceUsd: BASELINE.gate, lastUpdated: now, status: "baseline" },
    { exchange: "bitget", balanceUsd: BASELINE.bitget, lastUpdated: now, status: "baseline" },
  ];
}

function seedSnapshots(): SnapshotPoint[] {
  const now = Date.now();
  const points: SnapshotPoint[] = [];
  const base = BASELINE.totalUsd;
  for (let i = 48; i >= 0; i--) {
    const jitter = Math.sin(i / 3) * 180 + Math.cos(i / 7) * 90;
    const totalUsd = Math.round((base - 320 + jitter + (48 - i) * 7) * 100) / 100;
    points.push({
      ts: new Date(now - i * 30 * 60 * 1000).toISOString(),
      totalUsd,
      onchain: BASELINE.onchainUsd,
      cex: BASELINE.cexUsd,
      manual: BASELINE.manualUsd,
      exchanges: { okx: BASELINE.okx, binance: BASELINE.binance, gate: BASELINE.gate, bitget: BASELINE.bitget },
      seeded: true,
    });
  }
  points[points.length - 1].totalUsd = base;
  return points;
}

export function defaultState(): PortfolioState {
  const rate = Number(process.env.USD_CNY_RATE || "6.66") || 6.66;
  return {
    manual: SEED_MANUAL.map((m) => ({ ...m })),
    wallets: applyWalletMigrations(seedWallets()),
    exchanges: defaultExchanges(),
    snapshots: seedSnapshots(),
    flowEvents: [],
    flowBaselineAt: new Date().toISOString(),
    flowDataVersion: FLOW_DATA_VERSION,
    onchainCacheUsd: BASELINE.onchainUsd,
    lastRefresh: null,
    lastWalletObservationAt: null,
    usdCnyRate: rate,
    onchainBreakdown: null,
    tokenCache: {},
    protocolCache: {},
    chainCache: {},
    encryptedSecrets: null,
    cexValuationVersions: {},
  };
}

/**
 * 把后续新增的地址合并进已有地址库。
 * 规则：按地址（忽略大小写）去重；绝不删除、绝不覆盖用户已有条目；最多 50 条。
 */
export function applyWalletMigrations(wallets: Wallet[]): Wallet[] {
  const out = [...wallets];
  const seen = new Set(out.map((wallet) => normalizeAddress(String(wallet.address || ""))));
  const now = new Date().toISOString();
  for (const entry of MIGRATION_WALLETS) {
    const key = normalizeAddress(entry.address);
    if (seen.has(key)) continue;
    if (out.length >= WALLET_LIMIT) break;
    seen.add(key);
    out.push({
      id: `mig_${key.slice(2, 10)}`,
      name: entry.name,
      address: entry.address,
      chain: entry.chain,
      balanceUsd: 0,
      lastUpdated: null,
      status: "baseline",
      createdAt: now,
      updatedAt: now,
      lastSuccess: null,
      refreshPaused: PAUSED_ABSTRACT_ADDRESSES.has(key) || undefined,
    });
  }
  // Mark the emptied Abstract wallets as paused without deleting them.
  let pausedChanged = false;
  for (let i = 0; i < out.length; i++) {
    const key = normalizeAddress(out[i].address);
    if (!PAUSED_ABSTRACT_ADDRESSES.has(key)) continue;
    let next = out[i];
    if (next.refreshPaused !== true) {
      next = { ...next, refreshPaused: true };
      pausedChanged = true;
    }
    // Replace junk-inflated frozen totals with Abstract dust rescans (e.g. Xter5 17.27 → 0.02).
    const rescanned = PAUSED_ABSTRACT_RESCANNED_USD[key];
    if (rescanned != null && Number.isFinite(rescanned)) {
      const balanceUsd = Math.round(rescanned * 100) / 100;
      const balGap = Math.abs((Number(next.balanceUsd) || 0) - balanceUsd);
      const successGap = next.lastSuccess
        ? Math.abs((Number(next.lastSuccess.balanceUsd) || 0) - balanceUsd)
        : 0;
      if (balGap >= 0.5 || successGap >= 0.5) {
        next = {
          ...next,
          balanceUsd,
          lastSuccess: next.lastSuccess
            ? { ...next.lastSuccess, balanceUsd }
            : next.lastSuccess,
        };
        pausedChanged = true;
      }
    }
    out[i] = next;
  }
  return pausedChanged ? [...out] : out;
}

function normalizeSnapshot(raw: unknown): SnapshotPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const point = raw as Record<string, unknown>;
  const ts = typeof point.ts === "string" ? point.ts : null;
  const totalUsd = Number(point.totalUsd);
  if (!ts || !Number.isFinite(totalUsd)) return null;
  const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : undefined);
  return {
    ts,
    totalUsd,
    onchain: num(point.onchain),
    cex: num(point.cex),
    manual: num(point.manual),
    exchanges:
      point.exchanges && typeof point.exchanges === "object"
        ? (point.exchanges as Record<string, number>)
        : undefined,
    wallets:
      point.wallets && typeof point.wallets === "object"
        ? (point.wallets as Record<string, number>)
        : undefined,
    walletBasis:
      point.walletBasis && typeof point.walletBasis === "object"
        ? (point.walletBasis as Record<string, string>)
        : undefined,
    zerionWallets: Array.isArray(point.zerionWallets)
      ? point.zerionWallets.filter((item): item is string => typeof item === "string")
      : undefined,
    manualItems:
      point.manualItems && typeof point.manualItems === "object"
        ? (point.manualItems as Record<string, number>)
        : undefined,
    dapps:
      point.dapps && typeof point.dapps === "object"
        ? (point.dapps as Record<string, number>)
        : undefined,
    partial: point.partial === true ? true : undefined,
    seeded: point.seeded === true ? true : undefined,
    suppressExchangeFlows: Array.isArray(point.suppressExchangeFlows)
      ? point.suppressExchangeFlows.filter((item): item is string => typeof item === "string")
      : undefined,
    suppressManualFlows: Array.isArray(point.suppressManualFlows)
      ? point.suppressManualFlows.filter((item): item is string => typeof item === "string")
      : undefined,
  };
}



/**
 * Headline totals are the live wallet rows, not the chart series. If a flapping
 * wallet was pinned to the high/public band on the chart, show that same band
 * live — even when the gap sits under the old percent tolerance. A real step
 * larger than 12% is left alone (Gate → on-chain ~$10k).
 */
function stickFlappingWalletBalances(wallets: Wallet[], preferred: Record<string, number>): Wallet[] {
  if (!Object.keys(preferred).length) return wallets;
  let changed = false;
  const next = wallets.map((wallet) => {
    const sticky = preferred[wallet.address.toLowerCase()];
    if (sticky == null || !Number.isFinite(sticky)) return wallet;
    const current = Number(wallet.balanceUsd) || 0;
    const gap = Math.abs(current - sticky);
    // Already on the pinned band.
    if (gap < 1) return wallet;
    // Only raise (or snap) onto the preferred high/public band; never chop a
    // higher live reading down to a stale sticky.
    if (current > sticky + 1) return wallet;
    const nonPublic = wallet.source === "direct" || wallet.source === "zerion";
    // Coverage holes (Base NVDAc missing on OKX/Zerion) exceed 12% of NAV.
    // Non-public live sources always snap up onto the sticky Rabby band.
    // Public sources still use the 12% guard so a real withdrawal sticks.
    if (!nonPublic && gap > Math.abs(sticky) * 0.12) return wallet;
    changed = true;
    return { ...wallet, balanceUsd: sticky, source: "public" as const };
  });
  return changed ? next : wallets;
}

function normalizeState(raw: Partial<PortfolioState> | null | undefined): PortfolioState {
  const d = defaultState();
  if (!raw || typeof raw !== "object") return d;
  const storedWallets = Array.isArray(raw.wallets)
    ? (raw.wallets as Wallet[]).map((wallet) => ({
        ...wallet,
        createdAt: wallet?.createdAt ?? null,
        updatedAt: wallet?.updatedAt ?? wallet?.lastUpdated ?? null,
        lastSuccess: wallet?.lastSuccess ?? null,
      }))
    : d.wallets;
  const rawSnapshots = Array.isArray(raw.snapshots)
    ? raw.snapshots.map(normalizeSnapshot).filter((point): point is SnapshotPoint => point !== null)
    : [];
  // Workers Free (~10ms CPU) cannot re-sanitize ~2016 snapshots on every /api/portfolio|/api/status.
  // Set SANITIZE_ON_READ=1 only for deliberate repair jobs.
  const sanitizeOnRead = process.env.SANITIZE_ON_READ === "1";
  let stickyBands: Record<string, number> = {};
  let snapshotsOut = rawSnapshots.length ? trimSnapshots(rawSnapshots) : d.snapshots;
  let sanitizeChanged = 0;
  if (sanitizeOnRead) {
    const sanitized = sanitizeSpuriousWalletSpikes(rawSnapshots);
    const bands = sanitizeOscillatingBasisBands(sanitized.snapshots);
    const roundTrips = sanitizeRoundTripBasisBands(bands.snapshots);
    const valueTrips = sanitizeValueRoundTrips(roundTrips.snapshots);
    const totalsPinned = sanitizeOscillatingTotals(valueTrips.snapshots);
    const totalsReconciled = reconcileSnapshotTotalsToWallets(totalsPinned.snapshots);
    stickyBands = { ...bands.preferred, ...roundTrips.preferred, ...valueTrips.preferred };
    snapshotsOut = totalsReconciled.snapshots.length ? trimSnapshots(totalsReconciled.snapshots) : d.snapshots;
    sanitizeChanged =
      sanitized.changed + bands.changed + roundTrips.changed + valueTrips.changed + totalsPinned.changed + totalsReconciled.changed;
  }
  const storedFlowVersion = Number(raw.flowDataVersion) || 1;
  // Spurious spikes / source-coverage flaps (NVDAc) must not keep generating fake flows.
  const flowBaselineAt =
    storedFlowVersion >= FLOW_DATA_VERSION &&
    typeof raw.flowBaselineAt === "string" &&
    sanitizeChanged === 0
      ? raw.flowBaselineAt
      : sanitizeOnRead
        ? new Date().toISOString()
        : typeof raw.flowBaselineAt === "string"
          ? raw.flowBaselineAt
          : new Date().toISOString();
  return {
    storeRevision: typeof raw.storeRevision === "string" ? raw.storeRevision : undefined,
    rpcAudit: raw.rpcAudit,
    web3Audit: raw.web3Audit,
    transactionHistory: raw.transactionHistory,
    marketAudit: raw.marketAudit,
    manual: Array.isArray(raw.manual)
      ? raw.manual.map((item: ManualAsset) => {
          // 旧条目仅有 amountUsd：保持原值，不强制写 currency，读取时按 USDT 计。
          if (!item || typeof item !== "object") return item;
          if (item.currency === "CNY") {
            return normalizeManualAsset(item, Number(raw.usdCnyRate) || d.usdCnyRate);
          }
          return item;
        })
      : d.manual,
    // Migration runs on every read: newly required addresses appear without touching existing rows.
    wallets: stickFlappingWalletBalances(applyWalletMigrations(storedWallets), stickyBands),
    exchanges: Array.isArray(raw.exchanges) ? raw.exchanges : d.exchanges,
    snapshots: snapshotsOut,
    flowEvents:
      storedFlowVersion >= FLOW_DATA_VERSION && Array.isArray(raw.flowEvents) ? raw.flowEvents : [],
    flowBaselineAt,
    flowDataVersion: FLOW_DATA_VERSION,
    onchainCacheUsd: Number(raw.onchainCacheUsd) || d.onchainCacheUsd,
    lastRefresh: raw.lastRefresh ?? null,
    usdCnyRate: Number(raw.usdCnyRate) || d.usdCnyRate,
    onchainBreakdown:
      raw.onchainBreakdown && Array.isArray(raw.onchainBreakdown.chains) && Array.isArray(raw.onchainBreakdown.dapps)
        ? {
            ...raw.onchainBreakdown,
            // 旧版本快照没有代币聚合：补成空数组，避免前端直接崩掉
            tokens: Array.isArray(raw.onchainBreakdown.tokens) ? raw.onchainBreakdown.tokens : [],
            tokensTotalUsd: Number(raw.onchainBreakdown.tokensTotalUsd) || 0,
          }
        : null,
    tokenCache:
      raw.tokenCache && typeof raw.tokenCache === "object"
        ? (raw.tokenCache as Record<string, WalletTokenCacheEntry>)
        : {},
    protocolCache:
      raw.protocolCache && typeof raw.protocolCache === "object"
        ? (raw.protocolCache as Record<string, WalletProtocolCacheEntry>)
        : {},
    chainCache:
      raw.chainCache && typeof raw.chainCache === "object"
        ? (raw.chainCache as Record<string, WalletChainCacheEntry>)
        : {},
    zerionDefi:
      raw.zerionDefi && typeof raw.zerionDefi === "object"
        ? (raw.zerionDefi as Record<string, ZerionDefiCacheEntry>)
        : {},
    longtailCache:
      raw.longtailCache && typeof raw.longtailCache === "object"
        ? (raw.longtailCache as Record<string, WalletLongtailCacheEntry>)
        : {},
    encryptedSecrets: raw.encryptedSecrets ?? null,
    lastWalletObservationAt:
      typeof raw.lastWalletObservationAt === "string" ? raw.lastWalletObservationAt : null,
    lastFullRefreshAt: typeof raw.lastFullRefreshAt === "string" ? raw.lastFullRefreshAt : null,
    cexValuationVersions:
      raw.cexValuationVersions && typeof raw.cexValuationVersions === "object"
        ? raw.cexValuationVersions
        : {},
  };
}

function readJsonFile(filePath: string): PortfolioState | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return normalizeState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, state: PortfolioState) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

async function tursoClient() {
  // workerd/Workers: use HTTP web client (avoids node net/tls). Node/dev still fine via @libsql/client/web.
  const { createClient } = await import("@libsql/client/http");
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });
}

let schemaClient:Promise<import('@libsql/client').Client>|undefined;
async function ensureTursoSchema() {
  if(!schemaClient)schemaClient=(async()=>{
    const client = await tursoClient();
    await client.execute(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
    return client;
  })().catch(error=>{schemaClient=undefined;throw error;});
  return schemaClient;
}

/**
 * Acquire a short distributed lease so scheduled and manual refreshes cannot overwrite
 * each other. Turso is authoritative in production; memory is only the local fallback.
 */
export async function acquireRefreshLease(owner: string, ttlMs = 90_000): Promise<boolean> {
  const now = Date.now();
  const expiresAt = now + ttlMs;
  if (preferTurso()) {
    try {
      const client = await ensureTursoSchema();
      await client.execute(`
        CREATE TABLE IF NOT EXISTS refresh_leases (
          name TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      const result = await client.execute({
        sql: `INSERT INTO refresh_leases (name, owner, expires_at) VALUES (?, ?, ?)
              ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
              WHERE refresh_leases.expires_at <= ?`,
        args: ["portfolio-refresh", owner, expiresAt, now],
      });
      return result.rowsAffected === 1;
    } catch (error) {
      // Production must fail closed: a process-local fallback cannot coordinate
      // separate Vercel instances and could allow overlapping state writes.
      console.error("[store] refresh lease acquire failed", error);
      return false;
    }
  }

  const lease = g.__amRefreshLease;
  if (lease && lease.expiresAt > now && lease.owner !== owner) return false;
  g.__amRefreshLease = { owner, expiresAt };
  return true;
}

export async function releaseRefreshLease(owner: string): Promise<void> {
  if (preferTurso()) {
    try {
      const client = await ensureTursoSchema();
      await client.execute({
        sql: "DELETE FROM refresh_leases WHERE name = ? AND owner = ?",
        args: ["portfolio-refresh", owner],
      });
    } catch (error) {
      console.error("[store] refresh lease release failed", error);
    }
  }
  if (g.__amRefreshLease?.owner === owner) delete g.__amRefreshLease;
}

async function readTurso(includeHistory=true): Promise<PortfolioState | null> {
  try {
    const client = await ensureTursoSchema();
    const rs = await client.execute({
      sql: `SELECT ${includeHistory?'value':"json_remove(value,'$.snapshots','$.flowEvents') AS value"}, updated_at FROM kv_store WHERE key = ?`,
      args: [TURSO_ROW_KEY],
    });
    const row = rs.rows[0];
    if (!row) return null;
    const value = row.value as string;
    const state = normalizeState(JSON.parse(value));
    if(!includeHistory){state.snapshots=[];state.flowEvents=[];}
    state.storeRevision = String(row.updated_at || "");
    return state;
  } catch (e) {
    console.error("[store] turso read failed", e);
    throw e;
  }
}

async function writeTurso(state: PortfolioState,changes?:Record<string,string|undefined>): Promise<void> {
  try {
    const client = await ensureTursoSchema();
    const previousRevision = state.storeRevision || "";
    const nextRevision = `${new Date().toISOString()}-${randomUUID()}`;
    const nextState = { ...state, storeRevision: nextRevision };
    const delta=changes?deltaSql({...changes,storeRevision:JSON.stringify(nextRevision)}):null;
    const result = previousRevision
      ? await client.execute({
          sql: `UPDATE kv_store SET value = ${delta?.expression??'?'}, updated_at = ?
                WHERE key = ? AND updated_at = ?`,
          args: [...(delta?delta.args:[JSON.stringify(nextState)]), nextRevision, TURSO_ROW_KEY, previousRevision],
        })
      : await client.execute({
          sql: `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO NOTHING`,
          args: [TURSO_ROW_KEY, JSON.stringify(nextState), nextRevision],
        });
    if (result.rowsAffected !== 1) {
      throw new StoreConflictError();
    }
    state.storeRevision = nextRevision;
  } catch (e) {
    if (e instanceof StoreConflictError) throw e;
    console.error("[store] turso write failed", e);
    throw e;
  }
}

function readMemoryOrTmp(): PortfolioState | null {
  if (g.__amStore) return g.__amStore;
  if (isServerless()) return readJsonFile(TMP_STORE);
  return null;
}

function writeMemoryAndTmp(state: PortfolioState) {
  g.__amStore = state;
  if (isServerless() && !preferTurso()) {
    try {
      writeJsonFile(TMP_STORE, state);
    } catch {
      /* /tmp may be full — memory still holds it for warm instances */
    }
  }
}

export async function readStore(): Promise<PortfolioState> {
  if (preferTurso()) {
    const fromDb = await readTurso();
    if (fromDb) {
      writeMemoryAndTmp(fromDb);
      return fromDb;
    }
    // Turso is authoritative. A warm-memory or /tmp copy may be used only to
    // initialize a genuinely empty table, never as a revision-bearing value.
    const initial = structuredClone(readMemoryOrTmp() ?? defaultState());
    delete initial.storeRevision;
    try {
      await writeTurso(initial);
      writeMemoryAndTmp(initial);
      return initial;
    } catch (error) {
      if (!(error instanceof StoreConflictError)) throw error;
      const concurrentlyCreated = await readTurso();
      if (!concurrentlyCreated) throw error;
      writeMemoryAndTmp(concurrentlyCreated);
      return concurrentlyCreated;
    }
  }

  if (isServerless()) {
    const cached = readMemoryOrTmp();
    if (cached) return cached;
    const seeded = defaultState();
    writeMemoryAndTmp(seeded);
    return seeded;
  }

  // Local next dev / node server: durable file under data/
  const local = readJsonFile(LOCAL_STORE);
  if (local) {
    g.__amStore = local;
    return local;
  }
  const seeded = defaultState();
  writeJsonFile(LOCAL_STORE, seeded);
  g.__amStore = seeded;
  return seeded;
}

export async function writeStore(state: PortfolioState): Promise<void> {
  if (preferTurso()) {
    await writeTurso(state);
    writeMemoryAndTmp(state);
    return;
  }
  writeMemoryAndTmp(state);
  if (isServerless()) {
    // already wrote /tmp + memory
    return;
  }
  writeJsonFile(LOCAL_STORE, state);
}

export type StoreMutationResult<T> = {
  state: PortfolioState;
  result: T;
};

async function withLocalMutationLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = g.__amStoreLock ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queueTail = previous.then(() => gate);
  g.__amStoreLock = queueTail;
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (g.__amStoreLock === queueTail) delete g.__amStoreLock;
  }
}

/**
 * Apply a state change against the latest persisted revision. Turso writes use
 * optimistic concurrency; a competing writer causes a fresh read and replay of
 * the mutation instead of silently replacing its changes. Local storage has no
 * database CAS, so mutations are serialized within the process.
 *
 * Mutators may be replayed and therefore must not perform non-idempotent side
 * effects outside the supplied state object.
 */
export async function mutateStore<T>(
  mutator: (state: PortfolioState) => T | Promise<T>,
  maxAttempts = 3,
  includeHistory = true
): Promise<StoreMutationResult<T>> {
  const attempts = Math.max(1, Math.trunc(maxAttempts));
  const applyOnce = async (): Promise<StoreMutationResult<T>> => {
    // Never mutate the object cached by readStore before persistence succeeds.
    const stored=!includeHistory&&preferTurso()?await readTurso(false):await readStore();
    if(!stored)throw new Error('live_store_missing');
    const state = structuredClone(stored);
    const before=serializedFields(state);
    const result = await mutator(state);
    const changes=changedFields(before,state);
    if(!includeHistory&&('snapshots' in changes||'flowEvents' in changes))throw new Error('live_mutation_touched_history');
    // Not-due polling checks must not rewrite every historical snapshot or
    // compete with successful observations for a CAS revision.
    if(Object.keys(changes).length){
      if(preferTurso()){await writeTurso(state,changes);writeMemoryAndTmp(state);}
      else await writeStore(state);
    }
    return { state, result };
  };

  if (!preferTurso()) return withLocalMutationLock(applyOnce);

  let conflict: StoreConflictError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await applyOnce();
    } catch (error) {
      if (!(error instanceof StoreConflictError)) throw error;
      conflict = error;
    }
  }
  throw conflict ?? new StoreConflictError();
}

/** Provider observations do not download/re-upload thousands of old snapshots. */
export async function mutateLiveStore<T>(mutator:(state:PortfolioState)=>T|Promise<T>,maxAttempts=8){return mutateStore(mutator,maxAttempts,false);}
export async function readLiveStore(){
 if(!preferTurso())return readStore();
 const state=await readTurso(false);if(!state)throw new Error('live_store_missing');return state;
}

export async function countSnapshots(): Promise<number> {
  if (!preferTurso()) {
    const state = await readStore();
    return state.snapshots.length;
  }
  try {
    const client = await ensureTursoSchema();
    const rs = await client.execute({
      sql: "SELECT json_array_length(json_extract(value, '$.snapshots')) AS n FROM kv_store WHERE key = ?",
      args: [TURSO_ROW_KEY],
    });
    const n = Number(rs.rows[0]?.n ?? 0);
    return Number.isFinite(n) ? n : 0;
  } catch (error) {
    console.error("[store] snapshot count failed", error);
    return 0;
  }
}


export async function updateManual(manual: ManualAsset[]) {
  return (await mutateStore((state) => { state.manual = manual; })).state;
}

export async function upsertManual(item: ManualAsset) {
  return (await mutateStore((state) => {
    const normalized = normalizeManualAsset(item, Number(state.usdCnyRate) || 6.66);
    const idx = state.manual.findIndex((m) => m.id === normalized.id);
    if (idx >= 0) state.manual[idx] = normalized;
    else state.manual.push(normalized);
  })).state;
}

export async function deleteManual(id: string) {
  return (await mutateStore((state) => {
    state.manual = state.manual.filter((m) => m.id !== id);
  })).state;
}

export async function updateWallets(
  wallets: Wallet[],
  options: { balanceOverrides?: Record<string, number> } = {}
) {
  return (await mutateStore((state) => {
    const currentById = new Map(state.wallets.map((wallet) => [wallet.id, wallet]));
    state.wallets = wallets.map((incoming) => {
      const current = currentById.get(incoming.id);
      if (!current) return incoming;
      const hasBalanceOverride = Object.prototype.hasOwnProperty.call(
        options.balanceOverrides || {},
        incoming.id
      );
      const balanceOverride = hasBalanceOverride
        ? Number(options.balanceOverrides?.[incoming.id])
        : Number.NaN;
      if (current.address.toLowerCase() !== incoming.address.toLowerCase()) {
        return {
          ...incoming,
          balanceUsd: Number.isFinite(balanceOverride) ? balanceOverride : 0,
          lastUpdated: null,
          updatedAt: null,
          lastSuccess: null,
          status: "baseline" as const,
          source: undefined,
        };
      }
      return {
        ...incoming,
        balanceUsd: Number.isFinite(balanceOverride) ? balanceOverride : current.balanceUsd,
        lastUpdated: current.lastUpdated,
        updatedAt: current.updatedAt,
        lastSuccess: current.lastSuccess,
        status: current.status,
        source: current.source,
        refreshPaused: incoming.refreshPaused ?? current.refreshPaused,
      };
    });
    state.onchainCacheUsd = state.wallets.filter(isWalletRefreshEnabled).reduce((sum, wallet) => sum + wallet.balanceUsd, 0);
  })).state;
}

export async function updateOnchainBreakdown(onchainBreakdown: OnchainBreakdown) {
  return (await mutateStore((state) => { state.onchainBreakdown = onchainBreakdown; })).state;
}

export async function updateExchanges(exchanges: ExchangeBalance[]) {
  return (await mutateStore((state) => { state.exchanges = exchanges; })).state;
}

export async function setUsdCnyRate(rate: number) {
  return (await mutateStore((state) => {
    state.usdCnyRate = Math.round(rate * 10000) / 10000 || 6.66;
    state.manual = revalueManualForRate(state.manual, state.usdCnyRate);
  })).state;
}

export async function setEncryptedSecrets(blob: EncryptedSecretsBlob | null) {
  return (await mutateStore((state) => { state.encryptedSecrets = blob; })).state;
}

export async function updateCexValuationVersions(
  versions: NonNullable<PortfolioState["cexValuationVersions"]>
) {
  return (await mutateStore((state) => { state.cexValuationVersions = versions; })).state;
}

export async function setLastFullRefresh(at: string) {
  return (await mutateStore((state) => { state.lastFullRefreshAt = at; })).state;
}

export async function updateTokenCache(cache: Record<string, WalletTokenCacheEntry>) {
  return (await mutateStore((state) => { state.tokenCache = cache; })).state;
}

export async function updateProtocolCache(cache: Record<string, WalletProtocolCacheEntry>) {
  return (await mutateStore((state) => {
    const merged = { ...(state.protocolCache || {}) };
    for (const [address, incoming] of Object.entries(cache)) {
      const current = merged[address];
      if (!current) {
        merged[address] = incoming;
        continue;
      }
      const currentProtocolMs = new Date(current.at || 0).getTime();
      const incomingProtocolMs = new Date(incoming.at || 0).getTime();
      const currentAppMs = new Date(current.appAt || 0).getTime();
      const incomingAppMs = new Date(incoming.appAt || 0).getTime();
      merged[address] = preserveRpcProtocols(current,{
        ...current,
        ...incoming,
        ...(Number.isFinite(currentProtocolMs) && currentProtocolMs > incomingProtocolMs
          ? { at: current.at, protocols: current.protocols, lastAttemptAt: current.lastAttemptAt }
          : {}),
        ...(Number.isFinite(currentAppMs) && currentAppMs > incomingAppMs
          ? { appAt: current.appAt, apps: current.apps, appLastAttemptAt: current.appLastAttemptAt }
          : {}),
      });
    }
    state.protocolCache = merged;
  })).state;
}

export async function pushSnapshot(point: Omit<SnapshotPoint, "ts"> & { ts?: string }) {
  return (await mutateStore((s) => {
    const cnyNames = cnyManualNames(s.manual);
    if (cnyNames.size) {
      s.snapshots = s.snapshots.map((p) => stripCnyManualFromSnapshot(p, cnyNames));
    }
    const snap: SnapshotPoint = {
    ts: point.ts || new Date().toISOString(),
    totalUsd: point.totalUsd,
    onchain: point.onchain,
    cex: point.cex,
    manual: point.manual,
    exchanges: point.exchanges,
    wallets: point.wallets,
    zerionWallets: point.zerionWallets?.length ? point.zerionWallets : undefined,
    walletBasis: point.walletBasis && Object.keys(point.walletBasis).length ? point.walletBasis : undefined,
    manualItems: point.manualItems,
    dapps: point.dapps,
    partial: point.partial === true ? true : undefined,
    suppressExchangeFlows: point.suppressExchangeFlows,
    suppressManualFlows: point.suppressManualFlows,
  };
    const previous = s.snapshots.at(-1);
    if (previous && !previous.seeded && previous.wallets && snap.wallets) {
    // Also backfill all still-retained history on migration, so records visible before
    // this release become durable before their source snapshots rotate out.
      const additions = deriveFlowEventsFromSnapshots(
        s,
        [...s.snapshots, snap],
        PERSISTED_FLOW_MIN_USD
      );
      if (additions.length) {
        const existing = s.flowEvents ?? [];
        const seen = new Set(existing.map((event) => event.id));
        s.flowEvents = [...existing, ...additions.filter((event) => !seen.has(event.id))]
          .sort((left, right) => new Date(left.ts).getTime() - new Date(right.ts).getTime())
          .slice(-PERSISTED_FLOW_LIMIT);
      }
    }
    s.snapshots.push(snap);
    s.snapshots = trimSnapshots(thinSnapshots(s.snapshots));
    s.lastRefresh = snap.ts;
  })).state;
}


/**
 * Cloudflare Workers Free has ~10ms CPU. Loading 2016 snapshots into JS for
 * sanitize/normalize blows the budget (Error 1102). Append one snapshot +
 * lastRefresh via SQL json_insert without materializing history in the isolate.
 */
export async function pushSnapshotLive(point: Omit<SnapshotPoint, "ts"> & { ts?: string }) {
  if (!preferTurso()) return pushSnapshot(point);
  await maybeThinSnapshots();
  const snap: SnapshotPoint = {
    ts: point.ts || new Date().toISOString(),
    totalUsd: point.totalUsd,
    onchain: point.onchain,
    cex: point.cex,
    manual: point.manual,
    exchanges: point.exchanges,
    wallets: point.wallets,
    zerionWallets: point.zerionWallets?.length ? point.zerionWallets : undefined,
    walletBasis: point.walletBasis && Object.keys(point.walletBasis).length ? point.walletBasis : undefined,
    manualItems: point.manualItems,
    dapps: point.dapps,
    partial: point.partial === true ? true : undefined,
    suppressExchangeFlows: point.suppressExchangeFlows,
    suppressManualFlows: point.suppressManualFlows,
  };
  const snapJson = JSON.stringify(snap);
  const lastRefreshJson = JSON.stringify(snap.ts);
  let conflict: StoreConflictError | null = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const live = await readTurso(false);
      if (!live) throw new Error("live_store_missing");
      const client = await ensureTursoSchema();
      const previousRevision = live.storeRevision || "";
      const nextRevision = `${new Date().toISOString()}-${randomUUID()}`;
      // Append snapshot; if over SNAPSHOT_LIMIT, drop the oldest via json_remove $.[0] in a loop-free CASE.
      const result = await client.execute({
        sql: `UPDATE kv_store SET
                value = json_set(
                  json_set(
                    CASE
                      WHEN json_array_length(json_extract(value, '$.snapshots')) >= ?
                        THEN json_insert(json_remove(value, '$.snapshots[0]'), '$.snapshots[#]', json(?))
                      ELSE json_insert(value, '$.snapshots[#]', json(?))
                    END,
                    '$.lastRefresh',
                    json(?)
                  ),
                  '$.storeRevision',
                  json(?)
                ),
                updated_at = ?
              WHERE key = ? AND updated_at = ?`,
        args: [
          SNAPSHOT_LIMIT,
          snapJson,
          snapJson,
          lastRefreshJson,
          JSON.stringify(nextRevision),
          nextRevision,
          TURSO_ROW_KEY,
          previousRevision,
        ],
      });
      if (result.rowsAffected !== 1) throw new StoreConflictError();
      live.exchanges = live.exchanges; // keep
      live.lastRefresh = snap.ts;
      live.storeRevision = nextRevision;
      // Keep memory cache coherent for this isolate without reloading history.
      live.snapshots = [];
      live.flowEvents = [];
      writeMemoryAndTmp(live);
      return live;
    } catch (error) {
      if (!(error instanceof StoreConflictError)) throw error;
      conflict = error;
    }
  }
  throw conflict ?? new StoreConflictError();
}

export async function updateExchangesLive(exchanges: ExchangeBalance[]) {
  return (await mutateLiveStore((state) => { state.exchanges = exchanges; })).state;
}

export async function updateCexValuationVersionsLive(
  versions: NonNullable<PortfolioState["cexValuationVersions"]>
) {
  return (await mutateLiveStore((state) => { state.cexValuationVersions = versions; })).state;
}

export function computeTotals(s: PortfolioState) {
  const rate = Number(s.usdCnyRate) || 6.66;
  const manualUsd = s.manual.reduce((a, m) => a + manualToUsd(m, rate), 0);
  // Totals only sum wallets still in the refresh queue; paused Abstract dust is not noise.
  const active = s.wallets.filter(isWalletRefreshEnabled);
  const onchainUsd = active.reduce((a, w) => a + (Number(w.balanceUsd) || 0), 0);
  const cexUsd = s.exchanges.reduce((a, e) => a + (Number(e.balanceUsd) || 0), 0);
  const evmUsd = active.filter((w) => w.chain === "EVM").reduce((a, w) => a + w.balanceUsd, 0);
  const abstractUsd = s.wallets
    .filter((w) => w.chain === "ABSTRACT")
    .reduce((a, w) => a + w.balanceUsd, 0);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    manualUsd: round2(manualUsd),
    onchainUsd: round2(onchainUsd),
    cexUsd: round2(cexUsd),
    evmUsd: round2(evmUsd),
    abstractUsd: round2(abstractUsd),
    totalUsd: round2(manualUsd + onchainUsd + cexUsd),
  };
}

/**
 * Strip secrets before sending state to client.
 * Snapshot points keep only totals + per-exchange values: the per-wallet / per-DApp
 * attribution maps stay on the server and are served through `/api/changes`.
 */
export function publicState(s: PortfolioState) {
  const {
    storeRevision: _omitStoreRevision,
    rpcAudit: _omitRpcAudit,
    web3Audit: _omitWeb3Audit,
    transactionHistory: _omitTransactionHistory,
    encryptedSecrets: _omitSecrets,
    tokenCache: _omitTokenCache,
    protocolCache: _omitProtocolCache,
    chainCache: _omitChainCache,
    zerionDefi: _omitZerionDefi,
    longtailCache: _omitLongtailCache,
    flowEvents: _omitFlowEvents,
    cexValuationVersions: _omitCexValuationVersions,
    ...rest
  } = s;
  void _omitSecrets;
  void _omitRpcAudit;
  void _omitWeb3Audit;
  void _omitTransactionHistory;
  void _omitStoreRevision;
  void _omitTokenCache;
  void _omitProtocolCache;
  void _omitChainCache;
  void _omitZerionDefi;
  void _omitLongtailCache;
  void _omitFlowEvents;
  void _omitCexValuationVersions;
  const cnyNames = cnyManualNames(s.manual);
  const snapshots = s.snapshots.map((raw) => {
    const point = stripCnyManualFromSnapshot(raw, cnyNames);
    return {
      ts: point.ts,
      totalUsd: point.totalUsd,
      onchain: point.onchain,
      cex: point.cex,
      manual: point.manual,
      exchanges: point.exchanges,
      partial: point.partial,
      seeded: point.seeded,
    };
  });
  return {
    ...rest,
    onchainBreakdown: s.onchainBreakdown ? { ...s.onchainBreakdown, tokenAudit: auditTokens(s) } : s.onchainBreakdown,
    snapshots,
    snapshotCount: s.snapshots.length,
    snapshotLimit: SNAPSHOT_LIMIT,
    firstSnapshotTs: s.snapshots.length ? s.snapshots[0].ts : null,
    hasEncryptedSecrets: !!s.encryptedSecrets,
    encryptionReady: !!(process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.trim()),
  };
}
