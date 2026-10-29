// Real production worker + Rust/WASM + IndexedDB + OPFS benchmark. No whole-file read.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {createWriteStream} from 'node:fs';
import {readFile,writeFile,mkdir,stat,unlink} from 'node:fs/promises';
import {once} from 'node:events';
import {resolve,join,extname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';

const root=resolve(import.meta.dirname,'..'),artifacts=join(root,'artifacts','benchmark');
await mkdir(artifacts,{recursive:true});
const target=Number(process.env.BENCHMARK_MB||500)*1000000;
if(!Number.isFinite(target)||target<=0)throw new Error('BENCHMARK_MB must be positive.');
const filename=join(artifacts,'synthetic.jsonl');
const stream=createWriteStream(filename);let rows=0,inputBytes=0;
const content='Benchmark 😀 中文 newline\nquoted "text" '.padEnd(8192,'x');
while(inputBytes<target){
    const line=JSON.stringify({id:String(1000000000+rows),channel_id:'20',author:{id:rows%2?'101':'102',username:rows%2?'alice':'bob',global_name:rows%2?'Alice':'Bob'},timestamp:'2026-10-28T12:00:00Z',content,attachments:[],embeds:[]})+'\n';
    inputBytes+=Buffer.byteLength(line);rows++;if(!stream.write(line))await once(stream,'drain');
}
stream.end();await once(stream,'finish');
console.log(JSON.stringify({phase:'generated',inputBytes,records:rows}));
await writeFile(join(artifacts,'worker.js'),`import init,* as engine from '../../wasm/archive_engine.js';
import {createArchiveWorker} from '../../archive-worker.js';
const instance=await init();let peak=instance.memory.buffer.byteLength;
const worker=createArchiveWorker({engine,progress:p=>{peak=Math.max(peak,instance.memory.buffer.byteLength);postMessage({...p,wasmMemoryBytes:instance.memory.buffer.byteLength});}});
onmessage=async({data})=>{try{const result=await worker.dispatch(data);peak=Math.max(peak,instance.memory.buffer.byteLength);postMessage({id:data.id,result,wasmMemoryPeak:peak});}catch(error){postMessage({id:data.id,error:String(error.message||error)});}};`);
const server=createServer(async(req,res)=>{
    try{
        const route=new URL(req.url,'http://localhost').pathname;
        if(route==='/benchmark.html'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Archive benchmark</title><input type="file" id="file">');return;}
        const path=resolve(root,'.'+route);if(!path.startsWith(root+'\\')&&!path.startsWith(root+'/'))throw new Error('path');
        res.setHeader('Content-Type',({'.js':'application/javascript','.wasm':'application/wasm'}[extname(path)]||'application/octet-stream'));
        res.setHeader('Content-Security-Policy',"script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
        res.end(await readFile(path));
    }catch{res.statusCode=404;res.end('Not found');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const context=await chromium.launchPersistentContext(join(artifacts,'profile'),{headless:true,...(process.env.TEST_BROWSER?{executablePath:process.env.TEST_BROWSER}:{})});
const browser=context.browser();const page=await context.newPage();let lastProgress=0,peakWorkingSet=0,peakWasm=0,sampling=false;
const session=await browser.newBrowserCDPSession();const command=promisify(execFile);
const sample=async()=>{
    if(sampling||process.platform!=='win32')return;sampling=true;
    try{
        const {processInfo}=await session.send('SystemInfo.getProcessInfo');
        const ids=processInfo.map(p=>Number(p.id)).filter(id=>Number.isSafeInteger(id)&&id>0);
        if(ids.length){const {stdout}=await command('powershell.exe',['-NoProfile','-Command',`Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum | ForEach-Object Sum`],{windowsHide:true});peakWorkingSet=Math.max(peakWorkingSet,Number(stdout.trim())||0);}
    }catch{}finally{sampling=false;}
};
await page.exposeFunction('benchmarkProgress',data=>{
    peakWasm=Math.max(peakWasm,data.wasmMemoryBytes||0);
    if(Date.now()-lastProgress>5000){lastProgress=Date.now();console.log(JSON.stringify({phase:data.operation,bytes:data.bytes,count:data.count,wasmMemoryBytes:data.wasmMemoryBytes}));}
});
const timer=setInterval(sample,5000);
try{
    await page.goto(`http://127.0.0.1:${server.address().port}/benchmark.html`);
    await page.locator('#file').setInputFiles(filename);
    await page.evaluate(()=>{
        window.benchmarkWorker=new Worker('/artifacts/benchmark/worker.js',{type:'module'});let next=0;const pending=new Map();
        window.call=(type,fields={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});benchmarkWorker.postMessage({id,type,...fields});});
        benchmarkWorker.onmessage=({data})=>{if(data.type==='progress'){window.benchmarkProgress(data);return;}window.wasmPeak=data.wasmMemoryPeak;const item=pending.get(data.id);pending.delete(data.id);if(item)data.error?item.reject(new Error(data.error)):item.resolve(data.result);};
    });
    await sample();
    const result=await page.evaluate(async()=>{
        const previous=await call('init');for(const job of previous.jobs)await call('delete',{jobId:job.id});await call('clearExports');
        const t0=performance.now();window.job=await call('import',{file:document.querySelector('#file').files[0],kind:'jsonl'});const t1=performance.now();
        const output=await call('export',{jobId:job.id,formats:['compact'],options:{include_media:false},splitMessages:0,filename:'benchmark'});const t2=performance.now();
        const file=output.files[0].file;let count=0,first,last;const decoder=new TextDecoder('utf-8',{fatal:true});
        const engine=await import('/wasm/archive_engine.js');await engine.default();const parser=new engine.ArchiveImporter('json',JSON.stringify(job.channel));
        const accept=text=>{const values=JSON.parse(text).messages;for(const value of values){count++;if(!first)first=value;last=value;}};
        try{
            for await(const chunk of file.stream()){
                for(let offset=0;offset<chunk.byteLength;offset+=256*1024)accept(parser.feed(decoder.decode(chunk.subarray(offset,offset+256*1024),{stream:true})));
            }
            const tail=decoder.decode();if(tail)accept(parser.feed(tail));accept(parser.finish());
        }finally{parser.free();}
        const t3=performance.now();const wasmMemoryPeak=window.wasmPeak;
        // Remove only benchmark-owned cache and temporary output after validation.
        await call('delete',{jobId:job.id});
        const directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('discord-archive-exports');for(const item of output.files)await directory.removeEntry(item.name);
        return {format:'compact',savedRecords:job.count,validatedRecords:count,firstId:first.id,lastId:last.id,outputBytes:file.size,importSeconds:(t1-t0)/1000,exportSeconds:(t2-t1)/1000,validationSeconds:(t3-t2)/1000,wasmMemoryPeak};
    });
    await sample();peakWasm=Math.max(peakWasm,result.wasmMemoryPeak||0);
    assert.equal(result.savedRecords,rows);assert.equal(result.validatedRecords,rows);
    assert.equal(result.firstId,'1000000000');assert.equal(result.lastId,String(1000000000+rows-1));
    assert.ok(peakWasm<128*1048576,'WASM memory should remain bounded below128MiB for this fixture');
    const report={date:'2026-10-29',scope:'Production worker and WASM on secure localhost in Chromium, real IndexedDB and OPFS. Synthetic JSONL. Not a live Discord or Firefox benchmark.',inputBytes,records:rows,...result,wasmMemoryPeak:peakWasm,sampledBrowserWorkingSetPeakBytes:peakWorkingSet,workingSetNote:'Sum of sampled Windows browser process working sets; shared pages may be counted more than once.'};
    await writeFile(join(root,'docs','benchmark-500mb.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({phase:'passed',...report}));
}finally{
    clearInterval(timer);await context.close();await new Promise(resolve=>server.close(resolve));
    if(!process.env.KEEP_BENCHMARK_INPUT)await unlink(filename).catch(()=>{});
}
