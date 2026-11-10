import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {serializedFields,changedFields,deltaSql} from '../src/lib/store-delta.ts';
test('no-op polling checks generate no write or new revision',()=>{
 const state={snapshots:[{total:100}],rpcAudit:{usage:2}};
 assert.deepEqual(changedFields(serializedFields(state),structuredClone(state)),{});
});
test('delta replaces nested caches exactly, preserves snapshots, explicit null and deleted optional fields',()=>{
 const before={snapshots:[{total:100}],tokenCache:{wallet:{tokens:[1],tokenErrors:{old:'failed'}}},encryptedSecrets:'untouched',optional:'remove',onchainBreakdown:{old:1}};
 const after={...before,tokenCache:{wallet:{tokens:[],tokenErrors:{}}},onchainBreakdown:null};delete after.optional;
 const changes=changedFields(serializedFields(before),after),statement=deltaSql(changes);
 assert.equal(changes.snapshots,undefined);assert.equal(changes.encryptedSecrets,undefined);
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE t(value TEXT)');db.prepare('INSERT INTO t VALUES (?)').run(JSON.stringify(before));
 db.prepare(`UPDATE t SET value=${statement.expression}`).run(...statement.args);
 assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM t').get().value),after);db.close();
});
test('no JSON path or SQL injection is accepted as a state field',()=>{
 assert.throws(()=>deltaSql({'x);DROP TABLE t;--':'1'}));
});
test('thin provider mutations preserve the complete stored history and archived flows',()=>{
 const full={snapshots:[{ts:'yesterday',total:100}],flowEvents:[{id:'old-flow'}],tokenCache:{wallet:{amount:1}}};
 const thin={snapshots:[],flowEvents:[],tokenCache:{wallet:{amount:1}}},before=serializedFields(thin);
 thin.tokenCache.wallet.amount=2;
 const sql=deltaSql(changedFields(before,thin)),db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE t(value TEXT)');db.prepare('INSERT INTO t VALUES (?)').run(JSON.stringify(full));
 db.prepare(`UPDATE t SET value=${sql.expression}`).run(...sql.args);
 const saved=JSON.parse(db.prepare('SELECT value FROM t').get().value);
 assert.deepEqual(saved.snapshots,full.snapshots);assert.deepEqual(saved.flowEvents,full.flowEvents);assert.equal(saved.tokenCache.wallet.amount,2);db.close();
});
