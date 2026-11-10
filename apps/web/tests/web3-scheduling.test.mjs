import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dueWeb3Wallets} from '../src/lib/web3-scheduling.ts';
const now=Date.parse('2026-09-29T01:00:00Z');
const iso=minutes=>new Date(now-minutes*60000).toISOString();
const wallets=[{id:'a',address:'0x1111111111111111111111111111111111111111'},{id:'b',address:'0x2222222222222222222222222222222222222222'},{id:'c',address:'0x3333333333333333333333333333333333333333'}];

test('unstarted reservations retry without the two-minute success interval',()=>{
  const audit={wallets:{a:{lastAttemptAt:iso(1),retryAt:iso(.1),tokensAt:iso(15)},b:{lastAttemptAt:iso(1),tokensAt:iso(1)},c:{lastAttemptAt:iso(7),tokensAt:iso(7)}}};
  assert.deepEqual(dueWeb3Wallets(wallets,audit,now).map(w=>w.id),['a','c']);
});
test('requeue respects future retry time, never prioritizes a fresh quantity over an older eligible wallet',()=>{
  const audit={wallets:{a:{lastAttemptAt:iso(5),retryAt:iso(-1),tokensAt:iso(15)},b:{lastAttemptAt:iso(8),tokensAt:iso(4)},c:{lastAttemptAt:iso(5),tokensAt:iso(8)}}};
  assert.deepEqual(dueWeb3Wallets(wallets,audit,now,1).map(w=>w.id),['c']);
});
