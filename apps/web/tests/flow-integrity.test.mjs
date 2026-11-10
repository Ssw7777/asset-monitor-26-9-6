import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFlowEventsBetween, buildFlowSummary, asBalanceObservation } from '../src/lib/flows.ts';
import { walletFreshness } from '../src/lib/freshness.ts';
import { parseTransactionRecords } from '../src/lib/transaction-records.ts';

const ts = Date.now();
const a = '0x' + '1'.repeat(40), b = '0x' + '2'.repeat(40);
const state = { wallets: [{ address: a, name: 'A' }, { address: b, name: 'B' }], snapshots: [] };
const before = { ts: new Date(ts - 300000).toISOString(), wallets: { [a]: 1000, [b]: 1000 } };
const after = { ts: new Date(ts).toISOString(), wallets: { [a]: 835.78, [b]: 1164.22 } };

test('equal opposing deltas never become a transfer', () => {
  const events = detectFlowEventsBetween(state, before, after);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.direction), ['out', 'in']);
  assert.ok(events.every(e => !e.matched && e.counterparty === null && e.to === ''));
});
test('source switches and incomplete values do not generate flows', () => {
  const prev = { ...before, walletBasis: { [a]: 'public', [b]: 'public' } };
  const cur = { ...after, walletBasis: { [a]: 'direct', [b]: 'public-partial' } };
  assert.equal(detectFlowEventsBetween(state, prev, cur).length, 0);
});
test('wallet discovery does not look like a deposit', () => {
  assert.equal(detectFlowEventsBetween(state, { ...before, wallets: {} }, after).length, 0);
});
test('legacy inferred transfers lose their unsupported counterparties and dedupe', () => {
  const actual = detectFlowEventsBetween(state, before, after)[0];
  const legacy = { ...actual, id: 'old-pair', direction: 'transfer', matched: true, to: 'B', counterparty: 'B' };
  assert.equal(asBalanceObservation(legacy).amountUsd, 164.22);
  const summary = buildFlowSummary({ ...state, snapshots: [before, after], flowEvents: [legacy] });
  assert.equal(summary.events.length, 2);
  assert.equal(summary.netUsd, 0);
  assert.ok(summary.events.every(e => e.direction !== 'transfer' && e.to === ''));
});
test('fresh snapshot cannot make old wallet data fresh', () => {
  const result = walletFreshness([{ status: 'ok', lastSuccess: { at: new Date(ts - 52 * 60000).toISOString() } }], ts);
  assert.equal(result.fresh, 0);
  assert.equal(result.stale, 1);
  assert.equal(result.oldestAgeMs, 52 * 60000);
});
test('future timestamp is not accepted as fresh', () => {
  assert.equal(walletFreshness([{ status: 'ok', lastSuccess: { at: new Date(ts + 3600000).toISOString() } }], ts).fresh, 0);
});
const tx = { attributes: { hash: '0x' + 'a'.repeat(64), mined_at: after.ts, status: 'confirmed', operation_type: 'send', transfers: [{ sender: a, recipient: b, quantity: { numeric: '1.25' }, fungible_info: { symbol: 'ETH' }, value: null }] }, relationships: { chain: { data: { id: 'ethereum' } } } };
test('transaction evidence preserves real counterparties, unknown price and deduplicates', () => {
  const records = parseTransactionRecords({ data: [tx, tx] });
  assert.equal(records.length, 1);
  assert.equal(records[0].transfers[0].recipient, b);
  assert.equal(records[0].transfers[0].valueUsd, null);
});
test('pending, spam and hashless records are not confirmed transactions', () => {
  const data = [
    { ...tx, attributes: { ...tx.attributes, status: 'pending' } },
    { ...tx, attributes: { ...tx.attributes, flags: { is_trash: true } } },
    { ...tx, attributes: { ...tx.attributes, hash: '' } },
  ];
  assert.equal(parseTransactionRecords({ data }).length, 0);
  assert.throws(() => parseTransactionRecords({ error: '429' }));
});

test('paused Abstract wallets are excluded from freshness totals', () => {
  const now = ts;
  const active = { status: 'ok', address: '0x1111111111111111111111111111111111111111', lastSuccess: { at: new Date(now - 60_000).toISOString() } };
  const paused = { status: 'ok', address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', refreshPaused: true, lastSuccess: { at: new Date(now - 1186 * 60_000).toISOString() } };
  const result = walletFreshness([active, paused], now);
  assert.equal(result.total, 1);
  assert.equal(result.fresh, 1);
  assert.equal(result.stale, 0);
  assert.equal(result.oldestAgeMs, 60_000);
});
