import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileSnapshotTotalsToWallets,
  sanitizeOscillatingBasisBands,
  sanitizeOscillatingTotals,
  sanitizeRoundTripBasisBands,
  sanitizeValueRoundTrips,
} from '../src/lib/onchain/snapshot-sanitize.ts';

const point = (ts, total, wallet, basis) => ({
  ts,
  totalUsd: total,
  onchain: total - 19889.42,
  cex: 14661.42,
  manual: 5228,
  wallets: { '0xabc': wallet },
  walletBasis: { '0xabc': basis },
});

test('one public-direct-public V is clamped when the public anchors still agree', () => {
  const snaps = [
    point('2026-10-03T18:17:19.639Z', 81930.71, 59705.87, 'public'),
    point('2026-10-03T18:20:54.188Z', 80462.99, 58243.07, 'defi'),
    point('2026-10-03T18:32:08.643Z', 80478.54, 58266.6, 'defi'),
    point('2026-10-03T18:52:05.064Z', 81854.75, 59630.07, 'public'),
  ];
  const out = sanitizeRoundTripBasisBands(snaps);
  assert.equal(out.changed, 2);
  assert.equal(out.snapshots[1].wallets['0xabc'], 59705.87);
  assert.equal(out.snapshots[2].wallets['0xabc'], 59630.07);
  assert.equal(out.snapshots[1].totalUsd, 81925.79);
  assert.equal(out.snapshots[0].totalUsd, 81930.71);
  assert.equal(out.snapshots[3].totalUsd, 81854.75);
  const again = sanitizeRoundTripBasisBands(out.snapshots);
  assert.equal(again.changed, 0);
});

test('a direct band Rabby later confirms is not flattened', () => {
  const snaps = [
    point('2026-10-03T18:17:19.639Z', 81930.71, 59705.87, 'public'),
    point('2026-10-03T18:20:54.188Z', 80462.99, 58243.07, 'defi'),
    point('2026-10-03T18:52:05.064Z', 80480, 58260, 'public'),
  ];
  const out = sanitizeRoundTripBasisBands(snaps);
  assert.equal(out.changed, 0);
  assert.equal(out.snapshots[1].wallets['0xabc'], 58243.07);
});

test('0.8% public↔defi sawtooth on 币安钱包 is clamped by oscillating bands', () => {
  // Real 2026-10-08 bands: public ~59225 / defi ~58759 (~$466, under the old 1% line).
  const snaps = [
    point('2026-10-08T04:01:00.000Z', 82421, 59224.81, 'public'),
    point('2026-10-08T04:11:00.000Z', 81956, 58759.37, 'defi'),
    point('2026-10-08T04:51:00.000Z', 82432, 59235.65, 'public'),
    point('2026-10-08T05:01:00.000Z', 81981, 58784.87, 'defi'),
    point('2026-10-08T07:15:00.000Z', 82427, 59231.07, 'public'),
    point('2026-10-08T07:40:00.000Z', 81981, 58785.03, 'defi'),
    point('2026-10-08T07:45:00.000Z', 82453, 59257.2, 'public'),
  ];
  const out = sanitizeOscillatingBasisBands(snaps);
  assert.ok(out.changed >= 3, `expected clamps, got ${out.changed}`);
  assert.deepEqual(out.wallets, ['0xabc']);
  for (const snap of out.snapshots) {
    if (snap.walletBasis['0xabc'] === 'defi') {
      assert.ok(snap.wallets['0xabc'] > 59100, `defi point still low: ${snap.wallets['0xabc']}`);
    }
  }
});

test('same-basis numeric valley is raised by value round-trips', () => {
  const snaps = [
    point('2026-10-08T06:20:00.000Z', 82420, 59231.07, 'defi'),
    point('2026-10-08T06:25:00.000Z', 81955, 58746.16, 'defi'),
    point('2026-10-08T06:40:00.000Z', 82426, 59235.65, 'defi'),
  ];
  const out = sanitizeValueRoundTrips(snaps);
  assert.equal(out.changed, 1);
  assert.ok(out.snapshots[1].wallets['0xabc'] > 59100);
});

test('same-basis numeric peak is left alone (keep Rabby band)', () => {
  const snaps = [
    point('2026-10-08T06:20:00.000Z', 81950, 58746.16, 'defi'),
    point('2026-10-08T06:25:00.000Z', 82435, 59231.07, 'defi'),
    point('2026-10-08T06:40:00.000Z', 81966, 58761.91, 'defi'),
  ];
  const out = sanitizeValueRoundTrips(snaps);
  assert.equal(out.changed, 0);
  assert.equal(out.snapshots[1].wallets['0xabc'], 59231.07);
});

test('sub-0.5% dual-band sawtooth is fully pinned (no percent gate)', () => {
  // gap ~$250 on ~$59k ≈ 0.42% — under the old max($150, 0.5%) line.
  const high = 59200;
  const low = 58950;
  const snaps = [];
  for (let i = 0; i < 8; i += 1) {
    const useHigh = i % 2 === 0;
    snaps.push(
      point(
        `2026-10-08T08:0${i}:00.000Z`,
        useHigh ? 82400 : 82150,
        useHigh ? high : low,
        useHigh ? 'public' : 'defi'
      )
    );
  }
  const bands = sanitizeOscillatingBasisBands(snaps);
  assert.ok(bands.changed >= 4, `expected full pin, got ${bands.changed}`);
  for (const snap of bands.snapshots) {
    assert.ok(
      snap.wallets['0xabc'] >= high - 1,
      `still low after pin: ${snap.wallets['0xabc']}`
    );
  }
  assert.ok(bands.preferred['0xabc'] >= high - 1);

  const values = sanitizeValueRoundTrips(
    snaps.map((s) => ({
      ...s,
      walletBasis: { '0xabc': 'defi' },
    }))
  );
  assert.ok(values.changed >= 4, `value pin expected, got ${values.changed}`);
  for (const snap of values.snapshots) {
    assert.ok(snap.wallets['0xabc'] >= high - 1);
  }
});

test('sanitizeOscillatingTotals raises bimodal total valleys', () => {
  const snaps = [];
  for (let i = 0; i < 8; i += 1) {
    const high = i % 2 === 0;
    snaps.push({
      ts: `2026-10-08T09:0${i}:00.000Z`,
      totalUsd: high ? 82040 : 81260,
      onchain: high ? 62150 : 61370,
      cex: 14660,
      manual: 5230,
    });
  }
  const out = sanitizeOscillatingTotals(snaps);
  assert.ok(out.changed >= 4);
  for (const snap of out.snapshots) {
    assert.ok(snap.totalUsd >= 82000, `total still low: ${snap.totalUsd}`);
  }
});

test('real >12% step is not flattened by bimodal pin', () => {
  const snaps = [
    point('2026-10-08T10:00:00.000Z', 82000, 50000, 'public'),
    point('2026-10-08T10:05:00.000Z', 82000, 50000, 'public'),
    point('2026-10-08T10:10:00.000Z', 92000, 60000, 'public'),
    point('2026-10-08T10:15:00.000Z', 92000, 60000, 'public'),
    point('2026-10-08T10:20:00.000Z', 82000, 50000, 'defi'),
    point('2026-10-08T10:25:00.000Z', 92000, 60000, 'public'),
  ];
  // 20% gap — findBimodalSplit rejects; nothing should rewrite.
  const out = sanitizeOscillatingBasisBands(snaps);
  assert.equal(out.changed, 0);
  assert.equal(out.snapshots[2].wallets['0xabc'], 60000);
  assert.equal(out.snapshots[4].wallets['0xabc'], 50000);
});

test('NVDAc coverage-hole public↔direct flap (>12%) is pinned to Rabby', () => {
  // Trust/Xter1: Rabby ~$1040 (Base NVDAc) vs OKX/Zerion ~$30 — gap ≈ 97%.
  const snaps = [];
  for (let i = 0; i < 8; i += 1) {
    const useHigh = i % 2 === 0;
    snaps.push(
      point(
        `2026-10-10T0${i}:00:00.000Z`,
        useHigh ? 82000 : 81000,
        useHigh ? 1040 + (i % 3) : 28 + (i % 2),
        useHigh ? 'public' : 'direct'
      )
    );
  }
  const out = sanitizeOscillatingBasisBands(snaps);
  assert.ok(out.changed >= 3, `expected NVDAc pin, got ${out.changed}`);
  assert.deepEqual(out.wallets, ['0xabc']);
  for (const snap of out.snapshots) {
    assert.ok(snap.wallets['0xabc'] >= 1030, `still low: ${snap.wallets['0xabc']}`);
  }
  assert.ok(out.preferred['0xabc'] >= 1030);
});

test('reconcileSnapshotTotalsToWallets presses inflated onchain onto wallet sum', () => {
  const snaps = [
    {
      ts: '2026-10-10T04:00:00.000Z',
      totalUsd: 84000,
      onchain: 68000,
      cex: 11000,
      manual: 5000,
      wallets: { '0xabc': 60000, '0xdef': 5000 },
    },
    {
      ts: '2026-10-10T05:00:00.000Z',
      totalUsd: 81000,
      onchain: 65000,
      cex: 11000,
      manual: 5000,
      wallets: { '0xabc': 60000, '0xdef': 5000 },
    },
  ];
  const out = reconcileSnapshotTotalsToWallets(snaps);
  assert.equal(out.changed, 1);
  assert.equal(out.snapshots[0].onchain, 65000);
  assert.equal(out.snapshots[0].totalUsd, 81000);
  assert.equal(out.snapshots[1].onchain, 65000);
  assert.equal(out.snapshots[1].totalUsd, 81000);
  const again = reconcileSnapshotTotalsToWallets(out.snapshots);
  assert.equal(again.changed, 0);
});

test('sanitizeOscillatingTotals + reconcile keep chart on wallet-sum truth', () => {
  const snaps = [];
  for (let i = 0; i < 8; i += 1) {
    const high = i % 2 === 0;
    snaps.push({
      ts: `2026-10-10T1${i}:00:00.000Z`,
      totalUsd: high ? 84000 : 81200,
      onchain: high ? 68000 : 65200,
      cex: 11000,
      manual: 5000,
      wallets: { '0xabc': 60000, '0xdef': 5200 },
    });
  }
  // Raise step alone leaves peaks; reconcile presses everything to 81200.
  const raised = sanitizeOscillatingTotals(snaps);
  const out = reconcileSnapshotTotalsToWallets(raised.snapshots);
  assert.ok(out.changed >= 4);
  for (const snap of out.snapshots) {
    assert.equal(snap.onchain, 65200);
    assert.equal(snap.totalUsd, 81200);
  }
});
