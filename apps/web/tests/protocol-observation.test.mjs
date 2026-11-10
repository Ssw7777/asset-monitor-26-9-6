import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyProtocolObservation} from '../src/lib/onchain/protocol-observation.ts';
const now=1800000000000,at=new Date(now).toISOString();
const old={at:new Date(now-600000).toISOString(),protocols:[{id:'meridian',portfolio_item_list:[{}]}],apps:[{id:'app:polymarket'}]};
test('verified withdrawal removes old positions but preserves independent app observation',()=>{
  const next=applyProtocolObservation(old,[],at,now);
  assert.deepEqual(next.protocols,[]);assert.deepEqual(next.apps,old.apps);assert.equal(next.at,at);
});
test('partial/malformed/error protocol payload never clears positions',()=>{
  for(const raw of [{error:'limited'},[null],[{id:'fables'}],{data:{error:'failed'}}])assert.throws(()=>applyProtocolObservation(old,raw,at,now));
  assert.equal(old.protocols.length,1);
});
test('older observation cannot resurrect a withdrawn position',()=>{
  const empty=applyProtocolObservation(old,[],at,now);
  assert.equal(applyProtocolObservation(empty,old.protocols,new Date(now-1000).toISOString(),now),empty);
  assert.throws(()=>applyProtocolObservation(old,[],new Date(now-700000).toISOString(),now));
});
