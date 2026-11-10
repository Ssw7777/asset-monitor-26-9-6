/**
 * Authentic wallet-total calibration (NOT token-quantity sums).
 * Sources:
 * 1) OKX OnchainOS total-value when it is strictly positive (tokens + DeFi on supported chains)
 * 2) Zerion portfolio total when OKX is missing or zero (covers chains OKX rejects)
 * An OKX zero never replaces a balance. Both sources at zero can confirm empty.
 * Never invent a total from tokenCache / RPC amounts alone.
 */
import { web3Credentials, web3Read } from "./okx-web3";
import { OKX_CHAIN_IDS } from "./okx-web3-observation";
import { nextZerionKey, zerionRequest } from "./zerion-keys";
import { isJunkTokenSymbol } from "./junk-tokens";

export type CalibrationSource = "okx-web3" | "zerion";

export interface CalibratedTotal {
  totalUsd: number;
  source: CalibrationSource;
  /** Provider covers tokens+DeFi on its chain set; App-native still comes from cache. */
  includesDefi: true;
  /**
   * True only when two independent reads agree the wallet is empty.
   * An OKX zero is never enough: unsupported chains (Abstract 2741) return 0.
   */
  confirmedEmpty: boolean;
}

function parseOkxTotal(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as Record<string, unknown>;
  if (String(envelope.code) !== "0" || !Array.isArray(envelope.data) || !envelope.data.length) return null;
  const row = envelope.data[0];
  if (!row || typeof row !== "object") return null;
  const raw = (row as Record<string, unknown>).totalValue;
  const total = Number(raw);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

/** OKX authentic total: tokens + DeFi on supported chains (assetType=0). */
export async function fetchOkxCalibratedTotal(
  address: string,
  opts: { chainIds?: string[]; deadlineMs?: number } = {}
): Promise<CalibratedTotal | null> {
  if (!web3Credentials()) return null;
  if (opts.deadlineMs != null && Date.now() >= opts.deadlineMs - 1_500) return null;
  const chains = (opts.chainIds?.length ? opts.chainIds : Object.values(OKX_CHAIN_IDS))
    .filter((id) => /^\d+$/.test(id))
    .slice(0, 50);
  if (!chains.length) return null;
  // OKX rejects some chainIndexes (e.g. Abstract 2741) and also batches that include them
  // (HTTP 400). Probe in small chunks; on chunk failure, fall back to per-chain so one
  // bad id cannot null the whole calibration.
  const CHUNK = 6;
  let totalUsd = 0;
  let gotAny = false;

  const readChunk = async (chunk: string[]) => {
    const path =
      "/api/v6/dex/balance/total-value-by-address?" +
      new URLSearchParams({
        address: address.toLowerCase(),
        chains: chunk.join(","),
        assetType: "0",
        excludeRiskToken: "1",
      });
    const payload = await web3Read(path);
    return parseOkxTotal(payload);
  };

  for (let i = 0; i < chains.length; i += CHUNK) {
    if (opts.deadlineMs != null && Date.now() >= opts.deadlineMs - 1_500) break;
    const chunk = chains.slice(i, i + CHUNK);
    try {
      const part = await readChunk(chunk);
      if (part != null) {
        totalUsd += part;
        gotAny = true;
      }
    } catch {
      for (const id of chunk) {
        if (opts.deadlineMs != null && Date.now() >= opts.deadlineMs - 1_500) break;
        try {
          const part = await readChunk([id]);
          if (part != null) {
            totalUsd += part;
            gotAny = true;
          }
        } catch {
          /* skip unsupported / rejected chainIndex */
        }
      }
    }
  }
  if (!gotAny) return null;
  // 0 here means "nothing on the chains OKX accepted", not "the wallet is empty".
  return { totalUsd: Math.round(totalUsd * 100) / 100, source: "okx-web3", includesDefi: true, confirmedEmpty: false };
}

/**
 * Zerion portfolio total (all indexed chains, including ones OKX rejects).
 * A missing or non-numeric total is a failure, never a zero wallet.
 * Empty `positions: 0` is explicit for Zerion's index, but one source still
 * cannot wipe a positive balance; see resolveCalibratedTotal.
 */
export async function fetchZerionCalibratedTotal(
  address: string,
  opts: { deadlineMs?: number } = {}
): Promise<CalibratedTotal | null> {
  const key = nextZerionKey();
  if (!key) return null;
  const remainingMs = opts.deadlineMs == null ? 18_000 : opts.deadlineMs - Date.now();
  if (remainingMs < 2_000) return null;
  return zerionRequest(async () => {
    try {
      const response = await fetch(
        `https://api.zerion.io/v1/wallets/${encodeURIComponent(address)}/portfolio?currency=usd`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
            Accept: "application/json",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(Math.min(12_000, remainingMs)),
        }
      );
      if (!response.ok) return null;
      const body = (await response.json()) as {
        data?: { attributes?: { total?: { positions?: unknown } } };
      };
      const raw = body.data?.attributes?.total?.positions;
      const total = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
      if (!Number.isFinite(total) || total < 0) return null;
      return {
        totalUsd: Math.round(total * 100) / 100,
        source: "zerion",
        includesDefi: true,
        confirmedEmpty: total < 0.01,
      };
    } catch {
      return null;
    }
  });
}

/**
 * OKX zero is not an empty wallet (unsupported chains succeed as 0).
 * Zerion zero alone is not enough to wipe a last-good balance either.
 * Both reporting ~0 is an explicit empty. A Zerion figure wildly above a
 * positive OKX total is treated as a spam spike and discarded.
 */
export function resolveCalibratedTotal(
  okx: CalibratedTotal | null,
  zerion: CalibratedTotal | null
): CalibratedTotal | null {
  const positive = (row: CalibratedTotal | null) => (row && row.totalUsd >= 0.01 ? row : null);
  const okxPos = positive(okx);
  const zerionPos = positive(zerion);
  if (zerionPos && okxPos) {
    const spike =
      zerionPos.totalUsd > okxPos.totalUsd * 8 && zerionPos.totalUsd - okxPos.totalUsd > 10_000;
    if (spike) return { ...okxPos, confirmedEmpty: false };
    return { ...zerionPos, confirmedEmpty: false };
  }
  if (zerionPos) return { ...zerionPos, confirmedEmpty: false };
  if (okxPos) return { ...okxPos, confirmedEmpty: false };
  if (okx && zerion && okx.totalUsd < 0.01 && zerion.confirmedEmpty && zerion.totalUsd < 0.01) {
    return { totalUsd: 0, source: "zerion", includesDefi: true, confirmedEmpty: true };
  }
  return null;
}

/**
 * OKX first when it sees a positive total (saves Zerion quota).
 * A zero/failed OKX read falls through to Zerion's portfolio, which covers
 * chains OKX rejects. Never return OKX's 0 by itself.
 */

/**
 * Coverage-flap tolerance shared by write-time guards and chart sanitizers.
 * Write-guard / disagreement detector only. Chart sawtooth pinning no longer
 * uses this percent gate — see sanitizeOscillatingBasisBands /
 * sanitizeOscillatingTotals (structural bimodal + returning-valley pin).
 * Kept at 0.5% (floor $150) so fresh-Rabby rejection still fires on the
 * 币安钱包 ~$450–530 public↔defi band (~0.8%).
 */
export function coverageFlapTolerance(usd: number): number {
  return Math.max(150, Math.abs(usd) * 0.005);
}

/**
 * Rabby is refreshed about every 10 minutes. OKX/Zerion cover a different
 * chain set, so letting them replace a fresh Rabby total makes NAV flap
 * (Linea ~175 vs ~1622, 币安钱包 ~50120 vs ~48300) until Rabby writes back.
 * Keep the Rabby figure while it is younger than 25 minutes and the
 * calibrated total disagrees by more than max($150, 0.5%). Older Rabby totals
 * may still fall through to calibration.
 *
 * 0.5% (tightened from 1%, which followed an earlier 3%) is the coverage-flap
 * line. On a ~$60k wallet, OKX/direct vs Rabby for 币安钱包 has sat in both a
 * ~$1,500 band (~2.5%) and a tighter ~$450–530 band (~0.8%); both must stick
 * on Rabby. Sub-$150 or sub-0.5% ticks are still ordinary price noise.
 *
 * That threshold only detects a flap. Which source wins is decided by
 * comparing token lists (see classifyDisagreement): a higher total that is
 * inflated by isRiskToken / spam / trash is not chosen; a gap from a real
 * holding the other source missed (Hood Meridian) is not treated as risk.
 */
export function calibrationDisagreesWithFreshRabby(input: {
  previousUsd: number;
  previousSource?: string | null;
  previousSuccessAt?: string | null;
  nextUsd: number;
  nowMs?: number;
}): boolean {
  const source = input.previousSource;
  if (source !== "public" && source !== "public-partial") return false;
  if (!(input.previousUsd >= 1) || !Number.isFinite(input.nextUsd)) return false;
  const at = input.previousSuccessAt ? Date.parse(input.previousSuccessAt) : Number.NaN;
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(at) || now < at || now - at > 25 * 60_000) return false;
  const delta = Math.abs(input.nextUsd - input.previousUsd);
  const tolerance = coverageFlapTolerance(input.previousUsd);
  return delta > tolerance;
}

/**
 * Universal spam-spike detector for EVERY wallet (including dust like Debot ~$0.44).
 * A +$10k jump that is also ≥8× the prior total is never a real refresh.
 * The old `previous >= 50` guard let near-empty wallets accept tens-of-thousands spikes.
 */
export function isSpuriousTotalSpike(previousUsd: number, nextUsd: number): boolean {
  if (!Number.isFinite(previousUsd) || !Number.isFinite(nextUsd)) return false;
  if (nextUsd <= previousUsd) return false;
  const delta = nextUsd - previousUsd;
  return delta > 10_000 && nextUsd > previousUsd * 8;
}

/** Material disagreement used by the max($150, 0.5%) flap rule on any source. */
export function totalsDisagreeMaterially(previousUsd: number, nextUsd: number): boolean {
  if (!Number.isFinite(previousUsd) || !Number.isFinite(nextUsd)) return false;
  const delta = Math.abs(nextUsd - previousUsd);
  const tolerance = coverageFlapTolerance(Math.max(previousUsd, 0));
  return delta > tolerance;
}

/**
 * True when `nextUsd` must not replace `previousUsd`.
 * Covers: spurious spikes, false zeros (unless confirmed empty), and
 * max($150,0.5%) flaps where the higher side is OKX isRiskToken / Zerion trash / junk.
 * Applies to every wallet and every source — not only fresh Rabby.
 */
export function shouldRejectTotalUpdate(input: {
  previousUsd: number;
  nextUsd: number;
  confirmedEmpty?: boolean;
  previousTokens?: ComparedToken[] | null;
  nextTokens?: ComparedToken[] | null;
}): boolean {
  const previous = Number(input.previousUsd) || 0;
  const next = Number(input.nextUsd);
  if (!Number.isFinite(next)) return true;
  if (isSpuriousTotalSpike(previous, next)) return true;
  if (next < 0.01 && previous >= 1 && input.confirmedEmpty !== true) return true;
  if (!totalsDisagreeMaterially(previous, next)) return false;
  // When we have token lists, never choose the risk-inflated side.
  if (input.previousTokens != null || input.nextTokens != null) {
    const pick = classifyDisagreement({
      rabbyUsd: previous,
      otherUsd: next,
      rabbyTokens: input.previousTokens ?? null,
      otherTokens: input.nextTokens ?? null,
    });
    if (pick.reason === "risk-excluded") {
      // keep previous when it is the clean side
      return pick.keep === "rabby";
    }
  }
  return false;
}

export interface ComparedToken {
  symbol: string;
  valueUsd: number;
  /** chain:contract (or chain:symbol). Used to see which side is missing a real asset. */
  key: string;
  /** OKX isRiskToken, Zerion is_trash, or an explicit spam flag from the caller. */
  risk: boolean;
}

export type DisagreementReason = "risk-excluded" | "real-coverage" | "unexplained";

export interface DisagreementPick {
  /** Side whose published total should win. "other" is OKX or Zerion. */
  keep: "rabby" | "other";
  reason: DisagreementReason;
}

const chainByOkxId = Object.fromEntries(Object.entries(OKX_CHAIN_IDS).map(([name, id]) => [id, name]));

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function tokenIsRisk(token: ComparedToken): boolean {
  if (token.risk) return true;
  const symbol = token.symbol.trim();
  if (!symbol) return false;
  return isJunkTokenSymbol(symbol);
}

/** How close a token-sum has to land on the gap before we call the gap explained. */
function gapTolerance(gapUsd: number): number {
  return Math.max(150, Math.abs(gapUsd) * 0.05);
}

function sumUsd(tokens: ComparedToken[]): number {
  return tokens.reduce((sum, token) => sum + (Number.isFinite(token.valueUsd) && token.valueUsd > 0 ? token.valueUsd : 0), 0);
}

/**
 * OKX all-token-balances rows, including ones flagged isRiskToken.
 * excludeRiskToken on total-value is not trusted: it still prices some flagged assets.
 * Returns null when the payload is not a token list.
 */
export function parseOkxComparedTokens(payload: unknown): ComparedToken[] | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as Record<string, unknown>;
  if (String(envelope.code) !== "0" || !Array.isArray(envelope.data)) return null;
  if (!envelope.data.length) return [];
  const row = envelope.data[0];
  if (!row || typeof row !== "object") return null;
  const assets = (row as Record<string, unknown>).tokenAssets;
  if (!Array.isArray(assets)) return null;
  const tokens: ComparedToken[] = [];
  for (const item of assets) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const balance = finiteNumber(record.balance);
    const price = finiteNumber(record.tokenPrice);
    if (balance == null || price == null) continue;
    const valueUsd = balance * price;
    if (!Number.isFinite(valueUsd) || valueUsd < 0) continue;
    const symbol = typeof record.symbol === "string" ? record.symbol.trim() : "";
    const chain = chainByOkxId[String(record.chainIndex ?? "")] || String(record.chainIndex ?? "unknown");
    const contract = typeof record.tokenContractAddress === "string" ? record.tokenContractAddress.trim().toLowerCase() : "";
    const key = `${chain}:${contract || symbol.toLowerCase() || "native"}`;
    tokens.push({
      symbol: symbol || key,
      valueUsd,
      key,
      risk: record.isRiskToken === true || (symbol ? isJunkTokenSymbol(symbol) : false),
    });
  }
  return tokens;
}

/** Zerion position page. is_trash and junk symbols count as risk; they are not dropped. */
export function parseZerionComparedTokens(payload: unknown): ComparedToken[] | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return null;
  const tokens: ComparedToken[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const attributes = row.attributes;
    if (!attributes || typeof attributes !== "object") continue;
    const attr = attributes as Record<string, unknown>;
    const flags = attr.flags && typeof attr.flags === "object" ? (attr.flags as Record<string, unknown>) : {};
    const info = attr.fungible_info && typeof attr.fungible_info === "object" ? (attr.fungible_info as Record<string, unknown>) : {};
    const valueUsd = finiteNumber(attr.value);
    if (valueUsd == null || valueUsd < 0) continue;
    const symbol = typeof info.symbol === "string" ? info.symbol.trim() : "";
    const id = (typeof info.id === "string" && info.id.trim()) || (typeof row.id === "string" ? row.id : symbol);
    const relationships = row.relationships && typeof row.relationships === "object" ? (row.relationships as Record<string, unknown>) : {};
    const chainData = relationships.chain && typeof relationships.chain === "object"
      ? ((relationships.chain as Record<string, unknown>).data as Record<string, unknown> | undefined)
      : undefined;
    const chain = chainData && typeof chainData.id === "string" ? chainData.id.toLowerCase() : "unknown";
    tokens.push({
      symbol: symbol || id || "token",
      valueUsd,
      key: `${chain}:${String(id || symbol || "unknown").toLowerCase()}`,
      risk: flags.is_trash === true || (symbol ? isJunkTokenSymbol(symbol) : false),
    });
  }
  return tokens;
}

export function comparedTokensFromLines(
  tokens: Array<{ symbol?: string; valueUsd?: number; chain?: string; contractAddress?: string; tokenId?: string; risk?: boolean }> | null | undefined
): ComparedToken[] | null {
  if (!tokens) return null;
  return tokens.map((token) => {
    const symbol = typeof token.symbol === "string" ? token.symbol.trim() : "";
    const chain = (token.chain || "unknown").toLowerCase();
    const contract = (token.contractAddress || "").trim().toLowerCase();
    const tokenId = (token.tokenId || "").trim().toLowerCase();
    return {
      symbol,
      valueUsd: Number(token.valueUsd) || 0,
      key: `${chain}:${contract || tokenId || symbol.toLowerCase() || "native"}`,
      risk: token.risk === true || (symbol ? isJunkTokenSymbol(symbol) : false),
    };
  });
}

/**
 * The two totals already disagree. Decide whether the higher one is risk
 * inflation or a real holding the other source does not list.
 * Null token lists mean that side was not observed; an empty array was observed and is empty.
 */
export function classifyDisagreement(input: {
  rabbyUsd: number;
  otherUsd: number;
  rabbyTokens: ComparedToken[] | null;
  otherTokens: ComparedToken[] | null;
}): DisagreementPick {
  const rabbyHigher = input.rabbyUsd >= input.otherUsd;
  const higherUsd = Math.max(input.rabbyUsd, input.otherUsd);
  const lowerUsd = Math.min(input.rabbyUsd, input.otherUsd);
  const gap = higherUsd - lowerUsd;
  const tolerance = gapTolerance(gap);
  const higherTokens = rabbyHigher ? input.rabbyTokens : input.otherTokens;
  const lowerTokens = rabbyHigher ? input.otherTokens : input.rabbyTokens;
  const explains = (usd: number) => usd > 0 && Math.abs(gap - usd) <= tolerance;

  if (higherTokens && lowerTokens) {
    const lowerReal = new Set(lowerTokens.filter((token) => !tokenIsRisk(token)).map((token) => token.key.toLowerCase()));
    const realOnly = higherTokens.filter((token) => !tokenIsRisk(token) && !lowerReal.has(token.key.toLowerCase()));
    if (explains(sumUsd(realOnly))) {
      return { keep: rabbyHigher ? "rabby" : "other", reason: "real-coverage" };
    }
  }

  // Only risk flags on the higher side can indict that side. A flagged token
  // the other source lists is not proof the higher total counted it.
  if (higherTokens) {
    const riskUsd = sumUsd(higherTokens.filter(tokenIsRisk));
    if (explains(riskUsd)) {
      return { keep: rabbyHigher ? "other" : "rabby", reason: "risk-excluded" };
    }
  }

  return { keep: "rabby", reason: "unexplained" };
}

/**
 * True when a Rabby total must not be replaced by OKX/Zerion.
 * Risk inflation on Rabby returns false so the source that excludes those
 * tokens can be applied. A real holding only Rabby lists (Hood PONS / Meridian)
 * stays on Rabby even after the 25-minute clock — dropping it is how 币安钱包
 * rewrote ~59706 public to ~58243 direct and jumped back on the next Rabby read.
 * Unexplained gaps inside 12% are the same coverage flap (the ~2.5% band) and
 * also stay. A much larger unexplained gap (Linea ~175 vs ~1622) still falls
 * through once Rabby is stale.
 */
export function shouldKeepRabbyTotal(input: {
  previousUsd: number;
  previousSource?: string | null;
  previousSuccessAt?: string | null;
  nextUsd: number;
  nowMs?: number;
  rabbyTokens: ComparedToken[] | null;
  otherTokens: ComparedToken[] | null;
}): boolean {
  const rabbyBacked = input.previousSource === "public" || input.previousSource === "public-partial";
  const delta = Math.abs(input.nextUsd - input.previousUsd);
  const tolerance = coverageFlapTolerance(input.previousUsd);
  const material = rabbyBacked && input.previousUsd >= 1 && Number.isFinite(input.nextUsd) && delta > tolerance;
  if (!material) return false;
  const pick = classifyDisagreement({
    rabbyUsd: input.previousUsd,
    otherUsd: input.nextUsd,
    rabbyTokens: input.rabbyTokens,
    otherTokens: input.otherTokens,
  });
  if (pick.reason === "risk-excluded") return pick.keep === "rabby";
  if (pick.reason === "real-coverage" && pick.keep === "rabby") return true;
  const scale = Math.max(input.previousUsd, input.nextUsd, 0);
  if (pick.reason === "unexplained" && scale > 0 && delta / scale <= 0.12) return true;
  return calibrationDisagreesWithFreshRabby({
    previousUsd: input.previousUsd,
    previousSource: input.previousSource,
    previousSuccessAt: input.previousSuccessAt,
    nextUsd: input.nextUsd,
    nowMs: input.nowMs,
  });
}

async function fetchOkxComparedTokens(
  address: string,
  chainIds: string[] | undefined,
  deadlineMs?: number
): Promise<ComparedToken[] | null> {
  if (!web3Credentials()) return null;
  const chains = (chainIds?.length ? chainIds : Object.values(OKX_CHAIN_IDS)).filter((id) => /^\d+$/.test(id)).slice(0, 50);
  if (!chains.length) return null;
  const read = async (chunk: string[]) => {
    const path =
      "/api/v6/dex/balance/all-token-balances-by-address?" +
      new URLSearchParams({
        address: address.toLowerCase(),
        chains: chunk.join(","),
        // 1 = do not filter. Flagged rows must remain visible; total-value's
        // excludeRiskToken still counts some of them (ETH PVC).
        excludeRiskToken: "1",
      });
    return parseOkxComparedTokens(await web3Read(path));
  };
  const timedOut = () => deadlineMs != null && Date.now() >= deadlineMs - 1_500;
  if (timedOut()) return null;
  try {
    const all = await read(chains);
    if (all) return all;
  } catch {
    /* one rejected chain id fails the whole batch; read the chunks below */
  }
  const merged: ComparedToken[] = [];
  let any = false;
  for (let i = 0; i < chains.length && !timedOut(); i += 6) {
    try {
      const part = await read(chains.slice(i, i + 6));
      if (part) {
        any = true;
        merged.push(...part);
      }
    } catch {
      /* skip unsupported chain batch */
    }
  }
  return any ? merged : null;
}

async function fetchZerionComparedTokens(address: string, deadlineMs?: number): Promise<ComparedToken[] | null> {
  const key = nextZerionKey();
  if (!key) return null;
  const remainingMs = deadlineMs == null ? 12_000 : deadlineMs - Date.now();
  if (remainingMs < 2_000) return null;
  return zerionRequest(async () => {
    try {
      const collected: ComparedToken[] = [];
      let url: string | null =
        `https://api.zerion.io/v1/wallets/${encodeURIComponent(address)}/positions/?currency=usd&filter[positions]=only_simple&filter[trash]=no_filter`;
      for (let page = 0; page < 2 && url; page += 1) {
        const response = await fetch(url, {
          headers: {
            Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
            Accept: "application/json",
          },
          cache: "no-store",
          redirect: "manual",
          signal: AbortSignal.timeout(Math.min(12_000, remainingMs)),
        });
        if (!response.ok) return collected.length ? collected : null;
        const body = (await response.json()) as { links?: { next?: unknown } };
        const rows = parseZerionComparedTokens(body);
        if (!rows) return collected.length ? collected : null;
        collected.push(...rows);
        const next = body.links?.next;
        url = typeof next === "string" && next.startsWith("https://api.zerion.io/") ? next : null;
      }
      return collected;
    } catch {
      return null;
    }
  });
}

/**
 * When OKX or Zerion disagrees with a Rabby total past the usual threshold,
 * load that source's token list (risk flags included) and keep Rabby unless
 * Rabby itself is the risk-inflated side.
 */
export async function rabbyOutranksCalibratedTotal(input: {
  address: string;
  previousUsd: number;
  previousSource?: string | null;
  previousSuccessAt?: string | null;
  nextUsd: number;
  nextSource: CalibrationSource;
  nowMs?: number;
  deadlineMs?: number;
  chainIds?: string[];
  rabbyTokens: ComparedToken[] | null;
}): Promise<boolean> {
  if (!Number.isFinite(input.nextUsd)) return true;
  // Dust → tens-of-thousands (Debot) and any 8×/$10k spike: reject before token fetch.
  if (isSpuriousTotalSpike(input.previousUsd, input.nextUsd)) return true;
  const rabbyBacked = input.previousSource === "public" || input.previousSource === "public-partial";
  const material = totalsDisagreeMaterially(input.previousUsd, input.nextUsd);
  if (!material) return false;
  const otherTokens =
    input.nextSource === "zerion"
      ? await fetchZerionComparedTokens(input.address, input.deadlineMs)
      : await fetchOkxComparedTokens(input.address, input.chainIds, input.deadlineMs);
  // Risk-token compare applies to every wallet once the totals disagree materially.
  if (
    shouldRejectTotalUpdate({
      previousUsd: input.previousUsd,
      nextUsd: input.nextUsd,
      previousTokens: input.rabbyTokens,
      nextTokens: otherTokens,
    })
  ) {
    return true;
  }
  if (!rabbyBacked) return false;
  return shouldKeepRabbyTotal({
    previousUsd: input.previousUsd,
    previousSource: input.previousSource,
    previousSuccessAt: input.previousSuccessAt,
    nextUsd: input.nextUsd,
    nowMs: input.nowMs,
    rabbyTokens: input.rabbyTokens,
    otherTokens,
  });
}

/**
 * Decide whether an incoming wallet total must be discarded for ANY wallet.
 * Uses the universal spike/zero guards, then OKX isRiskToken (+ Zerion trash when
 * the incoming source is Zerion) under the max($150, 0.5%) disagreement rule.
 */
export async function shouldRejectIncomingWalletTotal(input: {
  address: string;
  previousUsd: number;
  nextUsd: number;
  nextSource?: CalibrationSource | "public" | "public-partial" | "direct" | string | null;
  confirmedEmpty?: boolean;
  previousTokens?: ComparedToken[] | null;
  deadlineMs?: number;
  chainIds?: string[];
}): Promise<boolean> {
  if (
    shouldRejectTotalUpdate({
      previousUsd: input.previousUsd,
      nextUsd: input.nextUsd,
      confirmedEmpty: input.confirmedEmpty,
      previousTokens: input.previousTokens ?? null,
      nextTokens: null,
    })
  ) {
    return true;
  }
  if (!totalsDisagreeMaterially(input.previousUsd, input.nextUsd)) return false;
  const nextSource = input.nextSource === "zerion" ? "zerion" : "okx-web3";
  const nextTokens =
    nextSource === "zerion"
      ? await fetchZerionComparedTokens(input.address, input.deadlineMs)
      : await fetchOkxComparedTokens(input.address, input.chainIds, input.deadlineMs);
  return shouldRejectTotalUpdate({
    previousUsd: input.previousUsd,
    nextUsd: input.nextUsd,
    confirmedEmpty: input.confirmedEmpty,
    previousTokens: input.previousTokens ?? null,
    nextTokens,
  });
}

export async function fetchCalibratedWalletTotal(
  address: string,
  opts: { chainIds?: string[]; deadlineMs?: number; prefer?: CalibrationSource } = {}
): Promise<CalibratedTotal | null> {
  const timedOut = () => opts.deadlineMs != null && Date.now() >= opts.deadlineMs - 1_000;
  let okx: CalibratedTotal | null = null;
  let zerion: CalibratedTotal | null = null;
  if (opts.prefer !== "zerion") {
    if (timedOut()) return null;
    okx = await fetchOkxCalibratedTotal(address, opts);
    if (okx && okx.totalUsd >= 0.01) return { ...okx, confirmedEmpty: false };
  }
  if (!timedOut()) zerion = await fetchZerionCalibratedTotal(address, opts);
  if (opts.prefer === "zerion" && !(zerion && zerion.totalUsd >= 0.01) && !timedOut()) {
    okx = await fetchOkxCalibratedTotal(address, opts);
  }
  return resolveCalibratedTotal(okx, zerion);
}
