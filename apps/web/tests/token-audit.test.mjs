import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTokens } from '../src/lib/token-audit.ts';
const now = Date.parse('2026-09-25T08:00:00Z');
const row = { chain: 'eth', symbol: 'ETH', tokenId: 'eth', amount: .00000123456789, valueUsd: 2, kind: 'native', isCore: true };
const seed = () => ({wallets: [{id: 'w', address: '0xABC'}], tokenCache: {'0xabc': {at: new Date(now).toISOString(), tokens: [row], coveredChains: ['*']}}, onchainBreakdown: {tokens: [{id:'eth:eth',chain: 'eth', symbol: 'ETH', wallets: [{walletId: 'w', amount: row.amount, valueUsd: row.valueUsd}]}]}});
test('all tokens are audited at original quantity precision', () => { assert.equal(auditTokens(seed(), now).healthy, true); });
test('provider ticker aliases do not masquerade as quantity discrepancies', () => { const s = seed(); s.onchainBreakdown.tokens[0].symbol='Ethereum'; assert.equal(auditTokens(s, now).aggregateMismatches,0); });
test('a fresh wallet total cannot hide stale token detail', () => { const s = seed(); s.tokenCache['0xabc'].at = new Date(now - 11*60000).toISOString(); assert.equal(auditTokens(s, now).staleWallets, 1); });
test('two decimal quantity truncation is detected', () => { const s = seed(); s.onchainBreakdown.tokens[0].wallets[0].amount = 0; assert.equal(auditTokens(s, now).aggregateMismatches, 1); });
test('missing, partial, duplicate, invalid and failed data never pass', () => {
 const s = seed(); s.tokenCache['0xabc'].tokens.push({...row}); assert.equal(auditTokens(s, now).duplicateRows, 1);
 s.tokenCache['0xabc'].tokens[1].amount = NaN; assert.equal(auditTokens(s, now).invalidRows, 1);
 s.tokenCache['0xabc'].lastError = 'http_429'; assert.equal(auditTokens(s, now).failedWallets, 1);
 delete s.tokenCache['0xabc']; assert.equal(auditTokens(s, now).missingWallets, 1);
 const partial = seed(); partial.tokenCache['0xabc'].coveredChains = ['eth']; partial.chainCache = {'0xabc': {chains: [{id: 'base', valueUsd: 1}]}}; assert.equal(auditTokens(partial, now).healthy, false);
});
test('per-chain freshness prevents an updated chain from disguising another stale chain', () => {
 const s = seed(); s.chainCache = {'0xabc': {chains: [{id: 'eth', valueUsd: 2}, {id: 'base', valueUsd: 1}]}};
 s.tokenCache['0xabc'].chainUpdatedAt = {eth: new Date(now).toISOString(), base: new Date(now - 11*60000).toISOString()};
 assert.equal(auditTokens(s, now).staleWallets, 1);
 s.tokenCache['0xabc'].chainUpdatedAt.base = new Date(now).toISOString(); assert.equal(auditTokens(s, now).freshWallets, 1);
});
