import test from 'node:test';
import assert from 'node:assert/strict';
import { needsProtocolRefresh } from '../src/lib/scheduler-freshness.ts';

const now = Date.parse('2026-09-25T00:00:00Z');
const ago = minutes => new Date(now - minutes * 60_000).toISOString();

test('protocol observations refresh before five minutes, independently of app audits', () => {
  assert.equal(needsProtocolRefresh(ago(2), now), false);
  assert.equal(needsProtocolRefresh(ago(3.5), now), false);
  assert.equal(needsProtocolRefresh(ago(3.51), now), true);
  assert.equal(needsProtocolRefresh(ago(180), now), true);
});
test('missing, invalid and future protocol timestamps are due', () => {
  assert.equal(needsProtocolRefresh(undefined, now), true);
  assert.equal(needsProtocolRefresh('invalid', now), true);
  assert.equal(needsProtocolRefresh(ago(-2), now), true);
});
