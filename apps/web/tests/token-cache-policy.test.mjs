import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeTokenCacheObservation, tokenCacheNeedsRefresh, tokenIdentity, hasNonzeroHolding, TOKEN_SUCCESS_TTL_MS, TOKEN_RETRY_TTL_MS } from '../src/lib/onchain/token-cache-policy.ts';

const now = Date.now();
const at = new Date(now - 60 * 60 * 1000).toISOString();
const observedAt = new Date(now).toISOString();
const line = (chain, symbol, amount) => ({ chain, symbol, amount, valueUsd: amount, tokenId: symbol, kind: 'spot' });
const previous = { at, lastAttemptAt: at, tokens: [line('eth', 'ETH', 0.0000123456789), line('bsc', 'USDT', 100)], coveredChains: ['*'], unpricedByChain: { eth: 1, bsc: 2 }, unpricedCount: 3 };

test('a partial chain refresh preserves other chains and their success age', () => {
  const result = mergeTokenCacheObservation(previous, { tokens: [line('bsc', 'USDT', 200)], coveredChains: ['bsc'], unpricedByChain: { bsc: 1 }, unpricedCount: 1 }, observedAt);
  assert.equal(result.tokens.find(t => t.chain === 'eth').amount, 0.0000123456789);
  assert.equal(result.tokens.find(t => t.chain === 'bsc').amount, 200);
  assert.equal(result.tokens.length, 2);
  assert.equal(result.at, at);
  assert.equal(result.lastAttemptAt, observedAt);
  assert.equal(result.unpricedCount, 2);
});

test('a successful empty chain clears old holdings only on that chain', () => {
  const result = mergeTokenCacheObservation(previous, { tokens: [], coveredChains: ['bsc'], unpricedByChain: {}, unpricedCount: 0 }, observedAt);
  assert.deepEqual(result.tokens.map(t => t.chain), ['eth']);
  assert.deepEqual(result.unpricedByChain, { eth: 1 });
});

test('a successful all-chain response replaces old holdings and renews success timestamp', () => {
  const result = mergeTokenCacheObservation(previous, { tokens: [], coveredChains: ['*'], unpricedByChain: {}, unpricedCount: 0 }, observedAt);
  assert.equal(result.tokens.length, 0);
  assert.equal(result.at, observedAt);
});

test('truncated pagination with no covered chains cannot overwrite or duplicate cached rows', () => {
  const partial = { tokens: [line('bsc', 'USDT', 250)], coveredChains: [], unpricedByChain: {}, unpricedCount: 0 };
  const result = mergeTokenCacheObservation(previous, partial, observedAt);
  assert.deepEqual(result.tokens, previous.tokens);
  assert.equal(result.at, at);
  assert.equal(result.lastAttemptAt, observedAt);
  const missing = mergeTokenCacheObservation(null, partial, observedAt);
  assert.equal(missing.at, '');
  assert.deepEqual(missing.tokens, []);
});

test('successful reads last twelve hours but failures retry after fifteen minutes', () => {
  assert.equal(tokenCacheNeedsRefresh(previous, Date.parse(at) + TOKEN_SUCCESS_TTL_MS - 1), false);
  assert.equal(tokenCacheNeedsRefresh(previous, Date.parse(at) + TOKEN_SUCCESS_TTL_MS), true);
  const failed = { ...previous, lastAttemptAt: observedAt };
  assert.equal(tokenCacheNeedsRefresh(failed, now + TOKEN_RETRY_TTL_MS - 1), false);
  assert.equal(tokenCacheNeedsRefresh(failed, now + TOKEN_RETRY_TTL_MS), true);
  assert.equal(failed.at, at);
});

test('missing, invalid or future success times are not fresh', () => {
  assert.equal(tokenCacheNeedsRefresh(undefined, now), true);
  assert.equal(tokenCacheNeedsRefresh({ ...previous, at: '', lastAttemptAt: '' }, now), true);
  assert.equal(tokenCacheNeedsRefresh({ ...previous, at: new Date(now + 60000).toISOString(), lastAttemptAt: '' }, now), true);
});

test('the final aggregation never rounds token quantities to currency precision', () => {
  const source = readFileSync(new URL('../src/lib/onchain/debank.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /amount:\s*rounded\(/);
});

test('tiny positive balances survive aggregation; display folding does not delete quantities', () => {
  assert.equal(hasNonzeroHolding({amount:0.00000123456789,valueUsd:0.003}),true);
  assert.equal(hasNonzeroHolding({amount:12,valueUsd:0}),true);
  assert.equal(hasNonzeroHolding({amount:0,valueUsd:0}),false);
  const source=readFileSync(new URL('../src/lib/onchain/debank.ts',import.meta.url),'utf8');
  assert.match(source,/\.filter\(hasNonzeroHolding\)/);
  assert.doesNotMatch(source,/\.filter\(\(holding\) => holding\.valueUsd >= 0\.01\)/);
});

test('contract identity prevents same-symbol aggregation and prefers canonical provider metadata', () => {
  assert.notEqual(tokenIdentity({ tokenId: '0x111', symbol: 'USDG' }), tokenIdentity({ tokenId: '0x222', symbol: 'USDG' }));
  assert.equal(tokenIdentity({ tokenId: 'old-position-id', assetId: 'usdg', contractAddress: '0xABC' }), '0xabc');
  assert.equal(tokenIdentity({ tokenId: 'old-position-id', assetId: 'ethereum' }), 'ethereum');
  assert.equal(tokenIdentity({ tokenId: 'SolMintCaseSensitive' }), 'SolMintCaseSensitive');
});
