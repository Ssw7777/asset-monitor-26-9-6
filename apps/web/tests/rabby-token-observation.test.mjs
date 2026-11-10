import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRabbyTokenObservation as parse, applyTokenObservation as apply, applySpecificTokenObservation as specific, tokenUuid} from '../src/lib/onchain/rabby-token-observation.ts';
const at = '2026-09-25T08:00:00Z';
const later = '2026-09-25T08:01:00Z';
const eth = {chain:'eth', id:'eth', symbol:'ETH', amount:.000123456789123, price:2500, is_core:true};
test('raw complete chain token list retains small quantity precision', () => { assert.equal(parse([eth], 'eth').tokens[0].amount, eth.amount); });
test('error envelope or wrong-chain data cannot zero balances', () => { assert.equal(parse({error:'limit'}, 'eth'), null); assert.equal(parse([eth], 'base'), null); });
test('identical duplicates are deduplicated, conflicting duplicates rejected', () => { assert.equal(parse([eth, eth], 'eth').tokens.length, 1); assert.equal(parse([eth, {...eth, amount:1}], 'eth'), null); });
test('scam and unpriced assets never inflate priced quantity', () => { const d = parse([eth, {...eth,id:'fake',amount:50,is_scam:true}, {...eth,id:'no-price',price:0}], 'eth'); assert.equal(d.tokens.length,1); assert.equal(d.unpricedCount,2); });
test('empty successful chain clears old quantity but preserves other chains', () => {
 const old = apply(undefined, parse([eth], 'eth'), at, 'eth');
 old.tokens.push({...old.tokens[0], chain:'base'}); old.chainUpdatedAt.base = at;
 const next = apply(old, parse([], 'eth'), later, 'eth'); assert.equal(next.tokens.length,1); assert.equal(next.tokens[0].chain,'base'); assert.equal(next.chainUpdatedAt.base,at);
});
test('failed read retains quantity and true success time; replay cannot overwrite', () => {
 const old = apply(undefined, parse([eth], 'eth'), at, 'eth');
 const failed = apply(old, null, later, 'eth', 'http_429'); assert.equal(failed.tokens[0].amount, eth.amount); assert.equal(failed.chainUpdatedAt.eth,at); assert.equal(failed.chainErrors.eth,'http_429');
 assert.equal(apply(failed, parse([], 'eth'), at, 'eth'), failed);
});
test('specific batch updates only returned identifiers, never treats omissions as zero', () => {
 const old = apply(undefined, parse([eth], 'eth'), at, 'eth');
 const absent = specific(old, ['eth:eth'], [], later); assert.equal(absent.tokens[0].amount, eth.amount); assert.equal(absent.tokenErrors['eth:eth'],'missing_token');
 const fresh = specific(old, ['eth:eth'], [{...eth, amount:.123456789}], later); assert.equal(fresh.tokens[0].amount,.123456789); assert.equal(fresh.tokens[0].updatedAt,later);
});
test('specified zero retains inventory for automatic rediscovery', () => {
 const old = apply(undefined, parse([eth], 'eth'), at, 'eth');
 const zero = specific(old, ['eth:eth'], [{...eth, amount:0}], later); assert.equal(zero.tokens.length,0); assert.equal(zero.inventory['eth:eth'].amount,0);
});
test('older chain response cannot overwrite a more recent specific-token observation', () => {
 const old = apply(undefined, parse([eth], 'eth'), at, 'eth');
 const newest = specific(old, ['eth:eth'], [{...eth, amount:1.25}], '2026-09-25T08:02:00Z');
 const reordered = apply(newest, parse([], 'eth'), later, 'eth'); assert.equal(reordered.tokens[0].amount,1.25);
});
test('legacy provider position IDs never become fabricated Rabby identifiers', () => {
 assert.equal(tokenUuid({chain:'eth',tokenId:'zerion-position:eth-123'}),null);
 assert.equal(tokenUuid({chain:'eth',tokenId:'eth'}),'eth:eth');
 assert.equal(tokenUuid({chain:'hood',tokenId:'zerion:eth',symbol:'ETH'}),'hood:hood');
 assert.equal(tokenUuid({chain:'bsc',tokenId:'zerion:eth',symbol:'ETH'}),null);
 assert.equal(tokenUuid({chain:'eth',tokenId:'unknown',symbol:'ETH'}),null);
 assert.equal(tokenUuid({chain:'eth',tokenId:'zerion:eth',symbol:'ETH',contractAddress:'0x1111111111111111111111111111111111111111'}),'eth:0x1111111111111111111111111111111111111111');
});
