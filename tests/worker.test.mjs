import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { ArchiveStorage } from '../storage.js';
import { createArchiveWorker } from '../archive-worker.js';
import { gunzipSync, gzipSync } from 'node:zlib';

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
