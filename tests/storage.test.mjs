import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
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

async function seedVersionOne(name, job, rows, users = []) {
 const opening=indexedDB.open(name,1);
 opening.onupgradeneeded=()=>{
  const db=opening.result;
  db.createObjectStore('jobs',{keyPath:'id'});
  const messages=db.createObjectStore('messages',{keyPath:['jobId','order']});
  messages.createIndex('identity',['jobId','identity'],{unique:true});
  db.createObjectStore('users',{keyPath:['jobId','key']});
 };
 const db=await new Promise((resolve,reject)=>{opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error);});
 const tx=db.transaction(['jobs','messages','users'],'readwrite');
 tx.objectStore('jobs').add(job);
 for(const row of rows)tx.objectStore('messages').add(row);
 for(const user of users)tx.objectStore('users').add(user);
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
}

test('v1 migration backfills author reads without loading messages together or changing committed data',async t=>{
 const name=crypto.randomUUID(),job={id:'old',kind:'capture',name:'Kept',channel:{id:'c',name:'r'},settings:{cap:500},status:'paused',count:250,cursor:'last',bytes:900,scanned:270};
 const rows=Array.from({length:250},(_,i)=>({jobId:job.id,order:-i-1,identity:JSON.stringify(['c',String(i)]),message:message(String(i),i%100===0?'selected':'other')}));
 rows[10].message.author={id:null,display_name:'Name'};rows[11].message.author={display_name:'Name'};
 rows[12].message.author={id:null,display_name:'',username:'fallback'};
 await seedVersionOne(name,job,rows,[{jobId:job.id,key:'id:selected',count:3,display_name:'selected'}]);
 const original=IDBObjectStore.prototype.getAll;
 IDBObjectStore.prototype.getAll=function(...args){assert.notEqual(this.name,'messages','migration must stream records');return original.apply(this,args);};
 t.after(()=>{IDBObjectStore.prototype.getAll=original;});
 const db=await ArchiveStorage.open({indexedDB,IDBKeyRange,name});t.after(()=>db.close());
 assert.deepEqual(await db.get(job.id),job);
 assert.deepEqual((await db.summary(job.id)).users,[{key:'id:selected',count:3,display_name:'selected'}]);
 assert.deepEqual((await db.readPage(job.id,{userKey:'id:selected'})).messages.map(m=>m.id),['200','100','0']);
 assert.deepEqual((await db.readPage(job.id,{userKey:'name:Name'})).messages.map(m=>m.id),['11','10']);
 assert.deepEqual((await db.readPage(job.id,{userKey:'name:'})).messages.map(m=>m.id),['12']);
 const recovered=[];let after=null;
 do{const page=await db.readPage(job.id,{after});recovered.push(...page.messages);after=page.next;}while(after!==null);
 assert.deepEqual(recovered,rows.toReversed().map(row=>row.message));
 await db.append(job.id,[message('0','selected'),message('new','selected')],{cursor:'new'});
 assert.equal((await db.get(job.id)).count,251);
});

for(const kind of ['capture','import'])test(`${kind} selected-author pages preserve sparse source order and continuation`,async t=>{
 const db=await fresh();t.after(()=>db.close());const job=await db.create({kind,channel:{id:'c',name:'r'}});
 const rows=Array.from({length:305},(_,i)=>message(String(i),[0,140,260,304].includes(i)?'selected':'other'));
 for(let i=0;i<rows.length;i+=100)await db.append(job.id,rows.slice(i,i+100));
 const first=await db.readPage(job.id,{userKey:'id:selected',limit:2});
 const second=await db.readPage(job.id,{userKey:'id:selected',limit:2,after:first.next});
 assert.deepEqual(first.messages.map(m=>m.id),kind==='capture'?['304','260']:['0','140']);
 assert.deepEqual(second.messages.map(m=>m.id),kind==='capture'?['140','0']:['260','304']);
 assert.notEqual(first.next,null);assert.equal(second.next,null);
 assert.deepEqual(await db.readPage(job.id,{userKey:'id:absent'}),{messages:[],next:null});
});

test('author index distinguishes stable IDs, missing IDs and explicitly empty display names',async t=>{
 const db=await fresh();t.after(()=>db.close());const job=await db.create({kind:'import'});
 const authorRows=[{id:'u',display_name:'Same'},{id:null,display_name:'Same'},{display_name:'Same'},{id:null,display_name:'',username:'Same'},{id:'',display_name:'Same'},null];
 await db.append(job.id,authorRows.map((author,i)=>({...message(String(i)),author})));
 for(const [key,want] of [['id:u',['0']],['name:Same',['1','2']],['name:',['3']],['id:',['4']],['name:Unknown',['5']]])
  assert.deepEqual((await db.readPage(job.id,{userKey:key})).messages.map(m=>m.id),want);
});

test('failed appends leave no selected-author records and indexed pages stay capped at 100',async t=>{
 const db=await fresh();t.after(()=>db.close());const job=await db.create({kind:'import'});
 await assert.rejects(db.append(job.id,[message('bad','rolled-back'),{...message('bad2'),content:()=>{}}]));
 assert.deepEqual(await db.readPage(job.id,{userKey:'id:rolled-back'}),{messages:[],next:null});
 await db.append(job.id,Array.from({length:110},(_,i)=>message(String(i),'selected')));
 const page=await db.readPage(job.id,{userKey:'id:selected',limit:999});
 assert.equal(page.messages.length,100);assert.notEqual(page.next,null);
 assert.equal((await db.readPage(job.id,{userKey:'id:selected',after:page.next})).messages.length,10);
 assert.equal((await db.readPage(job.id,{userKey:'id:selected',limit:2.5})).messages.length,2);
});

test('updateInfo finds the numeric newest ID for one channel using identity keys without reading message bodies',async t=>{
 const db=await fresh();t.after(()=>db.close());const job=await db.create({channel:{id:'c',name:'r'}});
 await db.append(job.id,[message('9'),message('10'),message('10000000000000000000'),{...message('99999999999999999999'),channel_id:'d'},message('known-nonnumeric'),message(null)]);
 const cursor=IDBObjectStore.prototype.openCursor,getAll=IDBObjectStore.prototype.getAll;
 IDBObjectStore.prototype.openCursor=function(...args){assert.notEqual(this.name,'messages','update info must use identity keys');return cursor.apply(this,args);};
 IDBObjectStore.prototype.getAll=function(...args){assert.notEqual(this.name,'messages','update info must not load message bodies');return getAll.apply(this,args);};
 t.after(()=>{IDBObjectStore.prototype.openCursor=cursor;IDBObjectStore.prototype.getAll=getAll;});
 db.readPage=()=>{throw new Error('update info must not page message bodies');};
 const info=await db.updateInfo(job.id,'c');
 assert.equal(info.job.id,job.id);assert.equal(info.newestId,'10000000000000000000');assert.equal(info.hasMissingIds,true);assert.equal(info.hasNonNumericIds,true);
 assert.equal((await db.updateInfo(job.id,'d')).newestId,'99999999999999999999');
 assert.equal((await db.updateInfo(job.id,'absent')).newestId,null);
});

test('updateInfo never invents an anchor for legacy ID-less messages and can cancel key iteration',async t=>{
 const db=await fresh();t.after(()=>db.close());const job=await db.create({kind:'import'});
 await db.append(job.id,[{...message(null),channel_id:null}]);
 const info=await db.updateInfo(job.id,'c');assert.equal(info.newestId,null);assert.equal(info.hasMissingIds,true);
 await assert.rejects(db.updateInfo('missing','c'),/not found/i);
 await assert.rejects(db.updateInfo(job.id,null),/channel/i);
 await db.append(job.id,[message('1'),message('2')]);
 await assert.rejects(db.updateInfo(job.id,'c',{check:()=>{throw new Error('Operation cancelled');}}),/cancel/i);
});
