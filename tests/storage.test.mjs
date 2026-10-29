import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { ArchiveStorage } from '../storage.js';

const message = (id, author = 'u', content = id) => ({id,channel_id:'c',author:{id:author,display_name:author,username:author},content});
async function fresh() { return ArchiveStorage.open({indexedDB,IDBKeyRange,name:`test-${crypto.randomUUID()}`}); }
test('append atomically deduplicates stable IDs, preserves anonymous messages and checkpoints', async () => {
 const db=await fresh(); const job=await db.create({channel:{id:'c',name:'room'},settings:{cap:20}});
 await db.append(job.id,[message('3'),message('2'),message(null)],{cursor:'2',scanned:3,status:'collecting'});
 const updated=await db.append(job.id,[message('2'),message('1'),message(null)],{cursor:'1',scanned:6,status:'collecting'});
 assert.equal(updated.count,5); assert.equal(updated.cursor,'1'); assert.equal(updated.scanned,6);
 assert.deepEqual(updated.settings,{cap:20});
 const {users}=await db.summary(job.id); assert.equal(users[0].count,5);
 const page=await db.readPage(job.id,{limit:2}); assert.equal(page.messages.length,2);
 const rows=[...page.messages]; let after=page.next;
 while(after!==null){const p=await db.readPage(job.id,{after,limit:2});rows.push(...p.messages);after=p.next;}
 assert.deepEqual(rows.map(m=>m.id),[null,'1',null,'2','3']); db.close();
});
test('invalid batch rolls back messages, counts and checkpoint together',async()=>{
 const db=await fresh(); const job=await db.create({channel:{id:'c',name:'room'},settings:{}});
 await assert.rejects(db.append(job.id,[message('a'),{...message('b'),content:()=>{}}],{cursor:'b',scanned:2}));
 assert.equal((await db.get(job.id)).count,0);assert.equal((await db.get(job.id)).cursor,null);
 assert.deepEqual((await db.summary(job.id)).users,[]); db.close();
});
test('imports preserve source order; deletion only deletes selected job',async()=>{
 const db=await fresh(); const a=await db.create({channel:{name:'import'},kind:'import'}); const b=await db.create({channel:{name:'kept'}});
 await db.append(a.id,[message('3'),message('1'),message('2')]);
 assert.deepEqual((await db.readPage(a.id)).messages.map(m=>m.id),['3','1','2']);
 await db.delete(a.id); assert.equal(await db.get(a.id),undefined);assert.equal((await db.get(b.id)).id,b.id);db.close();
});
test('finish retains cursor/settings and summary searches bounded user results',async()=>{
 const db=await fresh();const a=await db.create({channel:{id:'c',name:'r'},settings:{before:'9'}});
 await db.append(a.id,Array.from({length:210},(_,i)=>message(String(i),`person-${i}`)),{cursor:'7',scanned:210});
 const done=await db.update(a.id,{status:'paused'});assert.equal(done.cursor,'7');assert.deepEqual(done.settings,{before:'9'});
 const summary=await db.summary(a.id);assert.equal(summary.users.length,200);assert.equal(summary.truncatedUsers,true);
 assert.equal((await db.summary(a.id,'person-209')).users.length,1);db.close();
});
test('deduplicates repeated identities within a batch without collapsing other channels',async()=>{
 const db=await fresh();const a=await db.create({channel:{id:'c',name:'r'}});
 const result=await db.append(a.id,[message('1'),message('1'),{...message('1'),channel_id:'d'},message(null),message(null)]);
 assert.equal(result.count,4);assert.equal((await db.summary(a.id)).users[0].key,'id:u');db.close();
});
test('name-only author keys preserve an explicitly empty display name for Rust filtering',async()=>{
 const db=await fresh();const job=await db.create({channel:{name:'import'},kind:'import'});
 await db.append(job.id,[{...message('1'),author:{id:null,display_name:'',username:'u'}}]);
 assert.equal((await db.summary(job.id)).users[0].key,'name:');db.close();
});

test('a reopened database recovers the exact committed checkpoint and records',async()=>{
 const name=crypto.randomUUID();let db=await ArchiveStorage.open({indexedDB,IDBKeyRange,name});
 const job=await db.create({channel:{id:'c',name:'r'},settings:{batchSize:50}});
 await db.append(job.id,[message('2'),message('1')],{cursor:'1',scanned:2,status:'paused'});db.close();
 db=await ArchiveStorage.open({indexedDB,IDBKeyRange,name});const recovered=await db.get(job.id);
 assert.equal(recovered.cursor,'1');assert.equal(recovered.status,'paused');assert.equal(recovered.count,2);
 assert.deepEqual((await db.readPage(job.id)).messages.map(m=>m.id),['1','2']);db.close();
});
