import {
  fetchBinanceBalance,
  fetchBitgetBalance,
  fetchConfiguredGateAccounts,
  fetchOkxBalance,
  type CexResult,
} from "@/lib/cex/balances";
import { retirePublishedGateStubs } from "@/lib/cex/gate-accounts";
import {
  parseAppDetail,
  parseProtocolDetail,
  parseTotalDetail,
  refreshOnchainBreakdown,
  refreshWallets,
} from "@/lib/onchain/debank";
import { fetchZerionAppAudit, type ZerionAppAudit } from "@/lib/onchain/direct";
import { BASELINE } from "@/lib/seed";
import { walletFreshness } from "@/lib/freshness";
import {
  computeTotals,
  mutateStore,
  mutateLiveStore,
  publicState,
  pushSnapshot,
  pushSnapshotLive,
  readStore,
  readLiveStore,
  updateCexValuationVersions,
  updateCexValuationVersionsLive,
  writeStore,
} from "@/lib/store";
import type { ExchangeBalance, PortfolioState } from "@/lib/types";
import { applySpecificTokenObservation, applyTokenObservation, parseRabbyTokenObservation, tokenUuid } from "@/lib/onchain/rabby-token-observation";
import { auditTokens } from "@/lib/token-audit";
import { isJunkTokenSymbol } from "@/lib/onchain/junk-tokens";
import { shouldRejectTotalUpdate, comparedTokensFromLines } from "@/lib/onchain/total-calibration";
import { binanceTotalIsFresh, countWalletBatch, rabbyTotalDiscrepancy } from "@/lib/onchain/bn-wallet-balance";
import { activeRefreshWallets, isWalletRefreshEnabled } from "./wallets";
import { isCryptoManual, manualToUsd, sumManualCryptoUsd } from "./manual-assets";

const APP_AUDIT_REFRESH_MS = 5.5 * 60 * 60 * 1000;
const APP_AUDIT_BATCH_SIZE = 10;
const APP_AUDIT_RUN_BUDGET_MS = 40_000;
// Failed App-only audits must not consume ten requests every five minutes.
// This is separate from the Rabby wallet-balance refresh cadence.
const APP_AUDIT_RETRY_MS = 3 * 60 * 60 * 1000;

type AppAuditResult = {
  address: string;
  observedAt: string;
  audit: ZerionAppAudit;
};

function timestampMs(value: string | null | undefined) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Refresh the App-only part of the wallet total without touching its canonical
 * Rabby balance timestamp. Zerion is intentionally restricted by
 * `fetchZerionAppAudit` to App-native assets (currently Polymarket), so normal
 * protocol deposits cannot be added to the wallet total a second time.
 *
 * Network reads happen before the mutation. The successful observations are
 * then replay-safe: on every CAS retry we compare timestamps against the latest
 * state, replace only `app:*` allocations, and rebuild the aggregate once.
 */
async function refreshStaleAppAudits(seedState: PortfolioState) {
  const nowMs = Date.now();
  const targets = [...seedState.wallets].filter(isWalletRefreshEnabled)
    .filter((wallet) => {
      const entry = seedState.protocolCache?.[wallet.address.toLowerCase()];
      const appAt = entry?.appAt;
      const appAtMs = timestampMs(appAt);
      const lastAttempt = timestampMs(entry?.appLastAttemptAt);
      const tokens = seedState.tokenCache?.[wallet.address.toLowerCase()];
      // One-time metadata migration reuses the existing App response. No second provider read.
      const legacyIdentities = !tokens?.identityAttemptAt && tokens?.tokens.some(token => !tokenUuid(token));
      return legacyIdentities || (appAtMs === 0 || nowMs - appAtMs >= APP_AUDIT_REFRESH_MS) &&
        (lastAttempt === 0 || nowMs - lastAttempt >= APP_AUDIT_RETRY_MS);
    })
    .sort((left, right) => {
      const leftEntry = seedState.protocolCache?.[left.address.toLowerCase()];
      const rightEntry = seedState.protocolCache?.[right.address.toLowerCase()];
      return (
        timestampMs(leftEntry?.appAt) - timestampMs(rightEntry?.appAt) ||
        timestampMs(leftEntry?.appLastAttemptAt) - timestampMs(rightEntry?.appLastAttemptAt) ||
        left.address.localeCompare(right.address)
      );
    })
    .slice(0, APP_AUDIT_BATCH_SIZE);

  if (!targets.length) {
    return { state: seedState, attempted: 0, refreshed: 0 };
  }

  // Persist attempts before the network call, including failures/timeouts.
  // The route's distributed lease prevents concurrent schedulers reserving twice.
  const attemptedAt = new Date(nowMs).toISOString();
  const reserved = await mutateStore(async (state) => {
    const protocolCache = { ...(state.protocolCache ?? {}) };
    for (const wallet of targets) {
      const address = wallet.address.toLowerCase();
      protocolCache[address] = {
        ...(protocolCache[address] ?? { at: "", protocols: [] }),
        appLastAttemptAt: attemptedAt,
      };
      if (state.tokenCache?.[address]) state.tokenCache[address].identityAttemptAt = attemptedAt;
    }
    state.protocolCache = protocolCache;
  });

  // CEX requests already ran before this helper. Reserve enough headroom for
  // the atomic store write and snapshot within Vercel's 60 second limit.
  const deadlineMs = Date.now() + APP_AUDIT_RUN_BUDGET_MS;
  const observations = (
    await Promise.all(
      targets.map(async (wallet): Promise<AppAuditResult | null> => {
        const audit = await fetchZerionAppAudit(wallet.address, { deadlineMs });
        if (!audit) return null;
        return {
          address: wallet.address.toLowerCase(),
          observedAt: new Date().toISOString(),
          audit,
        };
      })
    )
  ).filter((entry): entry is AppAuditResult => entry !== null);

  if (!observations.length) {
    return { state: reserved.state, attempted: targets.length, refreshed: 0 };
  }

  const mutation = await mutateStore(async (state) => {
    const wallets = [...state.wallets];
    const walletIndex = new Map(
      wallets.map((wallet, index) => [wallet.address.toLowerCase(), index])
    );
    const chainCache = { ...(state.chainCache || {}) };
    const protocolCache = { ...(state.protocolCache || {}) };
    let refreshed = 0;

    for (const observation of observations) {
      const index = walletIndex.get(observation.address);
      if (index == null) continue;

      const observedMs = timestampMs(observation.observedAt);
      const tokenEntry = state.tokenCache?.[observation.address];
      if (tokenEntry && observation.audit.tokenIdentities) {
        // Match the exact old position ID; do not merge unrelated assets just by symbol.
        const identities = new Map(observation.audit.tokenIdentities.map(token => [token.positionId, token]));
        const nativeSymbols: Record<string,string> = {eth:"ETH",arb:"ETH",op:"ETH",base:"ETH",linea:"ETH",hood:"ETH",abs:"ETH",era:"ETH",scrl:"ETH",blast:"ETH",katana:"ETH",bsc:"BNB",matic:"POL",avax:"AVAX"};
        tokenEntry.tokens = tokenEntry.tokens.map(token => {
          const found = identities.get(token.tokenId);
          if (!found || found.chain !== token.chain || found.symbol.toUpperCase() !== token.symbol.toUpperCase()) return token;
          const nativeId = !found.contractAddress && nativeSymbols[found.chain] === found.symbol.toUpperCase() ? found.chain : undefined;
          return { ...token, tokenId: nativeId || found.tokenId, contractAddress: found.contractAddress, assetId: nativeId ? undefined : found.assetId };
        });
      }
      const previousProtocol = protocolCache[observation.address] ?? {
        at: "",
        protocols: [],
      };
      // A newer GitHub runner or another fast invocation already won the race.
      if (timestampMs(previousProtocol.appAt) >= observedMs) continue;

      const wallet = wallets[index];
      const previousChainEntry = chainCache[observation.address];
      const previousChains = previousChainEntry?.chains ?? [];
      const previousAppUsd = previousChains
        .filter((chain) => chain.id.startsWith("app:"))
        .reduce((sum, chain) => sum + (Number(chain.valueUsd) || 0), 0);
      const baseChains = previousChains.filter((chain) => !chain.id.startsWith("app:"));
      const appUsd = observation.audit.chains.reduce(
        (sum, chain) => sum + (Number(chain.valueUsd) || 0),
        0
      );
      const previousCombinedTotal =
        Number(previousChainEntry?.totalUsd ?? wallet.balanceUsd) || 0;
      const baseUsd = Math.max(0, previousCombinedTotal - previousAppUsd);
      const balanceUsd = Math.round((baseUsd + appUsd) * 100) / 100;
      const combinedChains = [...baseChains, ...observation.audit.chains].sort(
        (left, right) => right.valueUsd - left.valueUsd
      );

      protocolCache[observation.address] = {
        ...previousProtocol,
        apps: observation.audit.protocols,
        appAt: observation.observedAt,
        appLastAttemptAt: observation.observedAt,
      };
      chainCache[observation.address] = {
        ...previousChainEntry,
        at:
          previousChainEntry?.at ||
          wallet.lastSuccess?.at ||
          observation.observedAt,
        totalUsd: balanceUsd,
        chains: combinedChains,
      };
      wallets[index] = {
        ...wallet,
        balanceUsd,
        ...(wallet.lastSuccess
          ? { lastSuccess: { ...wallet.lastSuccess, balanceUsd } }
          : {}),
        // App completeness refines a public Rabby observation. Do not relabel a
        // legacy direct/Zerion basis, since that would fabricate a basis change.
        ...(wallet.source === "public" || wallet.source === "public-partial"
          ? { source: "public" as const }
          : {}),
      };
      refreshed += 1;
    }

    if (refreshed > 0) {
      state.wallets = wallets;
      state.chainCache = chainCache;
      state.protocolCache = protocolCache;
      state.onchainCacheUsd = wallets.filter(isWalletRefreshEnabled).reduce(
        (sum, wallet) => sum + (Number(wallet.balanceUsd) || 0),
        0
      );
      try {
        state.onchainBreakdown = await refreshOnchainBreakdown(
          wallets,
          chainCache,
          state.tokenCache || {},
          protocolCache,
          state.zerionDefi || {}
        );
      } catch (error) {
        console.error("[refresh] Zerion App audit breakdown rebuild failed", error);
      }
    }

    return refreshed;
  });

  return {
    state: mutation.state,
    attempted: targets.length,
    refreshed: mutation.result,
  };
}

/**
 * Reject CEX misreads that would sawtooth the K-line: a sudden large jump
 * while the previous OK reading is still fresh. Keep last-good balance.
 * Real deposits/withdrawals land once the prior reading ages past the window.
 */
function shouldRejectCexJump(prev: ExchangeBalance | undefined, nextUsd: number, nowMs = Date.now()): boolean {
  if (!prev || prev.status !== "ok") return false;
  const previous = Number(prev.balanceUsd);
  if (!Number.isFinite(previous) || !Number.isFinite(nextUsd)) return false;
  const prevAt = prev.lastUpdated ? Date.parse(prev.lastUpdated) : Number.NaN;
  // Only guard while the last good read is fresh (~12 min). Older gaps may be real moves.
  if (!Number.isFinite(prevAt) || nowMs < prevAt || nowMs - prevAt > 12 * 60_000) return false;
  const delta = Math.abs(nextUsd - previous);
  const scale = Math.max(previous, nextUsd, 1);
  // Night 10/16 sawtooth: reject jumps above max($400, 20%).
  if (delta < 400) return false;
  if (delta / scale < 0.2) return false;
  return true;
}

function mapExchange(
  exchange: ExchangeBalance["exchange"],
  result: CexResult,
  prev: ExchangeBalance | undefined,
  baseline: number,
  now: string
): ExchangeBalance {
  const keepBalance = result.status === "ok" ? result.balanceUsd : (prev?.balanceUsd ?? baseline);

  if (result.status === "ok") {
    if (shouldRejectCexJump(prev, result.balanceUsd)) {
      console.warn(
        `[refresh] CEX spike rejected for ${exchange}: kept ${prev?.balanceUsd} rejected ${result.balanceUsd}`
      );
      return {
        exchange,
        balanceUsd: prev?.balanceUsd ?? baseline,
        lastUpdated: prev?.lastUpdated ?? null,
        status: "ok",
      };
    }
    return { exchange, balanceUsd: result.balanceUsd, lastUpdated: now, status: "ok" };
  }
  if (result.status === "missing_passphrase") {
    return {
      exchange,
      balanceUsd: keepBalance,
      lastUpdated: prev?.lastUpdated ?? null,
      status: "missing_passphrase",
      error: result.error,
    };
  }
  if (result.status === "missing_keys") {
    return {
      exchange,
      balanceUsd: keepBalance,
      lastUpdated: prev?.lastUpdated ?? null,
      status: "missing_keys",
      error: result.error,
    };
  }
  return {
    exchange,
    balanceUsd: keepBalance,
    lastUpdated: prev?.lastUpdated ?? null,
    status: "error",
    error: result.error || "refresh failed",
  };
}

export interface RefreshResult {
  state: PortfolioState;
  walletOk: number;
  walletTotal: number;
  batchAttempted?: number;
  batchSucceeded?: number;
  totals: ReturnType<typeof computeTotals>;
  payload: Record<string, unknown>;
}

export interface WalletObservationInput {
  address: string;
  observation: unknown;
  observedAt: string;
  appObservation?: unknown;
  protocolObservation?: unknown;
  tokenObservations?: Array<{ chain: string; observation?: unknown; observedAt: string; tokenError?: string }>;
  tokenSpecificObservations?: Array<{requestedUuids: string[]; observation?: unknown; observedAt: string; tokenError?: string}>;
}

export class WalletObservationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletObservationValidationError";
  }
}

export class UnknownWalletObservationError extends Error {
  readonly addresses: string[];

  constructor(addresses: string[]) {
    super("Wallet address is not configured");
    this.name = "UnknownWalletObservationError";
    this.addresses = addresses;
  }
}

type ParsedWalletObservation = {
  normalized: string;
  observedMs: number;
  observationTime: string;
  detail: NonNullable<ReturnType<typeof parseTotalDetail>>;
  appDetail?: NonNullable<ReturnType<typeof parseAppDetail>>;
  protocolDetail?: NonNullable<ReturnType<typeof parseProtocolDetail>>;
  tokenDetails?: Array<{ chain: string; detail: ReturnType<typeof parseRabbyTokenObservation>; at: string; error?: string }>;
  tokenSpecificObservations?: WalletObservationInput["tokenSpecificObservations"];
};

function parseWalletObservations(
  observations: WalletObservationInput[]
): ParsedWalletObservation[] {
  if (!Array.isArray(observations) || observations.length < 1 || observations.length > 10) {
    throw new WalletObservationValidationError("Wallet observation batch must contain 1-10 items");
  }

  const receivedMs = Date.now();
  const seen = new Set<string>();
  return observations.map((entry) => {
    const normalized = String(entry?.address || "").trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
      throw new WalletObservationValidationError("Invalid wallet address");
    }
    if (seen.has(normalized)) {
      throw new WalletObservationValidationError("Duplicate wallet address in observation batch");
    }
    seen.add(normalized);

    const detail = parseTotalDetail(entry?.observation);
    if (!detail) {
      throw new WalletObservationValidationError("Invalid Rabby total-balance payload");
    }
    const hasAppObservation = Object.prototype.hasOwnProperty.call(entry, "appObservation");
    const appDetail = hasAppObservation ? parseAppDetail(entry.appObservation) : undefined;
    if (hasAppObservation && !appDetail) {
      throw new WalletObservationValidationError("Invalid DeBank app-list payload");
    }
    const hasProtocolObservation = Object.prototype.hasOwnProperty.call(entry, "protocolObservation");
    const protocolDetail = hasProtocolObservation
      ? parseProtocolDetail(entry.protocolObservation)
      : undefined;
    if (hasProtocolObservation && !protocolDetail) {
      throw new WalletObservationValidationError("Invalid Rabby protocol-list payload");
    }
    const observedMs = new Date(entry?.observedAt || "").getTime();
    if (
      !Number.isFinite(observedMs) ||
      observedMs > receivedMs + 60_000 ||
      observedMs < receivedMs - 15 * 60_000
    ) {
      throw new WalletObservationValidationError("Invalid wallet observation timestamp");
    }
    if (entry.tokenObservations !== undefined && (!Array.isArray(entry.tokenObservations) || entry.tokenObservations.length > 30)) throw new WalletObservationValidationError("Invalid token observations");
    const tokenDetails = entry.tokenObservations?.map(row => {
      const tokenObservedMs = Date.parse(row?.observedAt);
      if (!row || !/^[a-z0-9_-]{1,40}$/.test(row.chain) || !Number.isFinite(tokenObservedMs) || tokenObservedMs > receivedMs + 60_000 || tokenObservedMs < receivedMs - 15 * 60_000) throw new WalletObservationValidationError("Invalid token observation timestamp or chain");
      return { chain: row.chain, at: new Date(tokenObservedMs).toISOString(), detail: parseRabbyTokenObservation(row.observation, row.chain), error: /^[a-z0-9_]{1,60}$/.test(row.tokenError ?? "") ? row.tokenError : "invalid_payload" };
    });
    if (entry.tokenSpecificObservations !== undefined && (!Array.isArray(entry.tokenSpecificObservations) || entry.tokenSpecificObservations.length > 3)) throw new WalletObservationValidationError("Invalid token batches");
    for (const batch of entry.tokenSpecificObservations ?? []) {
      const at = Date.parse(batch?.observedAt);
      if (!Number.isFinite(at) || at > receivedMs + 60_000 || at < receivedMs - 15 * 60_000 || !Array.isArray(batch.requestedUuids) || batch.requestedUuids.length > 100 || batch.requestedUuids.some(id => !/^[a-z0-9_-]{1,40}:(0x[a-f0-9]{40}|[a-z0-9_-]{1,40})$/.test(id))) throw new WalletObservationValidationError("Invalid token batch identifiers or timestamp");
    }
    return {
      normalized,
      observedMs,
      observationTime: new Date(observedMs).toISOString(),
      detail,
      ...(appDetail ? { appDetail } : {}),
      ...(protocolDetail ? { protocolDetail } : {}),
      ...(tokenDetails ? { tokenDetails } : {}),
      tokenSpecificObservations: entry.tokenSpecificObservations,
    };
  });
}

/**
 * Persist a small batch of Rabby observations collected by trusted GitHub
 * runners. The store is read once, the derived breakdown is rebuilt once, and
 * the complete state is written once. `observedAt` makes retries idempotent and
 * prevents an older runner response from overwriting newer wallet data.
 */
export async function ingestWalletObservations(
  observations: WalletObservationInput[]
): Promise<RefreshResult> {
  const parsed = parseWalletObservations(observations);
  const receivedMs = Date.now();
  const mutation = await mutateStore(async (state) => {
    const walletIndexByAddress = new Map(
      state.wallets.map((wallet, index) => [wallet.address.trim().toLowerCase(), index])
    );
    const unknownAddresses = parsed
      .filter((entry) => !walletIndexByAddress.has(entry.normalized))
      .map((entry) => entry.normalized);
    if (unknownAddresses.length) throw new UnknownWalletObservationError(unknownAddresses);

    const wallets = [...state.wallets];
    const chainCache = { ...(state.chainCache || {}) };
    const protocolCache = { ...(state.protocolCache || {}) };
    const tokenCache = { ...(state.tokenCache || {}) };
    let applied = 0;
    let totalRefreshed = 0;
    let appRefreshed = 0;
    let protocolsRefreshed = 0;
    let tokensRefreshed = 0;
    let latestAppliedObservationMs = 0;

    for (const entry of parsed) {
      const walletIndex = walletIndexByAddress.get(entry.normalized)!;
      const wallet = wallets[walletIndex];
      // Paused Abstract wallets stay frozen; ignore scheduler/observation writes.
      if (!isWalletRefreshEnabled(wallet)) continue;
      const previousChains = chainCache[entry.normalized]?.chains ?? [];
      const previousAppChains = previousChains.filter((chain) => chain.id.startsWith("app:"));
      const previousAppUsd = previousAppChains.reduce(
        (sum, chain) => sum + (Number(chain.valueUsd) || 0),
        0
      );
      const previousProtocol = protocolCache[entry.normalized] ?? { at: "", protocols: [] };
      const existingSuccessMs = wallet.lastSuccess?.at
        ? new Date(wallet.lastSuccess.at).getTime()
        : Number.NaN;
      const existingAppMs = previousProtocol.appAt
        ? new Date(previousProtocol.appAt).getTime()
        : Number.NaN;
      const existingProtocolMs = previousProtocol.at
        ? new Date(previousProtocol.at).getTime()
        : Number.NaN;
      let applyTotal = !Number.isFinite(existingSuccessMs) || existingSuccessMs < entry.observedMs;
      let reconciledBn = false;
      if (applyTotal && binanceTotalIsFresh(wallet.source, wallet.lastSuccess?.at, receivedMs)) {
        const bnTokenUsd = Math.max(0, (Number(wallet.balanceUsd) || 0) - previousAppUsd);
        const gap = rabbyTotalDiscrepancy(bnTokenUsd, entry.detail.totalUsd);
        if (gap) {
          console.warn(
            `[wallet-total] reconcile ${entry.normalized.slice(0, 8)} bn=${bnTokenUsd.toFixed(2)} rabby=${entry.detail.totalUsd.toFixed(2)} delta=${gap.delta.toFixed(2)}`
          );
        }
        const existingChain = chainCache[entry.normalized];
        chainCache[entry.normalized] = {
          ...(existingChain ?? { at: wallet.lastSuccess?.at || entry.observationTime, totalUsd: wallet.balanceUsd, chains: previousChains }),
          balanceSource: "bn-web3",
          rabbyTotalAt: entry.observationTime,
          rabbyTotalUsd: entry.detail.totalUsd,
        };
        // Rabby confirms or disagrees. It does not replace a fresh Binance total.
        applyTotal = false;
        reconciledBn = true;
      }
      const applyApp =
        !!entry.appDetail &&
        (!Number.isFinite(existingAppMs) || existingAppMs < entry.observedMs);
      const applyProtocol =
        !!entry.protocolDetail &&
        (!Number.isFinite(existingProtocolMs) || existingProtocolMs < entry.observedMs);
      let applyToken = false;
      for (const batch of entry.tokenSpecificObservations ?? []) {
        tokenCache[entry.normalized] = applySpecificTokenObservation(tokenCache[entry.normalized], batch.requestedUuids, batch.observation, batch.observedAt, /^[a-z0-9_]{1,60}$/.test(batch.tokenError ?? "") ? batch.tokenError : undefined);
        applyToken = true;
      }
      for (const token of entry.tokenDetails ?? []) {
        const before = tokenCache[entry.normalized];
        const after = applyTokenObservation(before, token.detail, token.at, token.chain, token.error);
        applyToken = applyToken || after !== before;
        tokenCache[entry.normalized] = after;
        if (after !== before && token.detail) tokensRefreshed++;
      }

      if (applyApp && entry.appDetail) {
        protocolCache[entry.normalized] = {
          ...previousProtocol,
          apps: entry.appDetail.protocols,
          appAt: entry.observationTime,
          appLastAttemptAt: entry.observationTime,
        };
        appRefreshed += 1;
      }
      if (applyProtocol && entry.protocolDetail) {
        protocolCache[entry.normalized] = {
          ...(protocolCache[entry.normalized] ?? previousProtocol),
          protocols: entry.protocolDetail,
          at: entry.observationTime,
          lastAttemptAt: entry.observationTime,
        };
        protocolsRefreshed += 1;
      }

      let rejectZero = false;
      let rejectSpikeOrRisk = false;
      if (applyTotal || applyApp) {
        const appChains = applyApp && entry.appDetail ? entry.appDetail.chains : previousAppChains;
        const appUsd = appChains.reduce((sum, chain) => sum + (Number(chain.valueUsd) || 0), 0);
        const baseChains = applyTotal
          ? entry.detail.chains.filter((chain) => !chain.id.startsWith("app:"))
          : previousChains.filter((chain) => !chain.id.startsWith("app:"));
        const previousCombinedTotal = Number(chainCache[entry.normalized]?.totalUsd ?? wallet.balanceUsd) || 0;
        const baseUsd = applyTotal
          ? entry.detail.totalUsd
          : Math.max(0, previousCombinedTotal - previousAppUsd);
        const combinedChains = [...baseChains, ...appChains].sort(
          (left, right) => right.valueUsd - left.valueUsd
        );
        const balanceUsd = Math.round((baseUsd + appUsd) * 100) / 100;
        const previousBalance = Number(wallet.balanceUsd) || 0;
        const tokenEvidence = (tokenCache[entry.normalized]?.tokens ?? [])
          .filter((token) => !isJunkTokenSymbol(token.symbol))
          .reduce((sum, token) => sum + (Number(token.valueUsd) || 0), 0);
        rejectZero =
          applyTotal &&
          balanceUsd < 0.01 &&
          previousBalance >= 1 &&
          (tokenEvidence >= 5 || entry.detail.explicitEmpty !== true);
        const cachedLines = tokenCache[entry.normalized]?.tokens;
        rejectSpikeOrRisk =
          applyTotal &&
          shouldRejectTotalUpdate({
            previousUsd: previousBalance,
            nextUsd: balanceUsd,
            confirmedEmpty: entry.detail.explicitEmpty === true,
            previousTokens: cachedLines ? comparedTokensFromLines(cachedLines) : null,
            nextTokens: null,
          });
        if (rejectZero || rejectSpikeOrRisk) {
          // Keep the last-good NAV, but still stamp lastSuccess so CF/GH observations
          // that confirm a coverage flap do not leave the wallet aging past 5 minutes.
          // A Binance total keeps its own clock — a rejected Rabby row must not make it look fresh.
          if (applyTotal && wallet.source !== "bn-web3") {
            wallets[walletIndex] = {
              ...wallet,
              balanceUsd: previousBalance,
              lastUpdated: entry.observationTime,
              updatedAt: entry.observationTime,
              lastSuccess: { at: entry.observationTime, balanceUsd: previousBalance },
              status: "ok" as const,
              source: wallet.source ?? "public",
            };
          }
        } else {
        const appAt = protocolCache[entry.normalized]?.appAt;
        const appAtMs = appAt ? new Date(appAt).getTime() : Number.NaN;
        const hasCompleteAppAudit =
          Number.isFinite(appAtMs) &&
          appAtMs <= receivedMs + 60_000 &&
          receivedMs - appAtMs <= 6 * 60 * 60 * 1000;
        wallets[walletIndex] = {
          ...wallet,
          balanceUsd,
          ...(applyTotal
            ? {
                lastUpdated: entry.observationTime,
                updatedAt: entry.observationTime,
                lastSuccess: { at: entry.observationTime, balanceUsd },
                status: "ok" as const,
              }
            : wallet.lastSuccess
              ? { lastSuccess: { ...wallet.lastSuccess, balanceUsd } }
              : {}),
          source: applyTotal
            ? hasCompleteAppAudit
              ? "public"
              : "public-partial"
            : wallet.source === "bn-web3"
              ? "bn-web3"
              : hasCompleteAppAudit
                ? "public"
                : "public-partial",
        };
        chainCache[entry.normalized] = {
          ...chainCache[entry.normalized],
          at: applyTotal ? entry.observationTime : (chainCache[entry.normalized]?.at ?? entry.observationTime),
          totalUsd: balanceUsd,
          chains: combinedChains,
          balanceSource: applyTotal ? "rabby" : wallet.source === "bn-web3" ? "bn-web3" : chainCache[entry.normalized]?.balanceSource,
        };
        }
      }

      // Accepted writes and intentional keep-previous touches both refresh the clock.
      if (applyTotal) {
        totalRefreshed += 1;
        latestAppliedObservationMs = Math.max(latestAppliedObservationMs, entry.observedMs);
      }
      if (applyTotal || applyApp || applyProtocol || applyToken || reconciledBn) applied += 1;
    }

    state.wallets = wallets;
    state.chainCache = chainCache;
    state.protocolCache = protocolCache;
    state.tokenCache = tokenCache;
    if (latestAppliedObservationMs > 0) {
      const previousWalletObservationMs = state.lastWalletObservationAt
        ? new Date(state.lastWalletObservationAt).getTime()
        : 0;
      state.lastWalletObservationAt = new Date(
        Math.max(previousWalletObservationMs || 0, latestAppliedObservationMs)
      ).toISOString();
    }
    state.onchainCacheUsd = wallets.filter(isWalletRefreshEnabled).reduce(
      (sum, wallet) => sum + (Number(wallet.balanceUsd) || 0),
      0
    );
    const allWalletsFresh = wallets.filter(isWalletRefreshEnabled).every((wallet) => {
      const successMs = wallet.lastSuccess?.at
        ? new Date(wallet.lastSuccess.at).getTime()
        : Number.NaN;
      return wallet.status === "ok" && Number.isFinite(successMs) &&
        successMs <= receivedMs + 60_000 && receivedMs - successMs <= 12 * 60 * 1000;
    });
    const cacheFresh = (value: string | undefined) => {
      const valueMs = value ? new Date(value).getTime() : Number.NaN;
      return Number.isFinite(valueMs) && valueMs <= receivedMs + 60_000 &&
        receivedMs - valueMs <= 6 * 60 * 60 * 1000;
    };
    const appsStale = wallets.filter(isWalletRefreshEnabled).filter(
      (wallet) => !cacheFresh(protocolCache[wallet.address.toLowerCase()]?.appAt)
    ).length;
    const protocolsStale = wallets.filter(isWalletRefreshEnabled).filter(
      (wallet) => !cacheFresh(protocolCache[wallet.address.toLowerCase()]?.at)
    ).length;
    if (applied > 0) {
      try {
        state.onchainBreakdown = await refreshOnchainBreakdown(
          wallets,
          chainCache,
          state.tokenCache || {},
          protocolCache,
          state.zerionDefi || {}
        );
      } catch (error) {
        console.error("[refresh] observed-wallet breakdown rebuild failed", error);
      }
    }
    if (applied > 0 && allWalletsFresh && appsStale === 0 && protocolsStale === 0 && auditTokens(state, receivedMs).healthy) state.lastFullRefreshAt = new Date(receivedMs).toISOString();
    return {
      applied,
      totalRefreshed,
      appRefreshed,
      protocolsRefreshed,
      tokensRefreshed,
      appsStale,
      protocolsStale,
    };
  });

  const state = mutation.state;
  const {
    applied,
    totalRefreshed,
    appRefreshed,
    protocolsRefreshed,
    tokensRefreshed,
    appsStale,
    protocolsStale,
  } = mutation.result;
  const skipped = parsed.length - applied;

  const activeWallets = activeRefreshWallets(state.wallets);
  const walletOk = activeWallets.filter((wallet) => wallet.status === "ok").length;
  return {
    state,
    walletOk,
    walletTotal: activeWallets.length,
    batchAttempted: parsed.length,
    batchSucceeded: applied,
    totals: computeTotals(state),
    payload: {
      refreshed: applied > 0,
      refreshMode: "wallet-observations",
      refreshStatus: appsStale === 0 && protocolsStale === 0 ? "ok" : "partial",
      received: parsed.length,
      applied,
      skipped,
      appRefreshed,
      protocolsRefreshed,
      tokensRefreshed,
      totalRefreshed,
      ...(applied === 0 ? { skippedReason: "older_or_duplicate_observation" } : {}),
    },
  };
}

/** Keep the original single-observation API for callers outside the batch route. */
export async function ingestWalletObservation(
  address: string,
  rawObservation: unknown,
  observedAt?: string
): Promise<RefreshResult | null> {
  try {
    const result = await ingestWalletObservations([
      { address, observation: rawObservation, observedAt: observedAt || new Date().toISOString() },
    ]);
    result.payload.refreshMode = "wallet-observation";
    return result;
  } catch (error) {
    if (error instanceof UnknownWalletObservationError) return null;
    throw error;
  }
}

async function refreshOnchainSlice(
  state: PortfolioState,
  walletBudget: number | undefined,
  now: string,
  selection: { staleMinutes?: number; walletIds?: string[]; live?: boolean } = {}
) {
  const tokenCache = { ...(state.tokenCache || {}) };
  const protocolCache = { ...(state.protocolCache || {}) };
  const chainCache = { ...(state.chainCache || {}) };
  const defiCache = { ...(state.zerionDefi || {}) };
  const longtailCache = { ...(state.longtailCache || {}) };
  const previousSuccessById = new Map(
    state.wallets.map((wallet) => [wallet.id, wallet.lastSuccess?.at ?? null])
  );
  const previousAttemptById = new Map(
    state.wallets.map((wallet) => [wallet.id, wallet.updatedAt ?? null])
  );
  const transferRecords = Object.fromEntries(
    Object.entries(state.transactionHistory ?? {}).map(([address, entry]) => [
      address.toLowerCase(),
      (entry?.records ?? []).map((record) => ({
        minedAt: record.minedAt,
        transfers: record.transfers.map((transfer) => ({
          sender: transfer.sender,
          recipient: transfer.recipient,
          valueUsd: transfer.valueUsd,
        })),
      })),
    ])
  );
  const wallets = await refreshWallets(state.wallets, chainCache, tokenCache, protocolCache, defiCache, longtailCache, {
    budget: walletBudget,
    only: selection.walletIds,
    staleMinutes: selection.staleMinutes,
    live: selection.live,
    transferRecords,
  });
  let partial = wallets.some(
    (wallet) => wallet.status !== "ok" || wallet.source === "public-partial"
  );
  let breakdown = state.onchainBreakdown ?? null;
  // A Binance miss that keeps the last good total still finishes the round.
  // The success clock stays put, so this does not look like a fresh observation
  // and the wallet-batch circuit does not open.
  const batchProgress = countWalletBatch(
    wallets.map((wallet) => ({
      attempted: (wallet.updatedAt ?? null) !== previousAttemptById.get(wallet.id),
      status: wallet.status,
      successAt: wallet.lastSuccess?.at ?? null,
      previousSuccessAt: previousSuccessById.get(wallet.id) ?? null,
    }))
  );
  const batchAttempted = batchProgress.attempted;
  const batchSucceeded = batchProgress.succeeded;
  try {
    const onchainBreakdown = await refreshOnchainBreakdown(
      wallets,
      chainCache,
      tokenCache,
      protocolCache,
      defiCache
    );
    const previous = state.onchainBreakdown ?? null;
    // 限流时不要用“更少的成功地址”覆盖上一轮完整明细：保留旧明细，只更新限流状态。
    const richer = !previous || onchainBreakdown.successfulWallets >= previous.successfulWallets;
    const effective = richer
      ? onchainBreakdown
      : {
          ...previous,
          partial: true,
          // 保留上一轮更完整的链 / 协议明细，但代币明细只要新拿到就一定要用上
          tokens: onchainBreakdown.tokens.length ? onchainBreakdown.tokens : previous.tokens,
          tokensTotalUsd: onchainBreakdown.tokens.length
            ? onchainBreakdown.tokensTotalUsd
            : previous.tokensTotalUsd,
          tokenSource: onchainBreakdown.tokenSource || previous.tokenSource,
          cachedWallets: onchainBreakdown.cachedWallets,
          rateLimitedUntil: onchainBreakdown.rateLimitedUntil ?? null,
        };
    if (effective.successfulWallets > 0 || !previous) {
      breakdown = effective;
      partial = partial || effective.partial === true;
    }
  } catch (error) {
    // 明细接口失败时保留上一轮结果，绝不把总额清空。
    console.error("[refresh] on-chain breakdown failed", error);
  }

  // Persist via CAS-aware mutateLiveStore. Blind writeStore raced with rpc/web3
  // observation writers (they do not hold the refresh lease) and threw StoreConflictError.
  // Only merge wallets/caches this batch actually attempted so concurrent updates survive.
  if (batchAttempted === 0) {
    return { state, wallets, partial, breakdown: state.onchainBreakdown ?? breakdown, batchAttempted, batchSucceeded };
  }

  const attemptedIds = new Set(
    wallets
      .filter((wallet) => (wallet.updatedAt ?? null) !== previousAttemptById.get(wallet.id))
      .map((wallet) => wallet.id)
  );
  const attemptedAddrs = new Set(
    wallets.filter((wallet) => attemptedIds.has(wallet.id)).map((wallet) => wallet.address.toLowerCase())
  );
  const refreshedById = new Map(wallets.map((wallet) => [wallet.id, wallet]));

  const { state: persisted } = await mutateLiveStore(async (latest) => {
    latest.wallets = latest.wallets.map((wallet) =>
      attemptedIds.has(wallet.id) ? refreshedById.get(wallet.id) ?? wallet : wallet
    );
    const mergeAddr = <T,>(dest: Record<string, T> | undefined, src: Record<string, T>) => {
      const out: Record<string, T> = { ...(dest || {}) };
      for (const addr of attemptedAddrs) {
        if (Object.prototype.hasOwnProperty.call(src, addr)) out[addr] = src[addr];
      }
      return out;
    };
    latest.tokenCache = mergeAddr(latest.tokenCache, tokenCache);
    latest.protocolCache = mergeAddr(latest.protocolCache, protocolCache);
    latest.chainCache = mergeAddr(latest.chainCache, chainCache);
    latest.zerionDefi = mergeAddr(latest.zerionDefi, defiCache);
    latest.longtailCache = mergeAddr(latest.longtailCache, longtailCache);
    latest.onchainCacheUsd =
      Math.round(activeRefreshWallets(latest.wallets).reduce((total, wallet) => total + wallet.balanceUsd, 0) * 100) / 100;
    if (breakdown) {
      const previous = latest.onchainBreakdown ?? null;
      const richer = !previous || breakdown.successfulWallets >= previous.successfulWallets;
      latest.onchainBreakdown = richer || !previous
        ? breakdown
        : {
            ...previous,
            partial: true,
            tokens: breakdown.tokens.length ? breakdown.tokens : previous.tokens,
            tokensTotalUsd: breakdown.tokens.length
              ? breakdown.tokensTotalUsd
              : previous.tokensTotalUsd,
            tokenSource: breakdown.tokenSource || previous.tokenSource,
            cachedWallets: breakdown.cachedWallets,
            rateLimitedUntil: breakdown.rateLimitedUntil ?? null,
          };
    }
    if (batchProgress.observed > 0) latest.lastWalletObservationAt = now;
  });

  return {
    state: persisted,
    wallets: persisted.wallets,
    partial,
    breakdown: persisted.onchainBreakdown ?? breakdown,
    batchAttempted,
    batchSucceeded,
  };
}

/**
 * One rolling wallet-only batch. It deliberately skips CEX reads and snapshots;
 * the scheduler performs those once per five-minute cycle through fast mode.
 * `staleMinutes` 限定只刷成功时间超过阈值的地址（调度器补查批次）；
 * `walletIds` 指定单个地址立即检查（地址管理页的「检查」按钮）。
 */
export async function runWalletBatch(
  opts: { walletBudget?: number; staleMinutes?: number; walletIds?: string[]; live?: boolean } = {}
): Promise<RefreshResult> {
  const state = await readStore();
  const now = new Date().toISOString();
  const onchain = await refreshOnchainSlice(state, opts.walletBudget, now, {
    staleMinutes: opts.staleMinutes,
    walletIds: opts.walletIds,
    live: opts.live,
  });
  const finalState = onchain.state;
  const activeWallets = activeRefreshWallets(finalState.wallets);
  const walletOk = activeWallets.filter((wallet) => wallet.status === "ok").length;
  const walletUsable = activeWallets.filter(
    (wallet) => wallet.status !== "error" || wallet.balanceUsd > 0
  ).length;
  // No due wallets (all fresh within skip window, or staleMinutes filter empty) is success.
  const noDueTargets = !onchain.batchAttempted;

  return {
    state: finalState,
    walletOk,
    walletTotal: activeWallets.length,
    batchAttempted: onchain.batchAttempted,
    batchSucceeded: onchain.batchSucceeded,
    totals: computeTotals(finalState),
    payload: {
      refreshed: true,
      refreshMode: "wallet-batch",
      staleMinutes: opts.staleMinutes ?? null,
      checkedWalletIds: opts.walletIds ?? null,
      skipped: noDueTargets ? "no_due_wallets" : undefined,
      refreshStatus: noDueTargets
        ? "ok"
        : onchain.batchSucceeded === 0
          ? "failed"
          : walletOk === activeWallets.length
          ? "ok"
          : walletUsable > 0
            ? "partial"
            : "failed",
    },
  };
}

/**
 * 刷新：
 * - fast：刷新各交易所和到期的 App 原生资产审计，再写一条快照。
 *   钱包链上余额由云端分片任务按十分钟周期更新。
 * - full：交易所 + 一小批轮转地址余额 + DApp / 代币缓存补齐；云端任务连续分批调用。
 */
export async function runRefresh(
  opts: { fast?: boolean; auto?: boolean; walletBudget?: number; live?: boolean } = {}
): Promise<RefreshResult> {
  // Explicit fast must not materialize snapshot history (Workers Free ~10ms CPU / Error 1102).
  // auto still probes lastFullRefreshAt via a full read, then falls back to live writes when fast.
  const forcedFast = opts.fast === true;
  const probe = forcedFast ? await readLiveStore() : await readStore();
  // auto：用略短于 5 分钟的容差判断是否全量，避免定时器提前数秒时误判为快速刷新。
  // 计划任务存在数秒调度抖动；用 4 分钟门槛，确保 PT5M 调用不会因 4:58 而误判成 fast。
  const fullIntervalMs = 4 * 60 * 1000;
  const sinceFull = probe.lastFullRefreshAt
    ? Date.now() - new Date(probe.lastFullRefreshAt).getTime()
    : Number.MAX_SAFE_INTEGER;
  const fast = forcedFast ? true : opts.auto === true ? sinceFull < fullIntervalMs : false;
  const liveState = fast ? (forcedFast ? probe : await readLiveStore()) : probe;
  const now = new Date().toISOString();
  const blob = liveState.encryptedSecrets;

  const [okx, binance, gateAccounts, bitget] = await Promise.all([
    fetchOkxBalance(blob),
    fetchBinanceBalance(blob),
    fetchConfiguredGateAccounts(blob),
    fetchBitgetBalance(blob),
  ]);
  const gateById = new Map(gateAccounts.map((account) => [account.id, account]));
  const personalGate = gateById.get("gate") ?? {
    balanceUsd: 0,
    status: "missing_keys" as const,
    error: "Gate API key/secret not configured",
  };

  // 全账户估值口径首次成功时只建立新基准，不把“旧算法 → 新算法”的差额记成交易。
  // 家庭 Gate 账户第一次成功发布同样只建基准，避免把手动占位迁入交易所记成入金。
  const valuationVersion = 2;
  const previousVersions = liveState.cexValuationVersions ?? {};
  const cexResults: Partial<Record<ExchangeBalance["exchange"], CexResult>> = {
    okx,
    binance,
    gate: personalGate,
    bitget,
  };
  for (const id of ["gate_b", "gate_c"] as const) {
    const account = gateById.get(id);
    if (account) cexResults[id] = account;
  }
  const suppressExchangeFlows = (Object.keys(cexResults) as Array<ExchangeBalance["exchange"]>).filter(
    (exchange) => cexResults[exchange]?.status === "ok" && previousVersions[exchange] !== valuationVersion
  );

  const prevMap = Object.fromEntries(liveState.exchanges.map((item) => [item.exchange, item])) as Record<
    string,
    ExchangeBalance | undefined
  >;
  const exchanges: ExchangeBalance[] = [
    mapExchange("okx", okx, prevMap.okx, BASELINE.okx, now),
    mapExchange("binance", binance, prevMap.binance, BASELINE.binance, now),
    mapExchange("gate", personalGate, prevMap.gate, BASELINE.gate, now),
  ];
  for (const id of ["gate_b", "gate_c"] as const) {
    const account = gateById.get(id);
    if (!account) continue;
    exchanges.push(mapExchange(id, account, prevMap[id], 0, now));
  }
  exchanges.push(mapExchange("bitget", bitget, prevMap.bitget, BASELINE.bitget, now));
  // Only retire a manual stub when this refresh actually stored the live API equity.
  // A spike-rejected read keeps the previous figure and must not drop the stub.
  const publishedGate = gateAccounts.filter((account) => {
    const row = exchanges.find((item) => item.exchange === account.id);
    return account.status === "ok" && row?.status === "ok" && row.balanceUsd === account.balanceUsd;
  });
  const applied = await (fast ? mutateLiveStore : mutateStore)((state) => {
    state.exchanges = exchanges;
    const retired = retirePublishedGateStubs(state.manual, publishedGate);
    if (retired.removed.length) state.manual = retired.manual;
    return retired.removed;
  });
  const removedStubs = applied.result;
  if (removedStubs.length) {
    console.info(`[refresh] removed manual Gate stubs now covered by API: ${removedStubs.join(" | ")}`);
  }
  let latest = applied.state;
  // App audits pull Zerion and rewrite caches — skip on Workers-friendly fast lane.
  const appAudit = fast
    ? { state: latest, attempted: 0, refreshed: 0 }
    : await refreshStaleAppAudits(latest);
  latest = appAudit.state;

  let partial = latest.wallets.some(
    (wallet) => wallet.status !== "ok" || wallet.source === "public-partial"
  );
  let breakdown = latest.onchainBreakdown ?? null;

  if (!fast) {
    const onchain = await refreshOnchainSlice(latest, opts.walletBudget, now, { live: opts.live });
    latest = onchain.state;
    partial = onchain.partial;
    breakdown = onchain.breakdown;
  } else if (breakdown?.partial) {
    partial = true;
  }

  const totals = computeTotals(latest);
  // A newly written snapshot does not make old component observations current.
  partial = partial || walletFreshness(activeRefreshWallets(latest.wallets)).stale > 0 ||
    latest.exchanges.some((item) => item.status !== "ok");
  // K 线只记加密资产：人民币（链下）手动资产仍进总额 / 手动区，但不写入趋势快照。
  const rate = Number(latest.usdCnyRate) || 6.66;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const manualForChart = sumManualCryptoUsd(latest.manual, rate);
  const cryptoManualItems = latest.manual.filter(isCryptoManual);
  const snapInput = {
    totalUsd: round2(totals.onchainUsd + totals.cexUsd + manualForChart),
    onchain: totals.onchainUsd,
    cex: totals.cexUsd,
    manual: manualForChart,
    exchanges: Object.fromEntries(latest.exchanges.map((item) => [item.exchange, item.balanceUsd])),
    wallets: Object.fromEntries(latest.wallets.map((wallet) => [wallet.address.toLowerCase(), wallet.balanceUsd])),
    walletBasis: Object.fromEntries(
      latest.wallets.map((wallet) => [
        wallet.address.toLowerCase(),
        wallet.source === "direct" ? "defi" : wallet.source ?? "public",
      ])
    ),
    zerionWallets: latest.wallets
      .filter((wallet) => wallet.source === "zerion")
      .map((wallet) => wallet.address.toLowerCase()),
    manualItems: Object.fromEntries(
      cryptoManualItems.map((item) => [item.name, manualToUsd(item, rate)])
    ),
    dapps: breakdown
      ? Object.fromEntries(breakdown.dapps.map((dapp) => [dapp.name, dapp.netUsd]))
      : undefined,
    partial,
    suppressExchangeFlows: suppressExchangeFlows.length ? suppressExchangeFlows : undefined,
    suppressManualFlows: removedStubs.length ? removedStubs : undefined,
  };
  let finalState = fast ? await pushSnapshotLive(snapInput) : await pushSnapshot(snapInput);
  if (suppressExchangeFlows.length) {
    const versions = {
      ...previousVersions,
      ...Object.fromEntries(suppressExchangeFlows.map((exchange) => [exchange, valuationVersion])),
    };
    finalState = fast
      ? await updateCexValuationVersionsLive(versions)
      : await updateCexValuationVersions(versions);
  }
  const activeWallets = activeRefreshWallets(finalState.wallets);
  const walletOk = walletFreshness(activeWallets).fresh;
  // “可用”= 本轮拿到实时数据，或沿用了上次成功数据（余额依然有效）。
  // 只有所有地址都没有任何余额、交易所也全失败时，才算整体失败。
  const walletUsable = activeWallets.filter(
    (wallet) => wallet.status !== "error" || wallet.balanceUsd > 0
  ).length;
  const exchangeOk = exchanges.some((item) => item.status === "ok");

  return {
    state: finalState,
    walletOk,
    walletTotal: activeWallets.length,
    totals: computeTotals(finalState),
    payload: {
      ...publicState(finalState),
      totals: computeTotals(finalState),
      refreshed: true,
      refreshMode: fast ? "fast" : "full",
      appAuditsAttempted: appAudit.attempted,
      appAuditsRefreshed: appAudit.refreshed,
      /** 只有“一个地址、一个交易所都没读到”才算整体失败；部分成功仍算成功 */
      refreshStatus:
        walletOk === activeWallets.length && exchanges.every((item) => item.status === "ok") && !partial
          ? "ok"
          : walletUsable > 0 || exchangeOk
            ? "partial"
            : "failed",
    },
  };
}
