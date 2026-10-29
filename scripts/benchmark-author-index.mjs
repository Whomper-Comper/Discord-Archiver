// Scoped real-browser storage benchmark. No WASM, worker export or Discord API.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';

const root=resolve(import.meta.dirname,'..');
const records=Number(process.env.AUTHOR_BENCHMARK_RECORDS||10000);
if(!Number.isSafeInteger(records)||records<100||records>100000)throw new Error('AUTHOR_BENCHMARK_RECORDS must be an integer from 100 to 100000.');
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/storage.js'){res.setHeader('Content-Type','application/javascript');res.end(await readFile(join(root,'storage.js')));}
  else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Author index benchmark</title>');}
  else{res.statusCode=404;res.end();}
 }catch{res.statusCode=500;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.TEST_BROWSER?{executablePath:process.env.TEST_BROWSER}:{})});
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
 const result=await page.evaluate(async records=>{
  const {ArchiveStorage,userKey}=await import('/storage.js');
  const request=value=>new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
  const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  const name=`author-benchmark-${crypto.randomUUID()}`,jobId='source',selectedKey='id:selected';
  const opening=indexedDB.open(name,1);
  opening.onupgradeneeded=()=>{
   const db=opening.result;db.createObjectStore('jobs',{keyPath:'id'});
   const messages=db.createObjectStore('messages',{keyPath:['jobId','order']});
   messages.createIndex('identity',['jobId','identity'],{unique:true});
   db.createObjectStore('users',{keyPath:['jobId','key']});
  };
  const old=await request(opening);
  const tx=old.transaction('jobs','readwrite'),committed=done(tx);
  tx.objectStore('jobs').add({id:jobId,kind:'import',count:records,channel:{id:'c'},status:'ready'});await committed;
  let normalizedMessageBytes=0;
  for(let start=0;start<records;start+=100){
   const tx=old.transaction('messages','readwrite'),committed=done(tx),store=tx.objectStore('messages');
   for(let i=start;i<Math.min(start+100,records);i++){
    const message={id:String(i),channel_id:'c',author:{id:i%100===0?'selected':'other',display_name:'Author',username:'author'},content:'x'.repeat(1024)};
    normalizedMessageBytes+=new TextEncoder().encode(JSON.stringify(message)).length;
    store.add({jobId,order:i+1,identity:JSON.stringify(['c',String(i)]),message});
   }
   await committed;
  }
  // Count actual non-empty cursor results, including each page's lookahead row.
  let cursorRows=0;
  const originals=[IDBObjectStore.prototype.openCursor,IDBIndex.prototype.openCursor];
  for(const [prototype,original] of [[IDBObjectStore.prototype,originals[0]],[IDBIndex.prototype,originals[1]]])
   prototype.openCursor=function(...args){const value=original.apply(this,args);value.addEventListener('success',()=>{if(value.result)cursorRows++;});return value;};
  async function measure(storage,indexed){
   cursorRows=0;let after=null,pages=0,rowsReturned=0,selected=0,fingerprint=0,maxPageRecords=0;
   const started=performance.now();
   do{
    const page=await storage.readPage(jobId,{after,limit:100,...(indexed?{userKey:selectedKey}:{})});
    after=page.next;pages++;rowsReturned+=page.messages.length;maxPageRecords=Math.max(maxPageRecords,page.messages.length);
    for(const message of page.messages)if(userKey(message.author)===selectedKey){selected++;fingerprint=(Math.imul(fingerprint,31)+Number(message.id)+1)>>>0;}
   }while(after!==null);
   return {milliseconds:Number((performance.now()-started).toFixed(2)),pages,rowsReturned,cursorRows,selected,fingerprint,maxPageRecords};
  }
  let storage=new ArchiveStorage(old,IDBKeyRange);
  const beforeUpgradeScan=await measure(storage,false);storage.close();
  const started=performance.now();storage=await ArchiveStorage.open({name});
  const migrationMilliseconds=Number((performance.now()-started).toFixed(2));
  const comparisons=[];
  for(let run=0;run<3;run++){
   let scan,indexed;
   if(run%2){indexed=await measure(storage,true);scan=await measure(storage,false);}
   else{scan=await measure(storage,false);indexed=await measure(storage,true);}
   comparisons.push({scan,indexed});
  }
  storage.close();await request(indexedDB.deleteDatabase(name));
  IDBObjectStore.prototype.openCursor=originals[0];IDBIndex.prototype.openCursor=originals[1];
  return {records,normalizedMessageBytes,selectedEvery:100,selectedKey,beforeUpgradeScan,migrationMilliseconds,comparisons};
 },records);
 for(const {scan,indexed} of result.comparisons){
  assert.equal(scan.selected,indexed.selected);assert.equal(scan.fingerprint,indexed.fingerprint);
  assert.equal(indexed.selected,Math.ceil(records/100));assert.ok(indexed.maxPageRecords<=100);
  assert.ok(indexed.cursorRows<scan.cursorRows);
 }
 const median=values=>values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)];
 const report={date:new Date().toISOString(),scope:'Production ArchiveStorage with real IndexedDB in local headless Chromium/Edge, 1 KiB synthetic message contents and 1% selected author. One v1-to-v2 upgrade, then three alternating full-scan/indexed reads of the same v2 database. Storage-only: excludes WASM, OPFS, worker, live Discord and whole-pipeline memory. Timings depend on browser, disk and cache.',browser:browser.version(),...result,
  medianScanMilliseconds:median(result.comparisons.map(run=>run.scan.milliseconds)),medianIndexedMilliseconds:median(result.comparisons.map(run=>run.indexed.milliseconds)),
  cursorRowReductionPercent:Number((100*(1-result.comparisons[0].indexed.cursorRows/result.comparisons[0].scan.cursorRows)).toFixed(2)),
  bounds:'readPage returns at most 100 records plus one cursor lookahead; v1 upgrade updates one row at a time inside one atomic versionchange transaction. The browser controls transaction/index memory and disk use. Large v1 caches may take time to upgrade before initialization completes.'};
 await writeFile(join(root,'docs','performance-author-index.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
