import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { ArchiveStorage } from '../storage.js';
import { createArchiveWorker } from '../archive-worker.js';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

const msg=(id,content='hello')=>({id,channel_id:'c',author:{id:'u',display_name:'User',username:'user'},content});
class Exporter {
 constructor(format,options,metadata){this.format=format;this.options=JSON.parse(options);this.metadata=JSON.parse(metadata);this.n=0;}
 begin(){return '[';} push(raw){return JSON.parse(raw).filter(m=>!this.options.skip_empty||m.content).map(m=>`${this.n++?',':''}${JSON.stringify(m.content)}`).join('');}
 finish(){return ']';}count(){return this.n;}free(){}
}
class Importer{
 constructor(kind){this.kind=kind;this.tail='';}
 feed(chunk){this.tail+=chunk;const lines=this.tail.split('\n');this.tail=lines.pop();return JSON.stringify({messages:lines.filter(Boolean).map(JSON.parse)});}
 finish(){if(this.tail==='broken')throw Error('truncated');return JSON.stringify({messages:this.tail?[JSON.parse(this.tail)]:[]});}free(){}
}
function disk(){const files=new Map();return {files,writeCalls:0,async getDirectoryHandle(){return this;},async *entries(){for(const name of files.keys())yield [name,{kind:'file'}];},async getFileHandle(name){const fs=this;return {async createWritable(){let chunks=[];return {async write(s){assert.ok(s.length<1000000);fs.writeCalls++;chunks.push(s);},async close(){files.set(name,new File(chunks,name));},async abort(){files.delete(name);}};},async getFile(){return files.get(name);}};},async removeEntry(name){files.delete(name);}};}
async function setup(extra={}){const storage=await ArchiveStorage.open({indexedDB,IDBKeyRange,name:crypto.randomUUID()});const fs=disk();return {storage,fs,worker:createArchiveWorker({storage,engine:{ArchiveImporter:Importer,ArchiveExporter:Exporter,normalize_batch:raw=>raw},getDirectory:async()=>fs,estimate:async()=>({usage:1,quota:1e9}),...extra})};}
test('NDJSON filenames select line-delimited parsing',async()=>{
 const kinds=[];class Kind extends Importer{constructor(kind){super(kind);kinds.push(kind);}}
 const {worker,storage}=await setup({engine:{ArchiveImporter:Kind}});
 await worker.dispatch({type:'import',file:new File([JSON.stringify(msg('1'))+'\n'],'data.ndjson')});
 assert.equal(kinds[0],'jsonl');storage.close();
});

test('RPC appends before replying, previews and streams split disk-backed exports',async()=>{
 const {worker,storage,fs}=await setup();const job=await worker.dispatch({type:'create',channel:{id:'c',name:'room'},settings:{cap:10}});
 await worker.dispatch({type:'append',jobId:job.id,messages:[msg('3'),msg('2',''),msg('1')],checkpoint:{cursor:'1',scanned:3}});
 const preview=await worker.dispatch({type:'preview',jobId:job.id,format:'messages',options:{skip_empty:true}});assert.equal(preview.count,2);
 const result=await worker.dispatch({type:'export',jobId:job.id,formats:['messages','html'],options:{skip_empty:true},splitMessages:1,filename:'../bad/name'});
 assert.equal(result.count,2);assert.equal(result.files.length,4);assert.equal(fs.files.size,4);
 for(const f of result.files){assert.ok(f.file instanceof File);assert.equal(f.count,1);assert.ok(!/[\\/]/.test(f.name));assert.equal(JSON.parse(await f.file.text()).length,1);}
 storage.close();
});
test('failed staging import retains existing job and successful import reports actual bytes',async()=>{
 const {worker,storage}=await setup();const kept=await worker.dispatch({type:'create',channel:{name:'kept'}});
 await assert.rejects(worker.dispatch({type:'import',file:new File([JSON.stringify(msg('1'))+'\nbroken'],'broken.jsonl')}),/truncated/);
 assert.deepEqual((await storage.list()).map(j=>j.id),[kept.id]);
 const file=new File([JSON.stringify(msg('1','💬'))+'\n'],'good.jsonl');const imported=await worker.dispatch({type:'import',file});
 assert.equal(imported.count,1);assert.equal(imported.bytes,file.size);assert.equal(imported.status,'ready');storage.close();
});
test('unsupported OPFS is actionable and no output is buffered as a fallback',async()=>{
 const {worker,storage}=await setup({getDirectory:undefined});const j=await worker.dispatch({type:'create',channel:{name:'r'}});
 await assert.rejects(worker.dispatch({type:'export',jobId:j.id,formats:['full']}),/disk|OPFS/i);storage.close();
});
test('cancel interrupts active export and removes only its generated scratch files',async()=>{
 let worker;let triggered=false;const progress=()=>{if(!triggered){triggered=true;worker.dispatch({type:'cancel'});}};
 const setupResult=await setup({progress});worker=setupResult.worker;const {storage,fs}=setupResult;
 fs.files.set('previous.json',new File(['old'],'previous.json'));
 const job=await worker.dispatch({type:'create',channel:{id:'c',name:'r'}});await storage.append(job.id,[msg('1'),msg('2')]);
 await assert.rejects(worker.dispatch({type:'export',jobId:job.id,formats:['full'],splitMessages:1}),/cancel/i);
 assert.deepEqual([...fs.files.keys()],['previous.json']);assert.equal((await storage.get(job.id)).count,2);storage.close();
});
test('file reads stay at 256 KiB and decode Unicode spanning a chunk boundary',async()=>{
 const prefix=JSON.stringify(msg('1','')).split('"content":"')[0]+'"content":"';
 const line=prefix+'a'.repeat(256*1024-new TextEncoder().encode(prefix).length-1)+'💬"}\n';
 const source=new File([line],'unicode.jsonl');const slices=[];
 const file={name:source.name,size:source.size,slice(start,end){slices.push(end-start);return source.slice(start,end);}};
 const {worker,storage}=await setup();const job=await worker.dispatch({type:'import',file});
 const row=(await storage.readPage(job.id)).messages[0];assert.ok(row.content.endsWith('💬'));assert.ok(!row.content.includes('�'));assert.ok(slices.every(n=>n<=256*1024));storage.close();
});
test('legacy HTML detection rereads the file in bounded slices and stores only fallback records',async()=>{
 const kinds=[];class Legacy {
  constructor(kind){this.kind=kind;kinds.push(kind);}feed(){return JSON.stringify({messages:[]});}
  finish(){return JSON.stringify(this.kind==='html'?{messages:[],legacy_required:true}:{messages:[msg('legacy')]});}free(){}
 }
 const {worker,storage}=await setup({engine:{ArchiveImporter:Legacy}});const file=new File(['<html>legacy</html>'],'legacy.html');
 const job=await worker.dispatch({type:'import',file});assert.deepEqual(kinds,['html','legacy_html']);assert.equal(job.count,1);assert.equal(job.bytes,file.size);assert.ok(job.warnings.length);assert.equal((await storage.list()).length,1);storage.close();
});
test('cancel during import removes staging records and retains a completed archive',async()=>{
 let worker;const {storage,worker:w}=await setup({progress:()=>worker.dispatch({type:'cancel'})});worker=w;
 const kept=await storage.create({channel:{name:'kept'}});await storage.update(kept.id,{status:'ready'});
 await assert.rejects(worker.dispatch({type:'import',file:new File([JSON.stringify(msg('x'))+'\n'],'cancel.jsonl')}),/cancel/i);
 assert.deepEqual((await storage.list()).map(j=>j.id),[kept.id]);storage.close();
});
test('preview caps UTF-8 output at 256 KiB including split multibyte characters',async()=>{
 class Huge extends Exporter{push(){this.n++;return '💬'.repeat(100000);}}
 const {worker,storage}=await setup({engine:{ArchiveExporter:Huge}});const job=await storage.create({channel:{name:'huge'}});await storage.append(job.id,[msg('x')]);
 const result=await worker.dispatch({type:'preview',jobId:job.id,format:'text'});
 assert.ok(new TextEncoder().encode(result.text).length<=256*1024);assert.ok(!result.text.includes('�'));storage.close();
});
test('RPC requests serialize and finish preserves original resume fields and partial export metadata',async()=>{
 let metadata;class Meta extends Exporter{constructor(...args){super(...args);metadata=this.metadata;}}
 const {worker,storage}=await setup({engine:{ArchiveExporter:Meta,normalize_batch:raw=>raw}});
 const job=await worker.dispatch({type:'create',channel:{id:'c',name:'r'},settings:{cap:100}});
 const append=worker.dispatch({type:'append',jobId:job.id,messages:[msg('1')],checkpoint:{cursor:'1',scanned:1}});
 const finish=worker.dispatch({type:'finish',jobId:job.id,status:'paused'});await append;const paused=await finish;
 assert.equal(paused.cursor,'1');assert.deepEqual(paused.settings,{cap:100});
 await worker.dispatch({type:'export',jobId:job.id,formats:['full']});assert.equal(metadata.partial,true);assert.equal(metadata.status,'paused');storage.close();
});
test('export batches small rows into bounded writes instead of awaiting every record',async()=>{
 const {worker,storage,fs}=await setup();const job=await storage.create({channel:{id:'c',name:'r'}});
 await storage.append(job.id,Array.from({length:100},(_,i)=>msg(String(i))));
 const result=await worker.dispatch({type:'export',jobId:job.id,formats:['full']});
 assert.equal(result.count,100);assert.ok(fs.writeCalls<=4,`expected <=4 disk writes, got ${fs.writeCalls}`);storage.close();
});
test('preflight quota failures are visible and preserve the last committed capture',async()=>{
 const {worker,storage,fs}=await setup({estimate:async()=>({usage:100,quota:100})});
 const job=await storage.create({channel:{id:'c',name:'r'}});await storage.append(job.id,[msg('1')],{cursor:'1'});
 await assert.rejects(worker.dispatch({type:'export',jobId:job.id,formats:['full']}),/quota.*Committed capture progress is saved/);
 await assert.rejects(worker.dispatch({type:'import',file:new File(['x'],'bad.json')}),/quota/i);
 assert.equal((await storage.get(job.id)).cursor,'1');assert.equal((await storage.list()).length,1);assert.equal(fs.files.size,0);storage.close();
});
test('HTML exports always split at 10000 selected records even when data splitting is disabled',async()=>{
 const job={id:'large',name:'large',channel:{id:'c',name:'r'},count:10001,bytes:1,status:'ready',settings:{}};
 const source={async get(){return job;},async readPage(id,{after=0,limit=100}){
  const start=after??0,end=Math.min(start+limit,job.count);
  return {messages:Array.from({length:end-start},(_,i)=>msg(String(start+i))),next:end===job.count?null:end};
 }};
 const {worker,storage}=await setup({storage:source});
 const result=await worker.dispatch({type:'export',jobId:job.id,formats:['html'],splitMessages:0});
 assert.deepEqual(result.files.map(f=>f.count),[10000,1]);assert.equal(result.count,10001);storage.close();
});
test('compact formats use JSON names and gzip round-trips through bounded streamed writes',async()=>{
 const {worker,storage,fs}=await setup();const job=await storage.create({channel:{id:'c',name:'r'}});
 await storage.append(job.id,Array.from({length:100},(_,i)=>msg(String(i),'hello💬')));
 const result=await worker.dispatch({type:'export',jobId:job.id,formats:['compact','compact-cleaned'],options:{gzip:true}});
 assert.equal(result.files.length,2);assert.ok(fs.writeCalls<=8);
 for(const output of result.files){assert.ok(output.name.endsWith('.json.gz'));const contents=gunzipSync(new Uint8Array(await output.file.arrayBuffer())).toString();assert.equal(JSON.parse(contents).length,100);assert.equal(JSON.parse(contents)[0],'hello💬');assert.equal(output.bytes,output.file.size);}
 storage.close();
});
test('gzip cancellation aborts compression and removes generated files only',async()=>{
 let worker,created=0;const {storage,fs,worker:w}=await setup({createCompressionStream:kind=>{created++;return new CompressionStream(kind);},progress:()=>worker.dispatch({type:'cancel'})});worker=w;
 fs.files.set('previous.json',new File(['old'],'previous.json'));const job=await storage.create({channel:{id:'c',name:'r'}});await storage.append(job.id,[msg('1')]);
 await assert.rejects(worker.dispatch({type:'export',jobId:job.id,formats:['messages'],options:{gzip:true}}),/cancel/i);
 assert.equal(created,1);assert.deepEqual([...fs.files.keys()],['previous.json']);assert.equal((await storage.get(job.id)).count,1);storage.close();
});
test('gzip reports unavailable compression before creating scratch output',async()=>{
 const {worker,storage,fs}=await setup({createCompressionStream:undefined});const job=await storage.create({channel:{name:'r'}});
 await assert.rejects(worker.dispatch({type:'export',jobId:job.id,formats:['full'],options:{gzip:true}}),/CompressionStream|gzip.*unavailable/i);
 assert.equal(fs.files.size,0);storage.close();
});
test('clearExports deletes only files in the generated scratch directory and preserves archive cache',async()=>{
 const {worker,storage,fs}=await setup();const job=await storage.create({channel:{id:'c',name:'r'}});await storage.append(job.id,[msg('1')]);
 const result=await worker.dispatch({type:'export',jobId:job.id,formats:['messages']});assert.equal(result.files.length,1);
 const cleared=await worker.dispatch({type:'clearExports'});assert.deepEqual(cleared,{cleared:1});assert.equal(fs.files.size,0);
 assert.equal((await storage.get(job.id)).count,1);assert.deepEqual(await worker.dispatch({type:'clearExports'}),{cleared:0});storage.close();
});
test('stale import jobs remain visible but cannot be previewed or exported; init does not pause captures',async()=>{
 const {worker,storage}=await setup();const stale=await storage.create({kind:'import',channel:{name:'stale'}});await storage.append(stale.id,[msg('1')]);
 const active=await storage.create({channel:{name:'active'}});const init=await worker.dispatch({type:'init'});
 assert.ok(init.jobs.some(j=>j.id===stale.id&&j.status==='importing'));assert.equal(init.jobs.find(j=>j.id===active.id).status,'collecting');
 await assert.rejects(worker.dispatch({type:'preview',jobId:stale.id,format:'full'}),/import.*incomplete|import.*finish/i);
 await assert.rejects(worker.dispatch({type:'export',jobId:stale.id,formats:['full']}),/import.*incomplete|import.*finish/i);storage.close();
});
test('import includes original filename in parser source metadata and successful finish clears old error',async()=>{
 let channel;class Source extends Importer{constructor(kind,json){super(kind);channel=JSON.parse(json);}}
 const {worker,storage}=await setup({engine:{ArchiveImporter:Source}});await worker.dispatch({type:'import',file:new File([JSON.stringify(msg('1'))+'\n'],'original.jsonl')});
 assert.equal(channel.source,'original.jsonl');const job=await storage.create({channel:{name:'r'}});await storage.update(job.id,{error:'old',status:'error'});
 const finished=await worker.dispatch({type:'finish',jobId:job.id,status:'ready'});assert.equal(finished.error,null);storage.close();
});
test('gzip imports infer the underlying format, stream bounded source reads, and count compressed input bytes',async()=>{
 const original=JSON.stringify(msg('1','💬'.repeat(100000)))+'\n'+JSON.stringify(msg('2'))+'\n';
 const compressed=gzipSync(original),file=new File([compressed],'source.jsonl.gz');let largest=0,kind;
 class Kind extends Importer{constructor(value,...args){super(value,...args);kind=value;}}
 const source={name:file.name,size:file.size,slice(start,end){largest=Math.max(largest,end-start);return file.slice(start,end);}};
 const {worker,storage}=await setup({engine:{ArchiveImporter:Kind}});const job=await worker.dispatch({type:'import',file:source});
 assert.equal(kind,'jsonl');assert.equal(job.count,2);assert.equal(job.bytes,compressed.byteLength);assert.ok(largest<=256*1024);
 assert.equal((await storage.readPage(job.id)).messages[0].content,'💬'.repeat(100000));storage.close();
});
test('gzip export can be streamed back into the JSON importer',async()=>{
 class Json extends Importer{
  feed(chunk){this.tail+=chunk;return '{"messages":[]}';}
  finish(){return JSON.stringify({messages:JSON.parse(this.tail).map((content,i)=>msg(String(i),content))});}
 }
 const {worker,storage}=await setup({engine:{ArchiveImporter:Json,ArchiveExporter:Exporter}});const job=await storage.create({channel:{id:'c',name:'r'}});
 await storage.append(job.id,[msg('1','first'),msg('2','second')]);const result=await worker.dispatch({type:'export',jobId:job.id,formats:['compact'],options:{gzip:true}});
 const imported=await worker.dispatch({type:'import',file:result.files[0].file});assert.equal(imported.count,2);
 assert.deepEqual((await storage.readPage(imported.id)).messages.map(m=>m.content),['second','first']);storage.close();
});
test('missing decompression support and corrupt gzip never leave a ready staging job',async()=>{
 const missing=await setup({createDecompressionStream:undefined});
 await assert.rejects(missing.worker.dispatch({type:'import',file:new File([gzipSync('x')],'source.json.gz')}),/DecompressionStream|decompression.*unavailable/i);
 assert.equal((await missing.storage.list()).length,0);missing.storage.close();
 const {worker,storage}=await setup();await assert.rejects(worker.dispatch({type:'import',file:new File(['bad gzip'],'bad.json.gz')}));
 assert.equal((await storage.list()).length,0);storage.close();
});
test('canceling decompression removes staging records while retaining existing archives',async()=>{
 let worker;const {storage,worker:w}=await setup({progress:()=>worker.dispatch({type:'cancel'})});worker=w;
 const kept=await storage.create({channel:{name:'kept'}});
 const raw=Array.from({length:200},(_,i)=>JSON.stringify(msg(String(i),'x'.repeat(2000)))).join('\n')+'\n';
 await assert.rejects(worker.dispatch({type:'import',file:new File([gzipSync(raw)],'cancel.jsonl.gz')}),/cancel/i);
 assert.deepEqual((await storage.list()).map(j=>j.id),[kept.id]);storage.close();
});
test('clearExports stays inside its scratch folder and does not recurse into directories',async()=>{
 const fs=disk();fs.files.set('scratch.json',new File(['x'],'scratch.json'));const entries=fs.entries.bind(fs);
 fs.entries=async function*(){yield* entries();yield ['nested',{kind:'directory'}];};
 const opened=[];const root={async getDirectoryHandle(name){opened.push(name);return fs;},async removeEntry(){assert.fail('must not remove root entries');}};
 const {worker,storage}=await setup({getDirectory:async()=>root});
 assert.deepEqual(await worker.dispatch({type:'clearExports'}),{cleared:1});assert.deepEqual(opened,['discord-archive-exports']);storage.close();
});

test('selected-author preview and split export only pass indexed rows to the final exporter filter',async t=>{
 const {worker,storage}=await setup();t.after(()=>storage.close());const job=await storage.create({kind:'import',channel:{id:'c',name:'r'}});
 const rows=Array.from({length:305},(_,i)=>({...msg(String(i),`row-${i}`),author:{id:i%100===0?'selected':'other',display_name:'Same'}}));
 for(let i=0;i<rows.length;i+=100)await storage.append(job.id,rows.slice(i,i+100));
 await storage.update(job.id,{status:'ready'});
 const readPage=storage.readPage.bind(storage),reads=[];
 storage.readPage=async(id,options)=>{const page=await readPage(id,options);reads.push({options,ids:page.messages.map(m=>m.id)});return page;};
 const options={user_key:'id:selected',skip_empty:true};
 const preview=await worker.dispatch({type:'preview',jobId:job.id,format:'messages',options});
 assert.deepEqual(JSON.parse(preview.text),['row-0','row-100','row-200']);
 assert.ok(reads.every(read=>read.options.userKey==='id:selected'));
 assert.deepEqual(reads.flatMap(read=>read.ids),['0','100','200','300']);reads.length=0;
 const result=await worker.dispatch({type:'export',jobId:job.id,formats:['messages'],options,splitMessages:2});
 assert.equal(result.count,4);assert.deepEqual(result.files.map(file=>file.count),[2,2]);
 assert.deepEqual(await Promise.all(result.files.map(async file=>JSON.parse(await file.file.text()))),[['row-0','row-100'],['row-200','row-300']]);
 assert.ok(reads.every(read=>read.options.userKey==='id:selected'));
 assert.deepEqual(reads.flatMap(read=>read.ids),['0','100','200','300']);
});

test('cancel after an indexed page prevents reading the next selected-author page',async t=>{
 const {worker,storage,fs}=await setup();t.after(()=>storage.close());const job=await storage.create({kind:'import'});
 await storage.append(job.id,Array.from({length:110},(_,i)=>msg(String(i))));await storage.update(job.id,{status:'ready'});
 const readPage=storage.readPage.bind(storage);let reads=0;
 storage.readPage=async(id,options)=>{const page=await readPage(id,options);reads++;await worker.dispatch({type:'cancel'});return page;};
 await assert.rejects(worker.dispatch({type:'export',jobId:job.id,formats:['messages'],options:{user_key:'id:u'}}),/cancel/i);
 assert.equal(reads,1);assert.equal(fs.files.size,0);assert.equal((await storage.get(job.id)).count,110);
});

test('preview cancellation during a selected-author page read does not return a stale result',async t=>{
 const {worker,storage}=await setup();t.after(()=>storage.close());const job=await storage.create({channel:{id:'c',name:'r'}});
 await storage.append(job.id,[msg('1')]);const readPage=storage.readPage.bind(storage);
 storage.readPage=async(id,options)=>{const page=await readPage(id,options);await worker.dispatch({type:'cancel'});return page;};
 await assert.rejects(worker.dispatch({type:'preview',jobId:job.id,format:'messages',options:{user_key:'id:u'}}),/cancel/i);
});

test('combine keeps base chronology, adds new stable identities and retains identical ID-less legacy rows',async t=>{
 let metadata;class Meta extends Exporter{constructor(...args){super(...args);metadata=this.metadata;}}
 const {worker,storage}=await setup({engine:{ArchiveExporter:Meta}});t.after(()=>storage.close());
 const base=await storage.create({channel:{id:'c',name:'room'},name:'Base',settings:{cap:20}});
 await storage.append(base.id,[msg('3','base-3'),msg('2','base-2'),msg('1','base-1')]);await storage.update(base.id,{status:'paused'});
 const incoming=await storage.create({kind:'import',name:'More',channel:{id:'c',name:'room'}});
 await storage.append(incoming.id,[msg('3','changed-copy'),msg('4','new'),{...msg('3','other-channel'),channel_id:'d'},msg(null,'same legacy'),msg(null,'same legacy')]);
 await storage.update(incoming.id,{status:'ready'});const before=await storage.list();
 const combined=await worker.dispatch({type:'combine',baseJobId:base.id,additionalJobId:incoming.id});
 assert.notEqual(combined.id,base.id);assert.notEqual(combined.id,incoming.id);assert.equal(combined.status,'ready');assert.equal(combined.count,7);assert.equal(combined.partial,true);
 assert.deepEqual(combined.mergeStats,{originalCount:3,incomingCount:5,added:4,duplicates:1,unidentified:2});
 assert.deepEqual((await storage.readPage(combined.id)).messages.map(m=>m.content),['base-1','base-2','base-3','new','other-channel','same legacy','same legacy']);
 assert.deepEqual(combined.sources.map(source=>[source.name,source.kind,source.status]),[['Base','capture','paused'],['More','import','ready']]);
 assert.ok(combined.warnings.some(warning=>/ID|identit/i.test(warning)));
 assert.deepEqual((await storage.list()).filter(job=>job.id!==combined.id),before);
 await worker.dispatch({type:'preview',jobId:combined.id,format:'full'});assert.equal(metadata.partial,true);assert.deepEqual(metadata.sources,combined.sources);
 await assert.rejects(worker.dispatch({type:'combine',baseJobId:base.id,additionalJobId:base.id}),/same|itself/i);
});

test('combine streams pages of 100 and preserves import source order rather than sorting guessed timestamps',async t=>{
 const {worker,storage}=await setup();t.after(()=>storage.close());const base=await storage.create({kind:'import',name:'Original'}),incoming=await storage.create({kind:'import',name:'Extra'});
 for(let i=0;i<205;i+=100)await storage.append(base.id,Array.from({length:Math.min(100,205-i)},(_,j)=>msg(String(i+j),`base-${i+j}`)));
 await storage.append(incoming.id,[msg('300','extra-last'),msg('206','extra-first')]);
 await storage.update(base.id,{status:'ready'});await storage.update(incoming.id,{status:'ready'});
 const readPage=storage.readPage.bind(storage),sizes=[];storage.readPage=async(id,options)=>{assert.equal(options.limit,100);const page=await readPage(id,options);sizes.push(page.messages.length);return page;};
 const combined=await worker.dispatch({type:'combine',baseJobId:base.id,additionalJobId:incoming.id});
 assert.deepEqual(sizes,[100,100,5,2]);assert.equal(combined.partial,false);assert.equal(combined.count,207);
 assert.deepEqual((await readPage(combined.id,{after:200})).messages.map(m=>m.content),['base-200','base-201','base-202','base-203','base-204','extra-last','extra-first']);
});

test('merge imports a file into a temporary source then removes temporary jobs while preserving the base',async t=>{
 const {worker,storage}=await setup();t.after(()=>storage.close());const base=await storage.create({kind:'import',name:'Base',channel:{id:'c',name:'r'}});
 await storage.append(base.id,[msg('1','kept')]);await storage.update(base.id,{status:'ready'});const original=await storage.get(base.id);
 const file=new File([JSON.stringify(msg('1','duplicate'))+'\n'+JSON.stringify(msg('2','added'))+'\n'+JSON.stringify(msg('2','repeated in file'))+'\n'],'more.jsonl');
 const combined=await worker.dispatch({type:'merge',baseJobId:base.id,file});
 assert.equal(combined.count,2);assert.equal(combined.mergeStats.added,1);assert.equal(combined.mergeStats.duplicates,2);assert.equal(combined.mergeStats.incomingCount,3);
 assert.deepEqual((await storage.readPage(combined.id)).messages.map(m=>m.content),['kept','added']);
 assert.deepEqual((await storage.list()).map(job=>job.id).sort(),[base.id,combined.id].sort());assert.deepEqual(await storage.get(base.id),original);
 assert.equal(combined.sources[1].name,'more.jsonl');
 await assert.rejects(worker.dispatch({type:'merge',baseJobId:base.id,file:new File(['broken'],'invalid.jsonl')}),/truncated/i);
 assert.deepEqual((await storage.list()).map(job=>job.id).sort(),[base.id,combined.id].sort());assert.deepEqual(await storage.get(base.id),original);
});

test('canceled combine removes its staging job and never changes either source',async t=>{
 let worker;const setupResult=await setup({progress:progress=>{if(progress.operation==='combine')worker.dispatch({type:'cancel'});}});worker=setupResult.worker;
 const {storage}=setupResult;t.after(()=>storage.close());const base=await storage.create({channel:{id:'c',name:'r'}}),incoming=await storage.create({channel:{id:'c',name:'r'}});
 await storage.append(base.id,[msg('1')]);await storage.append(incoming.id,[msg('2')]);const before=await storage.list();
 await assert.rejects(worker.dispatch({type:'combine',baseJobId:base.id,additionalJobId:incoming.id}),/cancel/i);assert.deepEqual(await storage.list(),before);
});

test('cancellation during file merge removes imported temporary source and combined stage',async t=>{
 let worker;const setupResult=await setup({progress:progress=>{if(progress.operation==='combine')worker.dispatch({type:'cancel'});}});worker=setupResult.worker;
 const {storage}=setupResult;t.after(()=>storage.close());const base=await storage.create({channel:{id:'c',name:'r'}});await storage.append(base.id,[msg('1')]);const before=await storage.list();
 await assert.rejects(worker.dispatch({type:'merge',baseJobId:base.id,file:new File([JSON.stringify(msg('2'))+'\n'],'extra.jsonl')}),/cancel/i);
 assert.deepEqual(await storage.list(),before);
});

test('incomplete import sources cannot be combined or used for a file merge',async t=>{
 const {worker,storage}=await setup();t.after(()=>storage.close());const base=await storage.create({kind:'import'}),incoming=await storage.create({channel:{name:'ready'}});
 const before=await storage.list();await assert.rejects(worker.dispatch({type:'combine',baseJobId:base.id,additionalJobId:incoming.id}),/incomplete/i);
 await assert.rejects(worker.dispatch({type:'merge',baseJobId:base.id,file:new File(['broken'],'extra.json')}),/incomplete/i);assert.deepEqual(await storage.list(),before);
});

test('updateInfo RPC returns the requested channel anchor and does not deserialize source records',async t=>{
 const {worker,storage}=await setup();t.after(()=>storage.close());const job=await storage.create({channel:{id:'c',name:'r'}});
 await storage.append(job.id,[msg('2'),msg('10'),{...msg('999'),channel_id:'d'}]);storage.readPage=()=>{throw Error('body read forbidden');};
 const info=await worker.dispatch({type:'updateInfo',jobId:job.id,channelId:'c'});assert.equal(info.newestId,'10');assert.equal(info.hasMissingIds,false);
});

test('combine never borrows the base channel for incoming records with unknown channel identity',async t=>{
 const {worker,storage}=await setup();t.after(()=>storage.close());const base=await storage.create({kind:'import',channel:{id:'c',name:'r'}}),incoming=await storage.create({kind:'import'});
 await storage.append(base.id,[msg('1','known')]);await storage.append(incoming.id,[{...msg('1','unknown'),channel_id:null},{...msg('1','unknown'),channel_id:null}]);
 await storage.update(base.id,{status:'ready'});await storage.update(incoming.id,{status:'ready'});
 const combined=await worker.dispatch({type:'combine',baseJobId:base.id,additionalJobId:incoming.id});
 assert.equal(combined.count,3);assert.equal(combined.channel.id,null);assert.equal(combined.mergeStats.unidentified,2);assert.equal(combined.mergeStats.duplicates,0);
 assert.deepEqual((await storage.readPage(combined.id)).messages.map(m=>m.channel_id),['c',null,null]);
});

test('late cancellation after the ready staging commit still removes the combined result',async t=>{
 const {worker,storage}=await setup();t.after(()=>storage.close());const base=await storage.create({channel:{id:'c',name:'r'}}),incoming=await storage.create({channel:{id:'c',name:'r'}});
 await storage.append(base.id,[msg('1')]);await storage.append(incoming.id,[msg('2')]);const before=await storage.list(),update=storage.update.bind(storage);
 storage.update=async(id,changes)=>{const value=await update(id,changes);if(changes.mergeStats)await worker.dispatch({type:'cancel'});return value;};
 await assert.rejects(worker.dispatch({type:'combine',baseJobId:base.id,additionalJobId:incoming.id}),/cancel/i);assert.deepEqual(await storage.list(),before);
});

test('append failure during combine removes partial output and preserves committed originals',async t=>{
 const {worker,storage}=await setup();t.after(()=>storage.close());const base=await storage.create({channel:{id:'c',name:'r'}}),incoming=await storage.create({channel:{id:'c',name:'r'}});
 await storage.append(base.id,[msg('1')]);await storage.append(incoming.id,[msg('2')]);const before=await storage.list(),append=storage.append.bind(storage);let calls=0;
 storage.append=async(...args)=>{if(++calls===2)throw Error('disk write failed');return append(...args);};
 await assert.rejects(worker.dispatch({type:'combine',baseJobId:base.id,additionalJobId:incoming.id}),/disk write failed/i);assert.deepEqual(await storage.list(),before);
});

test('merge cancellation at temporary-file cleanup removes the newly combined result too',async t=>{
 const {worker,storage}=await setup();t.after(()=>storage.close());const base=await storage.create({channel:{id:'c',name:'r'}});await storage.append(base.id,[msg('1')]);const before=await storage.list();
 const remove=storage.delete.bind(storage);let first=true;
 storage.delete=async id=>{const value=await remove(id);if(first){first=false;await worker.dispatch({type:'cancel'});}return value;};
 await assert.rejects(worker.dispatch({type:'merge',baseJobId:base.id,file:new File([JSON.stringify(msg('2'))+'\n'],'extra.jsonl')}),/cancel/i);assert.deepEqual(await storage.list(),before);
});

test('actual WASM file merge preserves partial source history for full JSON, compact JSON and structured HTML',async t=>{
 const engine=await import('../wasm/archive_engine.js');await engine.default({module_or_path:await readFile(new URL('../wasm/archive_engine_bg.wasm',import.meta.url))});
 const {worker,storage}=await setup({engine});t.after(()=>storage.close());
 const source=await worker.dispatch({type:'create',channel:{id:'c',name:'Original'},settings:{}});
 await worker.dispatch({type:'append',jobId:source.id,messages:[msg('2'),msg('1')]});await worker.dispatch({type:'finish',jobId:source.id,status:'paused'});
 const output=await worker.dispatch({type:'export',jobId:source.id,formats:['full','compact','html'],options:{include_machine_data:true}});
 const base=await worker.dispatch({type:'create',channel:{id:'c',name:'Destination'},settings:{}});
 await worker.dispatch({type:'append',jobId:base.id,messages:[msg('0')]});await worker.dispatch({type:'finish',jobId:base.id,status:'ready'});
 for(const file of output.files){
  const combined=await worker.dispatch({type:'merge',baseJobId:base.id,file:file.file});
  assert.equal(combined.count,3);assert.equal(combined.partial,true);assert.equal(combined.status,'ready');
  assert.ok(combined.sources.some(source=>source.status==='paused'));
  const full=await worker.dispatch({type:'export',jobId:combined.id,formats:['full']});const json=JSON.parse(await full.files[0].file.text());
  assert.equal(json.partial,true);assert.ok(json.sources.some(source=>source.status==='paused'));assert.equal(json.message_count,3);
 }
});

test('actual WASM converts original legacy HTML and retains ID-less rows when updated from the same file',async t=>{
 const engine=await import('../wasm/archive_engine.js');await engine.default({module_or_path:await readFile(new URL('../wasm/archive_engine_bg.wasm',import.meta.url))});
 const {worker,storage}=await setup({engine});t.after(()=>storage.close());
 const file=new File(["<html><body><div class='chatlog'><div class='chatlog__message-container'><div><img class='chatlog__avatar' src='https://cdn.discordapp.com/avatars/42/x.png'></div><div><span class='chatlog__author'>Display</span><span class='chatlog__timestamp'>10:00</span>Hello</div></div><div class='chatlog__message-container'><div>10:01</div><div>Second</div></div></div></body></html>"],'original.html');
 const base=await worker.dispatch({type:'import',file});assert.equal(base.count,2);
 const info=await worker.dispatch({type:'updateInfo',jobId:base.id,channelId:'c'});assert.equal(info.newestId,null);assert.equal(info.hasMissingIds,true);
 const combined=await worker.dispatch({type:'merge',baseJobId:base.id,file});assert.equal(combined.count,4);assert.equal(combined.mergeStats.unidentified,4);assert.equal(combined.mergeStats.duplicates,0);
 assert.ok((await storage.readPage(combined.id)).messages.every(message=>message.id===null));
 const output=await worker.dispatch({type:'export',jobId:combined.id,formats:['compact']});
 const reimported=await worker.dispatch({type:'import',file:output.files[0].file});assert.equal(reimported.count,4);
 assert.ok((await storage.readPage(reimported.id)).messages.every(message=>message.id===null));
});

test('finish records collection reason and a reached cap keeps ready archives partial through combine',async t=>{
 let metadata;class Meta extends Exporter{constructor(...args){super(...args);metadata=this.metadata;}}
 const {worker,storage}=await setup({engine:{ArchiveExporter:Meta}});t.after(()=>storage.close());
 const base=await storage.create({channel:{id:'c',name:'r'}}),incoming=await storage.create({channel:{id:'c',name:'r'}});
 await storage.append(base.id,[msg('1')]);await storage.append(incoming.id,[msg('2')]);
 await worker.dispatch({type:'finish',jobId:base.id,status:'ready',partial:false,reason:'end'});
 const limited=await worker.dispatch({type:'finish',jobId:incoming.id,status:'ready',reason:'limit',partial:false});
 assert.equal(limited.collectionReason,'limit');assert.equal(limited.partial,true);
 const combined=await worker.dispatch({type:'combine',baseJobId:base.id,additionalJobId:incoming.id});assert.equal(combined.partial,true);
 await worker.dispatch({type:'preview',jobId:combined.id,format:'full'});assert.equal(metadata.partial,true);
 const explicit=await worker.dispatch({type:'finish',jobId:base.id,status:'ready',reason:'end',partial:true});assert.equal(explicit.partial,true);assert.equal(explicit.collectionReason,'end');
});

test('combine rejects deleted or appended sources during paged copy and removes only its stage',async t=>{
 for(const mutation of ['delete','append']){
  const {worker,storage}=await setup();t.after(()=>storage.close());
  const base=await storage.create({kind:'import',name:'Base'}),incoming=await storage.create({kind:'import',name:'Incoming'});
  await storage.append(base.id,Array.from({length:101},(_,i)=>msg(String(i))));
  await storage.append(incoming.id,[msg('200')]);
  await storage.update(base.id,{status:'ready'});await storage.update(incoming.id,{status:'ready'});
  const originalRead=storage.readPage.bind(storage);let changed=false;
  storage.readPage=async(id,options)=>{
   const page=await originalRead(id,options);
   if(id===base.id&&!changed){changed=true;if(mutation==='delete')await storage.delete(base.id);else await storage.append(base.id,[msg('201')]);}
   return page;
  };
  await assert.rejects(worker.dispatch({type:'combine',baseJobId:base.id,additionalJobId:incoming.id}),/source.*changed|source.*removed/i);
  const jobs=await storage.list();assert.equal(jobs.length,mutation==='delete'?1:2);
  assert.equal((await storage.get(incoming.id)).count,1);
  if(mutation==='append')assert.equal((await storage.get(base.id)).count,102);
 }
});

test('combine rechecks already-copied source metadata before completing',async t=>{
 const {worker,storage}=await setup();t.after(()=>storage.close());
 const base=await storage.create({kind:'import',name:'Base'}),incoming=await storage.create({kind:'import',name:'Incoming'});
 await storage.append(base.id,[msg('1')]);await storage.append(incoming.id,[msg('2')]);
 await storage.update(base.id,{status:'ready'});await storage.update(incoming.id,{status:'ready'});
 const originalRead=storage.readPage.bind(storage);
 storage.readPage=async(id,options)=>{const page=await originalRead(id,options);if(id===incoming.id)await storage.update(base.id,{status:'paused'});return page;};
 await assert.rejects(worker.dispatch({type:'combine',baseJobId:base.id,additionalJobId:incoming.id}),/source.*changed/i);
 assert.equal((await storage.list()).length,2);assert.equal((await storage.get(base.id)).status,'paused');
});
