import type { SnapshotPoint } from "@/lib/types";
import { isSpuriousTotalSpike } from "./total-calibration";

/**
 * Rewrite retained snapshots where a wallet's total spuriously spiked
 * (dust → tens of thousands) then collapsed. Adjust onchain/totalUsd so the
 * chart and inferred flows no longer sawtooth. Idempotent.
 */
export function sanitizeSpuriousWalletSpikes(snapshots: SnapshotPoint[]): {
  snapshots: SnapshotPoint[];
  changed: number;
  wallets: string[];
} {
  if (!snapshots.length) return { snapshots, changed: 0, wallets: [] };

  const addresses = new Set<string>();
  for (const point of snapshots) {
    for (const address of Object.keys(point.wallets || {})) addresses.add(address);
  }

  const clamped = new Set<string>();
  let changed = 0;
  const out = snapshots.map((point) => ({
    ...point,
    wallets: point.wallets ? { ...point.wallets } : point.wallets,
  }));

  for (const address of addresses) {
    let lastSane: number | null = null;
    let spikeFrom: number | null = null;
    for (let i = 0; i < out.length; i += 1) {
      const wallets = out[i].wallets;
      if (!wallets || !(address in wallets)) continue;
      const value = Number(wallets[address]);
      if (!Number.isFinite(value)) continue;

      if (lastSane == null) {
        // First observation: if it itself is an absurd absolute spike with no prior,
        // leave it — we need a baseline. Debot's series starts sane (~0.44).
        lastSane = value;
        continue;
      }

      if (isSpuriousTotalSpike(lastSane, value)) {
        spikeFrom = lastSane;
        wallets[address] = spikeFrom;
        const onchainDelta = value - spikeFrom;
        if (typeof out[i].onchain === "number") {
          out[i].onchain = Math.round((out[i].onchain! - onchainDelta) * 100) / 100;
        }
        if (typeof out[i].totalUsd === "number") {
          out[i].totalUsd = Math.round((out[i].totalUsd - onchainDelta) * 100) / 100;
        }
        changed += 1;
        clamped.add(address);
        // Keep lastSane as the pre-spike value so subsequent spiked points clamp too.
        continue;
      }

      // After a spike window, a collapse back near spikeFrom is the correction — accept it.
      if (spikeFrom != null && Math.abs(value - spikeFrom) <= Math.max(1, spikeFrom * 0.05 + 1)) {
        spikeFrom = null;
        lastSane = value;
        continue;
      }

      lastSane = value;
    }
  }

  return { snapshots: changed ? out : snapshots, changed, wallets: [...clamped] };
}

const PUBLIC_BASIS = new Set(["public", "public-partial"]);

/** Real transfers (Gate→on-chain ~$10k) sit above this; source flaps stay under. */
const REAL_MOVE_RATIO = 0.12;
/** Below this, two values are the same noise band, not two source levels. */
const BAND_GAP_FLOOR_USD = 40;

function isPublicBasis(basis: string | undefined): boolean {
  return basis != null && PUBLIC_BASIS.has(basis);
}

function isOtherBasis(basis: string | undefined): boolean {
  return basis != null && !PUBLIC_BASIS.has(basis);
}

type BimodalSplit = {
  lowMax: number;
  highMin: number;
  lowCenter: number;
  highCenter: number;
  gap: number;
};

/**
 * Structural two-band detector. Does NOT use coverageFlapTolerance / percent
 * gates: any stable pair of levels whose gap is under REAL_MOVE_RATIO is a
 * candidate. The chart pin then rewrites the whole low side — no "is gap >
 * max($150, x%)?" check per point.
 */
function findBimodalSplit(values: number[]): BimodalSplit | null {
  if (values.length < 4) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const scale = Math.max(Math.abs(sorted[sorted.length - 1]!), 1);
  let best: { gap: number; idx: number } | null = null;
  for (let i = 1; i < sorted.length; i += 1) {
    const leftCount = i;
    const rightCount = sorted.length - i;
    if (leftCount < 2 || rightCount < 2) continue;
    const gap = sorted[i]! - sorted[i - 1]!;
    if (gap < BAND_GAP_FLOOR_USD) continue;
    if (gap / scale > REAL_MOVE_RATIO) continue;
    if (!best || gap > best.gap) best = { gap, idx: i };
  }
  if (!best) return null;
  const lowVals = sorted.slice(0, best.idx);
  const highVals = sorted.slice(best.idx);
  const lowSpread = lowVals[lowVals.length - 1]! - lowVals[0]!;
  const highSpread = highVals[highVals.length - 1]! - highVals[0]!;
  // Each side should be tighter than the gap between sides (two stable levels).
  if (lowSpread >= best.gap && highSpread >= best.gap) return null;
  return {
    lowMax: lowVals[lowVals.length - 1]!,
    highMin: highVals[0]!,
    lowCenter: lowVals[Math.floor(lowVals.length / 2)]!,
    highCenter: highVals[Math.floor(highVals.length / 2)]!,
    gap: best.gap,
  };
}

/**
 * Public↔OKX/Zerion coverage holes (Base NVDAc ~$1k on Trust/Xter1) sit far
 * above REAL_MOVE_RATIO, so findBimodalSplit rejects them. When Rabby/public
 * forms one tight high cluster and the other basis a tight low cluster with
 * repeated basis flips, pin the low side onto public — that is a source flap,
 * not a transfer. Real >12% steps where public itself straddles both levels
 * stay untouched (public spread too wide).
 */
function findBasisCoverageHoleSplit(
  samples: Array<{ value: number; basis?: string }>
): BimodalSplit | null {
  const publicSamples = samples.filter((sample) => isPublicBasis(sample.basis));
  const otherSamples = samples.filter((sample) => isOtherBasis(sample.basis));
  if (publicSamples.length < 2 || otherSamples.length < 2) return null;

  let alternations = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    if (!isPublicBasis(prev.basis) && !isOtherBasis(prev.basis)) continue;
    if (!isPublicBasis(cur.basis) && !isOtherBasis(cur.basis)) continue;
    if (isPublicBasis(prev.basis) === isPublicBasis(cur.basis)) continue;
    if (Math.abs(cur.value - prev.value) < BAND_GAP_FLOOR_USD) continue;
    alternations += 1;
  }
  if (alternations < 2) return null;

  const pubVals = publicSamples.map((sample) => sample.value).sort((a, b) => a - b);
  const otherVals = otherSamples.map((sample) => sample.value).sort((a, b) => a - b);
  const pubCenter = pubVals[Math.floor(pubVals.length / 2)]!;
  const otherCenter = otherVals[Math.floor(otherVals.length / 2)]!;
  // Rabby must be the high side for this to be a "missing asset on OKX/Zerion" hole.
  if (!(pubCenter > otherCenter + BAND_GAP_FLOOR_USD)) return null;
  const gap = pubCenter - otherCenter;
  const pubSpread = pubVals[pubVals.length - 1]! - pubVals[0]!;
  const otherSpread = otherVals[otherVals.length - 1]! - otherVals[0]!;
  // Each side must be a stable level (tighter than the inter-source gap).
  if (pubSpread >= gap * 0.5 || otherSpread >= gap * 0.5) return null;

  return {
    lowMax: otherVals[otherVals.length - 1]!,
    highMin: pubVals[0]!,
    lowCenter: otherCenter,
    highCenter: pubCenter,
    gap,
  };
}

function bandOf(value: number, split: BimodalSplit): "L" | "H" | "M" {
  if (value <= split.lowMax) return "L";
  if (value >= split.highMin) return "H";
  return "M";
}

function countBandSwitches(
  samples: Array<{ value: number }>,
  split: BimodalSplit
): number {
  let switches = 0;
  let last: "L" | "H" | null = null;
  for (const sample of samples) {
    const band = bandOf(sample.value, split);
    if (band === "M") continue;
    if (last != null && last !== band) switches += 1;
    last = band;
  }
  return switches;
}

function cloneSnapshots(snapshots: SnapshotPoint[]): SnapshotPoint[] {
  return snapshots.map((point) => ({
    ...point,
    wallets: point.wallets ? { ...point.wallets } : point.wallets,
  }));
}

function applyWalletRewrite(
  out: SnapshotPoint[],
  index: number,
  address: string,
  target: number
): boolean {
  const wallets = out[index]?.wallets;
  if (!wallets || !(address in wallets)) return false;
  const current = Number(wallets[address]);
  if (!Number.isFinite(current) || current === target) return false;
  const gap = current - target;
  wallets[address] = target;
  if (typeof out[index].onchain === "number") {
    out[index].onchain = Math.round((out[index].onchain! - gap) * 100) / 100;
  }
  if (typeof out[index].totalUsd === "number") {
    out[index].totalUsd = Math.round((out[index].totalUsd - gap) * 100) / 100;
  }
  return true;
}

function nearestAnchor(
  anchors: Array<{ index: number; value: number }>,
  index: number
): { index: number; value: number } {
  let nearest = anchors[0]!;
  let best = Math.abs(index - nearest.index);
  for (const anchor of anchors) {
    const dist = Math.abs(index - anchor.index);
    if (dist < best) {
      nearest = anchor;
      best = dist;
    }
  }
  return nearest;
}

/**
 * When one wallet keeps flipping between a public/Rabby band and a direct/OKX
 * (or Zerion) band — or the numeric series alone forms two stable levels —
 * pin the ENTIRE low side onto the public/high band. Detection is structural
 * (bimodal clusters + switches), not "gap > max($150, x%)". Real moves above
 * 12% are never flattened. Idempotent.
 */
export function sanitizeOscillatingBasisBands(snapshots: SnapshotPoint[]): {
  snapshots: SnapshotPoint[];
  changed: number;
  wallets: string[];
  /** High-band (preferred) value for each wallet that was flapping. */
  preferred: Record<string, number>;
} {
  if (!snapshots.length) return { snapshots, changed: 0, wallets: [], preferred: {} };

  const addresses = new Set<string>();
  for (const point of snapshots) {
    for (const address of Object.keys(point.wallets || {})) addresses.add(address);
  }

  const preferred: Record<string, number> = {};
  const flapping = new Set<string>();
  const anchorsByAddress = new Map<string, Array<{ index: number; value: number }>>();

  for (const address of addresses) {
    const samples: Array<{ index: number; value: number; basis?: string }> = [];
    for (let i = 0; i < snapshots.length; i += 1) {
      const wallets = snapshots[i].wallets;
      if (!wallets || !(address in wallets)) continue;
      const value = Number(wallets[address]);
      if (!Number.isFinite(value)) continue;
      samples.push({ index: i, value, basis: snapshots[i].walletBasis?.[address] });
    }
    if (samples.length < 4) continue;

    let split = findBimodalSplit(samples.map((sample) => sample.value));
    if (!split) split = findBasisCoverageHoleSplit(samples);
    if (!split) continue;
    const switches = countBandSwitches(samples, split);

    // Basis-label alternation still counts even when the numeric gap is tight.
    let basisAlternations = 0;
    for (let i = 1; i < samples.length; i += 1) {
      const prev = samples[i - 1]!;
      const cur = samples[i]!;
      if (!isPublicBasis(prev.basis) && !isOtherBasis(prev.basis)) continue;
      if (!isPublicBasis(cur.basis) && !isOtherBasis(cur.basis)) continue;
      if (isPublicBasis(prev.basis) === isPublicBasis(cur.basis)) continue;
      if (Math.abs(cur.value - prev.value) < BAND_GAP_FLOOR_USD) continue;
      basisAlternations += 1;
    }

    // Coverage-hole splits already required ≥2 basis flips; allow them at 2.
    // Numeric-only bimodal flaps still need 3 switches to avoid one-off noise.
    const minSwitches = split.gap / Math.max(split.highCenter, 1) > REAL_MOVE_RATIO ? 2 : 3;
    if (switches < minSwitches && basisAlternations < minSwitches) continue;

    const highSamples = samples.filter((sample) => bandOf(sample.value, split) === "H");
    const publicHigh = highSamples.filter((sample) => isPublicBasis(sample.basis));
    const anchorSource = publicHigh.length >= 2 ? publicHigh : highSamples;
    if (!anchorSource.length) continue;

    const anchors = anchorSource.map((sample) => ({ index: sample.index, value: sample.value }));
    anchorsByAddress.set(address, anchors);
    flapping.add(address);
    // Prefer the latest high-band public sample; else high-band center.
    preferred[address] = publicHigh.length
      ? publicHigh[publicHigh.length - 1]!.value
      : split.highCenter;
  }

  if (!flapping.size) return { snapshots, changed: 0, wallets: [], preferred: {} };

  let changed = 0;
  const out = cloneSnapshots(snapshots);

  for (const address of flapping) {
    const anchors = anchorsByAddress.get(address);
    if (!anchors?.length) continue;
    const highFloor = Math.min(...anchors.map((anchor) => anchor.value));

    for (let i = 0; i < out.length; i += 1) {
      const wallets = out[i].wallets;
      if (!wallets || !(address in wallets)) continue;
      const value = Number(wallets[address]);
      if (!Number.isFinite(value)) continue;
      // Already on the high band — leave alone (including public peaks).
      if (value >= highFloor - 1e-6) continue;
      const target = nearestAnchor(anchors, i).value;
      if (applyWalletRewrite(out, i, address, target)) changed += 1;
    }
  }

  return {
    snapshots: changed ? out : snapshots,
    changed,
    wallets: [...flapping],
    preferred,
  };
}

/**
 * A single public → other → public round trip whose two public anchors still
 * agree is a source flap, not a transfer. Clamp the interior band onto the
 * nearer public anchor without a percent-tolerance skip: once the V is
 * recognised, every interior point is rewritten. If the public level itself
 * moved by more than REAL_MOVE_RATIO, leave the points alone.
 */
export function sanitizeRoundTripBasisBands(snapshots: SnapshotPoint[]): {
  snapshots: SnapshotPoint[];
  changed: number;
  wallets: string[];
  preferred: Record<string, number>;
} {
  if (!snapshots.length) return { snapshots, changed: 0, wallets: [], preferred: {} };

  const addresses = new Set<string>();
  for (const point of snapshots) {
    for (const address of Object.keys(point.wallets || {})) addresses.add(address);
  }

  const repairs: Array<{ address: string; index: number; value: number; gap: number }> = [];
  const preferred: Record<string, number> = {};
  const wallets: string[] = [];

  for (const address of addresses) {
    const samples: Array<{ index: number; value: number; basis?: string }> = [];
    for (let i = 0; i < snapshots.length; i += 1) {
      const value = Number(snapshots[i].wallets?.[address]);
      if (!Number.isFinite(value)) continue;
      samples.push({ index: i, value, basis: snapshots[i].walletBasis?.[address] });
    }
    const publicSamples = samples.filter((sample) => isPublicBasis(sample.basis));
    if (publicSamples.length) preferred[address] = publicSamples[publicSamples.length - 1]!.value;

    for (let i = 0; i < samples.length; i += 1) {
      if (!isOtherBasis(samples[i]!.basis)) continue;
      let start = i;
      while (start > 0 && isOtherBasis(samples[start - 1]!.basis)) start -= 1;
      let end = i;
      while (end + 1 < samples.length && isOtherBasis(samples[end + 1]!.basis)) end += 1;
      const before = start > 0 && isPublicBasis(samples[start - 1]!.basis) ? samples[start - 1]! : null;
      const after =
        end + 1 < samples.length && isPublicBasis(samples[end + 1]!.basis) ? samples[end + 1]! : null;
      if (!before || !after) {
        i = end;
        continue;
      }
      const anchorGap = Math.abs(after.value - before.value);
      const anchorScale = Math.max(before.value, after.value, 0);
      // Public itself moved — Rabby confirmed a real change; do not flatten.
      if (anchorScale > 0 && anchorGap / anchorScale > REAL_MOVE_RATIO) {
        i = end;
        continue;
      }
      // Anchors must still sit on the same level. This gate only asks "did
      // Rabby itself move?"; once the V is recognised, every interior point
      // is rewritten with no per-point percent skip.
      if (anchorGap > Math.max(BAND_GAP_FLOOR_USD * 2, anchorScale * 0.005)) {
        i = end;
        continue;
      }
      for (let j = start; j <= end; j += 1) {
        const sample = samples[j]!;
        const nearer =
          Math.abs(sample.index - before.index) <= Math.abs(sample.index - after.index)
            ? before
            : after;
        const gap = sample.value - nearer.value;
        // Already on the public level.
        if (Math.abs(gap) < 1) continue;
        // Only raise (or snap onto) the public band; never chop a higher interior.
        if (sample.value > nearer.value + 1) continue;
        repairs.push({ address, index: sample.index, value: nearer.value, gap });
      }
      if (repairs.some((repair) => repair.address === address)) {
        if (!wallets.includes(address)) wallets.push(address);
      }
      i = end;
    }
    if (!wallets.includes(address)) delete preferred[address];
  }

  if (!repairs.length) return { snapshots, changed: 0, wallets: [], preferred: {} };

  const out = cloneSnapshots(snapshots);
  for (const repair of repairs) {
    const walletsOnPoint = out[repair.index].wallets;
    if (!walletsOnPoint || !(repair.address in walletsOnPoint)) continue;
    const current = Number(walletsOnPoint[repair.address]);
    if (!Number.isFinite(current) || current === repair.value) continue;
    const appliedGap = current - repair.value;
    walletsOnPoint[repair.address] = repair.value;
    if (typeof out[repair.index].onchain === "number") {
      out[repair.index].onchain = Math.round((out[repair.index].onchain! - appliedGap) * 100) / 100;
    }
    if (typeof out[repair.index].totalUsd === "number") {
      out[repair.index].totalUsd = Math.round((out[repair.index].totalUsd - appliedGap) * 100) / 100;
    }
  }

  return { snapshots: out, changed: repairs.length, wallets, preferred };
}

/**
 * Numeric two-band sawtooth without needing basis labels (币安钱包 06:25–06:40
 * on 2026-10-08: both sides tagged defi, ±$470). Once two stable levels and
 * repeated switching are detected, pin EVERY low-band point onto the nearest
 * high-band anchor — whole segment, not only a single A→B→A mid. Caps at 12%
 * so a real Gate→on-chain step is never flattened. Peaks stay (keep Rabby).
 */
export function sanitizeValueRoundTrips(snapshots: SnapshotPoint[]): {
  snapshots: SnapshotPoint[];
  changed: number;
  wallets: string[];
  preferred: Record<string, number>;
} {
  if (!snapshots.length) return { snapshots, changed: 0, wallets: [], preferred: {} };

  const addresses = new Set<string>();
  for (const point of snapshots) {
    for (const address of Object.keys(point.wallets || {})) addresses.add(address);
  }

  const repairs: Array<{ address: string; index: number; value: number }> = [];
  const preferred: Record<string, number> = {};
  const wallets: string[] = [];

  for (const address of addresses) {
    const samples: Array<{ index: number; value: number }> = [];
    for (let i = 0; i < snapshots.length; i += 1) {
      const value = Number(snapshots[i].wallets?.[address]);
      if (!Number.isFinite(value)) continue;
      samples.push({ index: i, value });
    }
    if (samples.length < 3) continue;

    const split = findBimodalSplit(samples.map((sample) => sample.value));
    if (split && countBandSwitches(samples, split) >= 2) {
      const highAnchors = samples.filter((sample) => bandOf(sample.value, split) === "H");
      if (highAnchors.length) {
        preferred[address] = highAnchors[highAnchors.length - 1]!.value;
        if (!wallets.includes(address)) wallets.push(address);
        for (const sample of samples) {
          if (bandOf(sample.value, split) !== "L") continue;
          const target = nearestAnchor(highAnchors, sample.index).value;
          repairs.push({ address, index: sample.index, value: target });
        }
        continue;
      }
    }

    // Fallback: returning valleys (including multi-point low runs) when bimodal
    // did not fire — still no coverageFlapTolerance gate on the rewrite.
    for (const repair of raiseReturningValleys(samples, BAND_GAP_FLOOR_USD)) {
      repairs.push({ address, index: repair.index, value: repair.value });
      if (!wallets.includes(address)) wallets.push(address);
      preferred[address] = repair.value;
    }
  }

  if (!repairs.length) return { snapshots, changed: 0, wallets: [], preferred: {} };

  const out = cloneSnapshots(snapshots);
  let changed = 0;
  for (const repair of repairs) {
    if (applyWalletRewrite(out, repair.index, repair.address, repair.value)) changed += 1;
  }

  return { snapshots: changed ? out : snapshots, changed, wallets, preferred };
}

/**
 * Raise returning valleys on a numeric series (totals or one wallet). A point
 * that dips then recovers to a matching high anchor is a source flap, not a
 * lasting transfer. Looks past immediate neighbours so a multi-point low run
 * still gets pinned. Caps at REAL_MOVE_RATIO.
 */
function raiseReturningValleys(
  samples: Array<{ index: number; value: number }>,
  minDipUsd = 150,
  /** Max snapshot-index span from mid to each anchor (~3h at 5‑min cadence). */
  maxIndexSpan = 36
): Array<{ index: number; value: number }> {
  if (samples.length < 3) return [];
  const repairs: Array<{ index: number; value: number }> = [];
  for (let i = 1; i < samples.length - 1; i += 1) {
    const mid = samples[i]!;
    let left: { index: number; value: number } | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (mid.index - samples[j]!.index > maxIndexSpan) break;
      // Walk through the whole low run; a small bump must not hide the real high.
      if (samples[j]!.value - mid.value >= minDipUsd) {
        left = samples[j]!;
        break;
      }
    }
    let right: { index: number; value: number } | null = null;
    for (let j = i + 1; j < samples.length; j += 1) {
      if (samples[j]!.index - mid.index > maxIndexSpan) break;
      if (samples[j]!.value - mid.value >= minDipUsd) {
        right = samples[j]!;
        break;
      }
    }
    if (!left || !right) continue;
    const anchorGap = Math.abs(right.value - left.value);
    const scale = Math.max(left.value, mid.value, right.value, 0);
    // Anchors must still agree (Rabby did not itself step). Use 0.5% only as
    // "did the high level move?", never as a rewrite skip once the V is known.
    if (scale > 0 && anchorGap / scale > 0.005 && anchorGap > minDipUsd * 0.5) continue;
    if (scale > 0 && Math.max(left.value - mid.value, right.value - mid.value) / scale > REAL_MOVE_RATIO) {
      continue;
    }
    // Always raise onto the higher agreeing anchor so a mild mid-band left
    // neighbour cannot leave a residual ±$200–300 sawtooth.
    const target = Math.max(left.value, right.value);
    if (mid.value >= target - 1e-6) continue;
    repairs.push({ index: mid.index, value: target });
  }
  return repairs;
}

/** Wallet-map sum for a snapshot; NaN if the map is missing/empty. */
function walletMapSum(point: SnapshotPoint): number {
  const wallets = point.wallets;
  if (!wallets) return Number.NaN;
  const values = Object.values(wallets);
  if (!values.length) return Number.NaN;
  let sum = 0;
  for (const value of values) {
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    sum += n;
  }
  return sum;
}

/** Expected chart total when per-wallet figures are authoritative. */
function expectedTotalFromWallets(point: SnapshotPoint, walletSum: number): number {
  const cex = Number.isFinite(Number(point.cex)) ? Number(point.cex) : 0;
  const manual = Number.isFinite(Number(point.manual)) ? Number(point.manual) : 0;
  return Math.round((walletSum + cex + manual) * 100) / 100;
}

/**
 * Belt-and-suspenders for the chart series itself: when totalUsd flips between
 * two stable levels (or briefly dips and recovers), raise every low point onto
 * the nearest high anchor — but NEVER above the wallet-map truth when wallets
 * are present (that is how 10/10 daytime stayed ~$2k fake-high). Never
 * flattens moves above 12%. Structural — no coverageFlapTolerance gate.
 */
export function sanitizeOscillatingTotals(snapshots: SnapshotPoint[]): {
  snapshots: SnapshotPoint[];
  changed: number;
} {
  if (snapshots.length < 3) return { snapshots, changed: 0 };
  const samples = snapshots
    .map((point, index) => ({ index, value: Number(point.totalUsd) }))
    .filter((sample) => Number.isFinite(sample.value));
  if (samples.length < 3) return { snapshots, changed: 0 };

  const repairMap = new Map<number, number>();

  const split = findBimodalSplit(samples.map((sample) => sample.value));
  if (split && countBandSwitches(samples, split) >= 3) {
    const highAnchors = samples.filter((sample) => bandOf(sample.value, split) === "H");
    for (const sample of samples) {
      if (bandOf(sample.value, split) !== "L") continue;
      repairMap.set(sample.index, nearestAnchor(highAnchors, sample.index).value);
    }
  }

  for (const repair of raiseReturningValleys(samples, 150)) {
    const existing = repairMap.get(repair.index);
    // Prefer the higher target when both rules fire.
    if (existing == null || repair.value > existing) repairMap.set(repair.index, repair.value);
  }

  if (!repairMap.size) return { snapshots, changed: 0 };

  let changed = 0;
  const out = snapshots.map((point) => ({ ...point }));
  for (const [index, target] of repairMap) {
    const current = Number(out[index].totalUsd);
    if (!Number.isFinite(current) || current >= target - 1e-6) continue;
    let next = target;
    // Cap the raise at wallet-sum truth so a retained junk peak cannot lift the
    // whole day. Real wallet drops stay (reconcile presses leftover inflation).
    const wsum = walletMapSum(out[index]);
    if (Number.isFinite(wsum)) {
      const expected = expectedTotalFromWallets(out[index], wsum);
      if (next > expected + 1) next = expected;
      if (current >= next - 1e-6) continue;
    }
    const gap = current - next;
    out[index].totalUsd = next;
    if (typeof out[index].onchain === "number") {
      out[index].onchain = Math.round((out[index].onchain! - gap) * 100) / 100;
    }
    changed += 1;
  }

  return { snapshots: changed ? out : snapshots, changed };
}

/** Ignore sub-dollar float noise when pressing totals onto the wallet map. */
const RECONCILE_FLOOR_USD = 50;

/**
 * Press inflated (or deflated) onchain/totalUsd onto sum(wallets)+cex+manual.
 * Real decreases already reflected in the wallet map are kept; only the chart
 * series is rewritten. Fixes the 10/10 03:20–22:41 "only-raise" ghost where
 * onchain sat $1k–$3k above the wallet map. Idempotent. No-ops when the
 * wallet map is missing/empty (seeded total-only points).
 */
export function reconcileSnapshotTotalsToWallets(snapshots: SnapshotPoint[]): {
  snapshots: SnapshotPoint[];
  changed: number;
} {
  if (!snapshots.length) return { snapshots, changed: 0 };

  let changed = 0;
  let out: SnapshotPoint[] | null = null;

  for (let i = 0; i < snapshots.length; i += 1) {
    const point = (out ?? snapshots)[i]!;
    const wsum = walletMapSum(point);
    if (!Number.isFinite(wsum)) continue;

    const expectedOnchain = Math.round(wsum * 100) / 100;
    const expectedTotal = expectedTotalFromWallets(point, wsum);
    const currentOnchain = Number(point.onchain);
    const currentTotal = Number(point.totalUsd);
    const onGap =
      Number.isFinite(currentOnchain) ? Math.abs(currentOnchain - expectedOnchain) : RECONCILE_FLOOR_USD + 1;
    const totalGap =
      Number.isFinite(currentTotal) ? Math.abs(currentTotal - expectedTotal) : RECONCILE_FLOOR_USD + 1;
    if (onGap < RECONCILE_FLOOR_USD && totalGap < RECONCILE_FLOOR_USD) continue;

    if (!out) out = snapshots.map((snap) => ({ ...snap }));
    out[i] = {
      ...point,
      onchain: expectedOnchain,
      totalUsd: expectedTotal,
    };
    changed += 1;
  }

  return { snapshots: out ?? snapshots, changed };
}
