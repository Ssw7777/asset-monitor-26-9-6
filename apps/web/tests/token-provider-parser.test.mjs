import test from 'node:test';
import assert from 'node:assert/strict';
import { parseZerionQuantity, parseZerionPositionPage, safeNextPositionPage, readZerionPositionPages } from '../src/lib/onchain/zerion-position-parser.ts';

const initial = 'https://api.zerion.io/v1/wallets/0x123/positions/?currency=usd&filter[positions]=only_simple';
const normalize = chain => chain === 'ethereum' ? 'eth' : chain || 'unknown';
const position = (id, overrides = {}) => ({
  id,
  attributes: {
    position_type: 'wallet', quantity: { numeric: '0.1085614988' }, value: 300,
    fungible_info: { id: 'eth-asset', symbol: 'ETH', implementations: [{ chain_id: 'ethereum', address: '0x' + 'A'.repeat(40) }] },
    ...overrides,
  },
  relationships: { chain: { data: { id: 'ethereum' } } },
});
const response = (data, next) => ({ status: 200, body: { data, links: { next } } });

test('decimal quantity never uses two-decimal rounding or a stale float when numeric exists', () => {
  assert.deepEqual(parseZerionQuantity({ numeric: '0.1085614988', float: 0.39 }), { amount: 0.1085614988, exact: '0.1085614988' });
  assert.deepEqual(parseZerionQuantity({ numeric: '1886.778707', float: 1144.69 }), { amount: 1886.778707, exact: '1886.778707' });
});
test('integer quantity is scaled as decimal text before conversion and keeps exact precision', () => {
  assert.deepEqual(parseZerionQuantity({ int: '123456789123456789123456', decimals: 18 }), {
    amount: 123456.789123456789123456, exact: '123456.789123456789123456',
  });
  assert.deepEqual(parseZerionQuantity({ int: '1', decimals: 18 }), { amount: 1e-18, exact: '0.000000000000000001' });
  assert.deepEqual(parseZerionQuantity({ int: '-123', decimals: 5 }), { amount: -0.00123, exact: '-0.00123' });
  assert.deepEqual(parseZerionQuantity({ int: '10', decimals: 0 }), { amount: 10, exact: '10' });
  assert.equal(parseZerionQuantity({ numeric: '1e-999', float: 0 }), null);
  assert.equal(parseZerionQuantity({ int: '1', decimals: 99999 }), null);
  assert.equal(parseZerionQuantity({}), null);
});
test('numeric/int malformed values fall back to valid float, but absent data is not zero', () => {
  assert.deepEqual(parseZerionQuantity({ numeric: 'invalid', int: 'invalid', float: 0.00000123 }), { amount: 0.00000123, exact: '0.00000123' });
  assert.equal(parseZerionQuantity({ float: null }), null);
  assert.equal(parseZerionQuantity({ float: Infinity }), null);
  assert.deepEqual(parseZerionQuantity({ numeric: '0' }), { amount: 0, exact: '0' });
});
test('asset identity comes from contract and provider fungible ID, not ticker', () => {
  const first = position('eth-1');
  const second = position('other-1', { fungible_info: { id: 'another-asset', symbol: 'ETH', implementations: [{ chain_id: 'ethereum', address: '0x' + 'B'.repeat(40) }] } });
  const parsed = parseZerionPositionPage({ data: [first, second] }, normalize);
  assert.equal(parsed.invalidRows, 0);
  assert.equal(parsed.rows[0].tokenId, '0x' + 'a'.repeat(40));
  assert.equal(parsed.rows[0].assetId, 'zerion:eth-asset');
  assert.notEqual(parsed.rows[0].tokenId, parsed.rows[1].tokenId);
});
test('explicit zero value is not replaced with a stale price; trash positions are excluded', () => {
  const parsed = parseZerionPositionPage({ data: [position('zero', { value: 0, price: 100 }), position('trash', { flags: { is_trash: true } })] }, normalize);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].valueUsd, 0);
});
test('full paginated response deduplicates identical positions across pages', async () => {
  const calls = [];
  let budgetCalls = 0;
  const result = await readZerionPositionPages(initial, async url => {
    calls.push(url);
    return calls.length === 1 ? response([position('a')], '?page[after]=a') : response([position('a'), position('b')], null);
  }, normalize, { maxPages: 2, beforeRequest: () => { budgetCalls++; return true; } });
  assert.equal(result.complete, true);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.rows.length, 2);
  assert.equal(budgetCalls, 2);
  assert.equal(new URL(calls[1]).searchParams.get('filter[positions]'), 'only_simple');
});
test('default one-page quota never silently expands or reports truncated list complete', async () => {
  let calls = 0;
  const result = await readZerionPositionPages(initial, async () => { calls++; return response([position('a')], '?page[after]=a'); }, normalize);
  assert.equal(calls, 1);
  assert.equal(result.complete, false);
  assert.equal(result.partialReason, 'page_limit');
});
test('budget checks happen for every page and denied budget stops before request', async () => {
  let calls = 0, budgetCalls = 0;
  const result = await readZerionPositionPages(initial, async () => { calls++; return response([position('a')], '?page[after]=a'); }, normalize, {
    maxPages: 4, beforeRequest: () => ++budgetCalls < 2,
  });
  assert.equal(calls, 1);
  assert.equal(result.partialReason, 'budget');
  assert.equal(result.complete, false);
  const firstDenied = await readZerionPositionPages(initial, async () => { throw new Error('must not request'); }, normalize, { beforeRequest: () => false });
  assert.equal(firstDenied, null);
});
test('foreign host, different wallet, credentials and narrowing filters cannot receive a pagination request', async () => {
  const unsafe = [
    'https://evil.example/positions/',
    'https://api.zerion.io/v1/wallets/other/positions/',
    'https://secret@api.zerion.io/v1/wallets/0x123/positions/',
    '?page[after]=a&currency=eth', '?page[after]=a&filter[chain_ids]=ethereum',
    '?page[after]=a&currency=usd&currency=eth',
  ];
  for (const next of unsafe) {
    assert.equal(safeNextPositionPage(initial, next), null);
    let calls = 0;
    const result = await readZerionPositionPages(initial, async () => { calls++; return response([position('a')], next); }, normalize, { maxPages: 3 });
    assert.equal(calls, 1);
    assert.equal(result.partialReason, 'unsafe_next');
    assert.equal(result.complete, false);
  }
});
test('pagination loop, later HTTP error and inconsistent duplicate keep prior result incomplete', async () => {
  const loop = await readZerionPositionPages(initial, async () => response([position('a')], initial), normalize, { maxPages: 3 });
  assert.equal(loop.partialReason, 'pagination_loop');
  let calls = 0;
  const failed = await readZerionPositionPages(initial, async () => ++calls === 1 ? response([position('a')], '?page[after]=a') : { status: 429, body: {} }, normalize, { maxPages: 3 });
  assert.equal(failed.partialReason, 'http_error');
  assert.equal(failed.rows.length, 1);
  calls = 0;
  const conflict = await readZerionPositionPages(initial, async () => ++calls === 1 ? response([position('a')], '?page[after]=a') : response([position('a', { quantity: { numeric: '5' } })]), normalize, { maxPages: 3 });
  assert.equal(conflict.partialReason, 'invalid_response');
  assert.equal(conflict.complete, false);
});
test('API errors, malformed rows and pending HTTP 202 never become an empty successful wallet', async () => {
  assert.equal(parseZerionPositionPage({ data: [], errors: [{ title: 'unavailable' }] }, normalize), null);
  assert.equal(await readZerionPositionPages(initial, async () => ({ status: 202, body: { data: [] } }), normalize), null);
  const malformed = await readZerionPositionPages(initial, async () => response([{ id: 'bad', attributes: {} }]), normalize);
  assert.equal(malformed.complete, false);
  assert.equal(malformed.partialReason, 'invalid_response');
  const empty = await readZerionPositionPages(initial, async () => response([], null), normalize);
  assert.equal(empty.complete, true);
  assert.deepEqual(empty.rows, []);
});
test('expired deadline and zero pages do not spend quota', async () => {
  let calls = 0;
  const request = async () => { calls++; return response([]); };
  assert.equal(await readZerionPositionPages(initial, request, normalize, { deadlineMs: Date.now() }), null);
  assert.equal(await readZerionPositionPages(initial, request, normalize, { maxPages: 0 }), null);
  assert.equal(calls, 0);
});
