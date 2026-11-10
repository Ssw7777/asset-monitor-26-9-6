import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrationDisagreesWithFreshRabby, resolveCalibratedTotal, totalsDisagreeMaterially } from '../src/lib/onchain/total-calibration.ts';
import { isJunkTokenSymbol, isDustTokenValue } from '../src/lib/onchain/junk-tokens.ts';
import { parseTotalDetail } from '../src/lib/onchain/debank.ts';

const okx = (totalUsd) => ({ totalUsd, source: 'okx-web3', includesDefi: true, confirmedEmpty: false });
const zerion = (totalUsd, confirmedEmpty = totalUsd < 0.01) => ({ totalUsd, source: 'zerion', includesDefi: true, confirmedEmpty });

test('OKX zero alone does not become a wallet total', () => {
  assert.equal(resolveCalibratedTotal(okx(0), null), null);
  assert.equal(resolveCalibratedTotal(null, null), null);
});

test('Zerion portfolio restores a wallet OKX cannot see', () => {
  const resolved = resolveCalibratedTotal(okx(0), zerion(246.33, false));
  assert.equal(resolved.totalUsd, 246.33);
  assert.equal(resolved.confirmedEmpty, false);
  assert.equal(resolved.source, 'zerion');
});

test('both sources at zero confirm an empty wallet', () => {
  const resolved = resolveCalibratedTotal(okx(0), zerion(0, true));
  assert.equal(resolved.totalUsd, 0);
  assert.equal(resolved.confirmedEmpty, true);
});

test('a Zerion spike far above a positive OKX total is discarded', () => {
  const resolved = resolveCalibratedTotal(okx(48000), zerion(900000));
  assert.equal(resolved.source, 'okx-web3');
  assert.equal(resolved.totalUsd, 48000);
});

test('positive OKX is kept when Zerion is missing', () => {
  assert.equal(resolveCalibratedTotal(okx(1621.65), null).totalUsd, 1621.65);
});

test('junk symbols and dust are recognized; plain tickers are not', () => {
  assert.equal(isJunkTokenSymbol('USDT'), false);
  assert.equal(isJunkTokenSymbol('DJT'), false);
  assert.equal(isJunkTokenSymbol('visit www.claim-eth.com'), true);
  assert.equal(isJunkTokenSymbol('哈基米'), true);
  assert.equal(isJunkTokenSymbol('USD.COM'), true);
  assert.equal(isDustTokenValue(0.02), true);
  assert.equal(isDustTokenValue(0.43), false);
});

test('Rabby total without chain_list is not an explicit zero', () => {
  assert.equal(parseTotalDetail({ total_usd_value: 0 }), null);
  const parsed = parseTotalDetail({ total_usd_value: 0, chain_list: [] });
  assert.equal(parsed.totalUsd, 0);
  assert.equal(parsed.explicitEmpty, true);
  assert.equal(parseTotalDetail({ total_usd_value: 12.5, chain_list: [{ id: 'eth', name: 'Ethereum', usd_value: 12.5 }] }).explicitEmpty, false);
});

test('fresh Rabby is not replaced by a materially different OKX/Zerion total', () => {
  const now = Date.parse('2026-10-03T08:40:00.000Z');
  const fresh = new Date(now - 8 * 60_000).toISOString();
  // Linea: Rabby ~175 vs OKX ~1622
  assert.equal(calibrationDisagreesWithFreshRabby({
    previousUsd: 175.85, previousSource: 'public', previousSuccessAt: fresh, nextUsd: 1622.67, nowMs: now,
  }), true);
  // 币安钱包: Rabby ~50120 vs OKX ~48300
  assert.equal(calibrationDisagreesWithFreshRabby({
    previousUsd: 50120.56, previousSource: 'public', previousSuccessAt: fresh, nextUsd: 48280, nowMs: now,
  }), true);
  // 币安钱包 after the ~$10k Gate transfer: Rabby 59814 vs OKX/direct 58336 (~2.5%, under the old 3% rule).
  assert.equal(calibrationDisagreesWithFreshRabby({
    previousUsd: 59814.22, previousSource: 'public', previousSuccessAt: fresh, nextUsd: 58335.89, nowMs: now,
  }), true);
  assert.equal(totalsDisagreeMaterially(59814.22, 58335.89), true);
  // 币安钱包 2026-10-08: public ~59225 vs defi ~58759 (~0.8%). Old 1% (~$592) missed it.
  assert.equal(totalsDisagreeMaterially(59224.81, 58759.37), true);
  assert.equal(calibrationDisagreesWithFreshRabby({
    previousUsd: 59224.81, previousSource: 'public', previousSuccessAt: fresh, nextUsd: 58759.37, nowMs: now,
  }), true);
  // Small price move is not a coverage flap.
  assert.equal(calibrationDisagreesWithFreshRabby({
    previousUsd: 50120.56, previousSource: 'public', previousSuccessAt: fresh, nextUsd: 50040, nowMs: now,
  }), false);
  // Stale Rabby may fall through to calibration.
  const stale = new Date(now - 40 * 60_000).toISOString();
  assert.equal(calibrationDisagreesWithFreshRabby({
    previousUsd: 175.85, previousSource: 'public', previousSuccessAt: stale, nextUsd: 1622.67, nowMs: now,
  }), false);
  // Direct/Zerion totals are not protected by this guard.
  assert.equal(calibrationDisagreesWithFreshRabby({
    previousUsd: 1622.67, previousSource: 'direct', previousSuccessAt: fresh, nextUsd: 175.85, nowMs: now,
  }), false);
});

import { classifyDisagreement, parseOkxComparedTokens, parseZerionComparedTokens, shouldKeepRabbyTotal } from '../src/lib/onchain/total-calibration.ts';

const now = Date.parse('2026-10-03T08:40:00.000Z');
const fresh = new Date(now - 8 * 60_000).toISOString();
const stale = new Date(now - 40 * 60_000).toISOString();
const pvc = '0x1111111111111111111111111111111111111111';
const meridian = '0x46630000000000000000000000000000000merid';

test('OKX total inflated by an isRiskToken is not chosen over Rabby', () => {
  const otherTokens = [
    { symbol: 'ETH', valueUsd: 100, key: 'eth:eth', risk: false },
    { symbol: 'USDC', valueUsd: 61, key: 'eth:0xusdc', risk: false },
    { symbol: 'PVC', valueUsd: 1493, key: 'eth:' + pvc, risk: true },
  ];
  const rabbyTokens = [
    { symbol: 'ETH', valueUsd: 105, key: 'eth:eth', risk: false },
    { symbol: 'USDC', valueUsd: 63, key: 'eth:0xusdc', risk: false },
  ];
  const pick = classifyDisagreement({ rabbyUsd: 168, otherUsd: 1661, rabbyTokens, otherTokens });
  assert.equal(pick.reason, 'risk-excluded');
  assert.equal(pick.keep, 'rabby');
  assert.equal(shouldKeepRabbyTotal({
    previousUsd: 168, previousSource: 'public', previousSuccessAt: fresh, nextUsd: 1661, nowMs: now, rabbyTokens, otherTokens,
  }), true);
  // Even a stale Rabby total is kept when the replacement is the risk-inflated side.
  assert.equal(shouldKeepRabbyTotal({
    previousUsd: 168, previousSource: 'public', previousSuccessAt: stale, nextUsd: 1661, nowMs: now, rabbyTokens, otherTokens,
  }), true);
});

test('Hood Meridian missing on OKX is real coverage, not a reason to drop the higher Rabby total', () => {
  const rabbyTokens = [
    { symbol: 'USDC', valueUsd: 40000, key: 'eth:0xusdc', risk: false },
    { symbol: 'Meridian', valueUsd: 1820.56, key: 'hood:' + meridian, risk: false },
  ];
  const otherTokens = [
    { symbol: 'USDC', valueUsd: 40000, key: 'eth:0xusdc', risk: false },
  ];
  const pick = classifyDisagreement({ rabbyUsd: 50120.56, otherUsd: 48280, rabbyTokens, otherTokens });
  assert.equal(pick.reason, 'real-coverage');
  assert.equal(pick.keep, 'rabby');
  assert.notEqual(pick.reason, 'risk-excluded');
  assert.equal(shouldKeepRabbyTotal({
    previousUsd: 50120.56, previousSource: 'public', previousSuccessAt: fresh, nextUsd: 48280, nowMs: now, rabbyTokens, otherTokens,
  }), true);
});

test('a higher Rabby total explained by risk-flagged tokens yields to the source that excludes them', () => {
  const rabbyTokens = [
    { symbol: 'ETH', valueUsd: 200, key: 'eth:eth', risk: false },
    { symbol: 'PVC', valueUsd: 1800, key: 'eth:' + pvc, risk: true },
  ];
  const otherTokens = [
    { symbol: 'ETH', valueUsd: 200, key: 'eth:eth', risk: false },
  ];
  const pick = classifyDisagreement({ rabbyUsd: 2000, otherUsd: 200, rabbyTokens, otherTokens });
  assert.equal(pick.reason, 'risk-excluded');
  assert.equal(pick.keep, 'other');
  assert.equal(shouldKeepRabbyTotal({
    previousUsd: 2000, previousSource: 'public-partial', previousSuccessAt: fresh, nextUsd: 200, nowMs: now, rabbyTokens, otherTokens,
  }), false);
});

test('stale Rabby keeps a moderate unexplained band and a Rabby-only real holding', () => {
  assert.equal(shouldKeepRabbyTotal({
    previousUsd: 59705.87, previousSource: 'public', previousSuccessAt: stale, nextUsd: 58243.07, nowMs: now,
    rabbyTokens: null, otherTokens: null,
  }), true);
  const rabbyTokens = [
    { symbol: 'USDC', valueUsd: 40000, key: 'eth:0xusdc', risk: false },
    { symbol: 'PONS', valueUsd: 1460, key: 'hood:pons', risk: false },
  ];
  const otherTokens = [{ symbol: 'USDC', valueUsd: 40000, key: 'eth:0xusdc', risk: false }];
  assert.equal(shouldKeepRabbyTotal({
    previousUsd: 59705.87, previousSource: 'public', previousSuccessAt: stale, nextUsd: 58243.07, nowMs: now,
    rabbyTokens, otherTokens,
  }), true);
  // Linea-sized unexplained gap still falls through once Rabby is stale.
  assert.equal(shouldKeepRabbyTotal({
    previousUsd: 175.85, previousSource: 'public', previousSuccessAt: stale, nextUsd: 1622.67, nowMs: now,
    rabbyTokens: null, otherTokens: null,
  }), false);
  assert.equal(shouldKeepRabbyTotal({
    previousUsd: 1000, previousSource: 'public', previousSuccessAt: stale, nextUsd: 1800, nowMs: now,
    rabbyTokens: [{ symbol: 'USDC', valueUsd: 1000, key: 'eth:0xusdc', risk: false }],
    otherTokens: [
      { symbol: 'USDC', valueUsd: 1000, key: 'eth:0xusdc', risk: false },
      { symbol: 'REAL', valueUsd: 800, key: 'base:0xreal', risk: false },
    ],
  }), false);
});

test('a real OKX-only holding is not classified as risk, and fresh Rabby is still not replaced for that coverage gap', () => {
  const rabbyTokens = [{ symbol: 'USDC', valueUsd: 1000, key: 'eth:0xusdc', risk: false }];
  const otherTokens = [
    { symbol: 'USDC', valueUsd: 1000, key: 'eth:0xusdc', risk: false },
    { symbol: 'REAL', valueUsd: 800, key: 'base:0xreal', risk: false },
  ];
  const pick = classifyDisagreement({ rabbyUsd: 1000, otherUsd: 1800, rabbyTokens, otherTokens });
  assert.equal(pick.reason, 'real-coverage');
  assert.equal(pick.keep, 'other');
  assert.equal(shouldKeepRabbyTotal({
    previousUsd: 1000, previousSource: 'public', previousSuccessAt: fresh, nextUsd: 1800, nowMs: now, rabbyTokens, otherTokens,
  }), true);
});

test('OKX and Zerion parsers keep risk flags instead of dropping those rows', () => {
  const okx = parseOkxComparedTokens({
    code: '0',
    data: [{ tokenAssets: [
      { chainIndex: '1', symbol: 'PVC', tokenContractAddress: pvc, balance: '1000', tokenPrice: '1.493', isRiskToken: true },
      { chainIndex: '1', symbol: 'ETH', tokenContractAddress: '', balance: '0.05', tokenPrice: '2000', isRiskToken: false },
      { chainIndex: '1', symbol: 'visit www.claim-eth.com', tokenContractAddress: '0x2222222222222222222222222222222222222222', balance: '1', tokenPrice: '10', isRiskToken: false },
    ] }],
  });
  assert.equal(okx.length, 3);
  assert.equal(okx[0].risk, true);
  assert.equal(okx[0].key, 'eth:' + pvc);
  assert.ok(Math.abs(okx[0].valueUsd - 1493) < 0.001);
  assert.equal(okx[1].risk, false);
  assert.equal(okx[1].key, 'eth:eth');
  assert.equal(okx[2].risk, true);
  const zerion = parseZerionComparedTokens({
    data: [{
      id: 'pos1',
      attributes: { value: 42, flags: { is_trash: true }, fungible_info: { symbol: 'SCAM', id: 'scam' } },
      relationships: { chain: { data: { id: 'ethereum' } } },
    }, {
      id: 'pos2',
      attributes: { value: 1820, flags: { is_trash: false }, fungible_info: { symbol: 'Meridian', id: 'meridian' } },
      relationships: { chain: { data: { id: 'robinhood' } } },
    }],
  });
  assert.equal(zerion[0].risk, true);
  assert.equal(zerion[1].risk, false);
  assert.equal(zerion[1].key, 'robinhood:meridian');
});

import {
  isSpuriousTotalSpike,
  shouldRejectTotalUpdate,
} from '../src/lib/onchain/total-calibration.ts';
import { sanitizeOscillatingBasisBands, sanitizeSpuriousWalletSpikes } from '../src/lib/onchain/snapshot-sanitize.ts';

test('dust wallet Debot-style spike 0.44 → 23718 is rejected for every wallet', () => {
  assert.equal(isSpuriousTotalSpike(0.44, 23718.55), true);
  assert.equal(shouldRejectTotalUpdate({ previousUsd: 0.44, nextUsd: 23718.55 }), true);
  // Collapse back is not a spike
  assert.equal(isSpuriousTotalSpike(23718.55, 0.44), false);
});

test('max($150,1%) material disagreement still detects PVC-sized flaps', () => {
  assert.equal(totalsDisagreeMaterially(168, 1661), true);
  assert.equal(totalsDisagreeMaterially(50120, 50040), false);
  assert.equal(
    shouldRejectTotalUpdate({
      previousUsd: 168,
      nextUsd: 1661,
      previousTokens: [
        { symbol: 'ETH', valueUsd: 105, key: 'eth:eth', risk: false },
        { symbol: 'USDC', valueUsd: 63, key: 'eth:0xusdc', risk: false },
      ],
      nextTokens: [
        { symbol: 'ETH', valueUsd: 100, key: 'eth:eth', risk: false },
        { symbol: 'USDC', valueUsd: 61, key: 'eth:0xusdc', risk: false },
        { symbol: 'PVC', valueUsd: 1493, key: 'eth:' + pvc, risk: true },
      ],
    }),
    true
  );
});

test('false zero without confirmedEmpty is rejected', () => {
  assert.equal(shouldRejectTotalUpdate({ previousUsd: 200, nextUsd: 0 }), true);
  assert.equal(shouldRejectTotalUpdate({ previousUsd: 200, nextUsd: 0, confirmedEmpty: true }), false);
});

test('sanitizeSpuriousWalletSpikes rewrites Debot chart sawtooth and fixes onchain', () => {
  const debot = '0xff8950a581596680418e0942f06d0a31457926ea';
  const snaps = [
    { ts: '2026-10-03T11:10:00.000Z', totalUsd: 82360, onchain: 62510, wallets: { [debot]: 0.44 } },
    { ts: '2026-10-03T11:15:00.000Z', totalUsd: 106078, onchain: 86228, wallets: { [debot]: 23718.55 } },
    { ts: '2026-10-03T11:20:00.000Z', totalUsd: 106078, onchain: 86228, wallets: { [debot]: 23718.55 } },
    { ts: '2026-10-03T11:32:00.000Z', totalUsd: 82361, onchain: 62513, wallets: { [debot]: 0.44 } },
  ];
  const { snapshots, changed, wallets } = sanitizeSpuriousWalletSpikes(snaps);
  assert.ok(changed >= 2);
  assert.deepEqual(wallets, [debot]);
  assert.equal(snapshots[1].wallets[debot], 0.44);
  assert.equal(snapshots[2].wallets[debot], 0.44);
  assert.ok(Math.abs(snapshots[1].onchain - 62509.89) < 1);
  assert.ok(Math.abs(snapshots[1].totalUsd - 82359.89) < 1);
  assert.equal(snapshots[3].wallets[debot], 0.44);
});

test('sanitizeOscillatingBasisBands flattens 币安钱包 Rabby/OKX sawtooth and keeps the public band', () => {
  const binance = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const linea = '0xcccccccccccccccccccccccccccccccccccccccc';
  const pub = 59814.22;
  const okx = 58335.89;
  const gap = pub - okx;
  const snaps = [];
  for (let i = 0; i < 8; i += 1) {
    const high = i % 2 === 0;
    const wallet = high ? pub + i : okx;
    snaps.push({
      ts: new Date(Date.parse('2026-10-03T13:00:00.000Z') + i * 5 * 60_000).toISOString(),
      totalUsd: (high ? 82020 : 82020 - gap) + i,
      onchain: (high ? 62165 : 62165 - gap) + i,
      cex: 14629,
      wallets: { [binance]: wallet, [linea]: 177.4 },
      walletBasis: { [binance]: high ? 'public' : 'defi', [linea]: 'public' },
    });
  }
  const { snapshots, changed, wallets, preferred } = sanitizeOscillatingBasisBands(snaps);
  assert.ok(changed >= 4);
  assert.deepEqual(wallets, [binance]);
  assert.equal(preferred[binance], pub + 6);
  for (const point of snapshots) {
    assert.ok(Math.abs(point.wallets[binance] - (pub + snapshots.indexOf(point) - (snapshots.indexOf(point) % 2 === 0 ? 0 : 1))) < 0.02
      || point.walletBasis[binance] === 'public'
      || Math.abs(point.wallets[binance] - pub) < 20);
    assert.equal(point.wallets[linea], 177.4);
  }
  // Low points move up onto the neighbouring public sample; onchain/total follow.
  const low = snapshots[1];
  assert.equal(low.wallets[binance], pub);
  assert.ok(Math.abs(low.onchain - (62165 - gap + 1 + gap)) < 0.05);
  assert.ok(Math.abs(low.totalUsd - (82020 - gap + 1 + gap)) < 0.05);
  const again = sanitizeOscillatingBasisBands(snapshots);
  assert.equal(again.changed, 0);
});
