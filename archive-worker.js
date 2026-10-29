import { ArchiveStorage } from './storage.js';

const CHUNK_BYTES = 256 * 1024;
const FORMATS = new Set(['full','cleaned','compact','compact-cleaned','messages','jsonl','cleaned-jsonl','csv','text','html']);
const EXPORT_DIRECTORY = 'discord-archive-exports';
const extension = format => ({full:'json',cleaned:'json',compact:'json','compact-cleaned':'json',messages:'json','cleaned-jsonl':'jsonl',text:'txt'}[format] || format);
const safeName = name => String(name || 'archive').replace(/[^\p{L}\p{N}._-]+/gu,'-').replace(/^\.+|\.+$/g,'').slice(0,100) || 'archive';
const errorText = error => error?.name === 'QuotaExceededError'
  ? 'Browser disk quota exceeded. Committed capture progress is saved. Delete unused cached archives or free disk space and try again.'
  : String(error?.message || error);

/** Dependency injection lets tests exercise the real disk orchestration without WASM/browser globals. */
export function createArchiveWorker(dependencies = {}) {
  let storage = dependencies.storage, engine = dependencies.engine, initializing;
  let queue = Promise.resolve(), cancellation = 0;
  let lastProgressKey='',lastProgressAt=0;
  const progress = dependencies.progress || (() => {});
  const estimate = dependencies.estimate || (() => globalThis.navigator?.storage?.estimate?.() || {});
  const getDirectory = Object.hasOwn(dependencies,'getDirectory') ? dependencies.getDirectory : globalThis.navigator?.storage?.getDirectory?.bind(globalThis.navigator.storage);
  const createCompressionStream = Object.hasOwn(dependencies,'createCompressionStream') ? dependencies.createCompressionStream
    : typeof globalThis.CompressionStream === 'function' ? format => new globalThis.CompressionStream(format) : undefined;
  const createDecompressionStream = Object.hasOwn(dependencies,'createDecompressionStream') ? dependencies.createDecompressionStream
    : typeof globalThis.DecompressionStream === 'function' ? format => new globalThis.DecompressionStream(format) : undefined;
  const ensure = async () => {
    if (!initializing) initializing = (async () => {
      storage ||= await ArchiveStorage.open();
      if (!engine) { engine = await import('./wasm/archive_engine.js'); await engine.default(); }
    })();
    await initializing;
  };
  const check = token => { if (token !== cancellation) throw new Error('Operation cancelled'); };
  const preflight = async expected => {
    const {usage,quota} = await estimate();
    if(Number.isFinite(usage)&&Number.isFinite(quota)&&quota-usage<Math.min(expected || 1,CHUNK_BYTES))
      throw new DOMException('Insufficient browser disk quota','QuotaExceededError');
  };
  const jobFor = async id => {const job=await storage.get(id);if(!job)throw new Error('Archive job was not found');return job;};
  const exportableJob = async id => {
    const job=await jobFor(id);
    if(job.status==='importing')throw new Error('This import is incomplete. Delete it and import the original file again before previewing or exporting.');
    return job;
  };
  const emit = (operation,job,bytes,totalBytes,force=false) => {
    const key=`${operation}:${job.id}`,now=Date.now();
    if(!force&&key===lastProgressKey&&now-lastProgressAt<200)return;
    lastProgressKey=key;lastProgressAt=now;
    progress({type:'progress',operation,jobId:job.id,count:job.count,bytes:bytes ?? job.bytes,totalBytes,status:job.status});
  };
  const metadataFor = job => ({schema_version:1,channel:job.channel,source:{kind:job.kind,name:job.name},sources:[{kind:job.kind,name:job.name}],status:job.status,partial:job.status !== 'ready',settings:job.settings,warnings:job.warnings || [],message_count:job.count});
  const exporterFor = (format, options, job) => {
    if (!FORMATS.has(format)) throw new Error(`Unsupported export format: ${format}`);
    return new engine.ArchiveExporter(format,JSON.stringify(options || {}),JSON.stringify(metadataFor(job)));
  };

  async function importFile({file,kind}, token) {
    if (!file || typeof file.slice !== 'function') throw new Error('Choose an archive file to import');
    await preflight(file.size);
    const gzip=/\.gz$/i.test(file.name),underlyingName=gzip?file.name.slice(0,-3):file.name;
    if(gzip&&!createDecompressionStream)throw new Error('Gzip decompression is unavailable: this browser does not support DecompressionStream. Decompress the file before importing it.');
    kind ||= /\.(jsonl|ndjson)$/i.test(underlyingName) ? 'jsonl' : /\.html?$/i.test(underlyingName) ? 'html' : 'json';
    if (!['json','jsonl','html'].includes(kind)) throw new Error('Unsupported import format');
    let job = await storage.create({kind:'import',name:file.name,channel:{id:null,name:file.name},settings:{}});
    const warnings = new Set();
    async function pass(parserKind) {
      const importer = new engine.ArchiveImporter(parserKind,JSON.stringify({...job.channel,source:file.name}));
      let bytes=0,reader;
      const save = async text => {
        const result = JSON.parse(text);
        for (const warning of result.warnings || []) if(warnings.size<100)warnings.add(String(warning));
        if(result.channel)job=await storage.update(job.id,{channel:{id:result.channel.id ?? null,name:result.channel.name || job.channel.name}});
        const records=result.messages || [];
        for(let i=0;i<records.length;i+=100){check(token);job=await storage.append(job.id,records.slice(i,i+100),{bytes,scanned:job.scanned+Math.min(100,records.length-i)});}
        return result;
      };
      try {
        const decoder = new TextDecoder('utf-8',{fatal:true});
        let stopped=false;
        let stream=new ReadableStream({
          async pull(controller){
            check(token);
            if(bytes>=file.size){controller.close();return;}
            const chunk=await file.slice(bytes,bytes+CHUNK_BYTES).arrayBuffer();
            if(stopped)return;
            check(token);bytes+=chunk.byteLength;controller.enqueue(new Uint8Array(chunk));
          },
          cancel(){stopped=true;}
        });
        if(gzip)stream=stream.pipeThrough(createDecompressionStream('gzip'));
        reader=stream.getReader();
        while(true){
          check(token);const {value,done}=await reader.read();if(done)break;
          for(let offset=0;offset<value.byteLength;offset+=CHUNK_BYTES){
            check(token);await save(importer.feed(decoder.decode(value.subarray(offset,offset+CHUNK_BYTES),{stream:true})));emit('import',job,bytes,file.size);
          }
        }
        const tail=decoder.decode();if(tail)await save(importer.feed(tail));
        check(token);const result=await save(importer.finish());
        job=await storage.update(job.id,{bytes:file.size});return result;
      } finally {await reader?.cancel().catch(()=>{});importer.free?.();}
    }
    try {
      const first=await pass(kind);
      if(first.legacy_required){
        await storage.delete(job.id);
        job=await storage.create({kind:'import',name:file.name,channel:{id:null,name:file.name},settings:{}});
        warnings.add('Legacy HTML has limited author IDs and reply information.');
        await pass('legacy_html');
      }
      check(token);job=await storage.update(job.id,{status:'ready',warnings:[...warnings],bytes:file.size});check(token);emit('import',job,file.size,file.size,true);return job;
    } catch(error) {await storage.delete(job.id);throw error;}
  }

  async function preview({jobId,format,options}, token) {
    const job=await exportableJob(jobId), exporter=exporterFor(format,options,job);
    const encoder=new TextEncoder();let text='',bytes=0,after=null;
    const add = chunk => {
      const encoded=encoder.encode(chunk);const available=CHUNK_BYTES-bytes;
      if(available>0){text+=encoded.length<=available?chunk:new TextDecoder().decode(encoded.subarray(0,available),{stream:true});bytes+=Math.min(available,encoded.length);}
    };
    try {
      add(exporter.begin());
      outer: do {
        check(token);const page=await storage.readPage(jobId,{after,limit:100});after=page.next;
        for(const message of page.messages){add(exporter.push(JSON.stringify([message])));if(exporter.count()>=3||bytes>=CHUNK_BYTES)break outer;}
      } while(after!==null);
      add(exporter.finish());return {text,count:exporter.count()};
    } finally {exporter.free?.();}
  }

  async function exportFiles({jobId,formats,options={},splitMessages=0,filename}, token) {
    const job=await exportableJob(jobId);
    if (!getDirectory) throw new Error('OPFS disk export storage is unavailable. Use a browser with private file-system support.');
    if(!Array.isArray(formats)||!formats.length||formats.some(f=>!FORMATS.has(f)))throw new Error('Choose supported export formats');
    if(options.gzip&&!createCompressionStream)throw new Error('Gzip compression is unavailable: this browser does not support CompressionStream. Turn off gzip and export again.');
    await preflight(job.bytes);
    splitMessages = Math.max(0,Math.floor(Number(splitMessages)||0));
    const directory=await (await getDirectory()).getDirectoryHandle(EXPORT_DIRECTORY,{create:true});
    const generated=[],files=[];const runId=crypto.randomUUID();const base=safeName(filename||job.name);
    let currentWriter, currentExporter;
    try {
      for (const format of [...new Set(formats)]) {
        const limit=format==='html'?Math.min(splitMessages||10000,10000):splitMessages;
        let part=0,after=null,total=0,writer,handle,name,exporter,header,pending='',pendingBytes=0,pendingRows=0;
        const encoder=new TextEncoder();
        const writeChunked=async text=>{
          if(!text)return;
          const encoded=encoder.encode(text);
          if(encoded.byteLength<=CHUNK_BYTES){await writer.write(text);return;}
          for(let offset=0;offset<encoded.byteLength;offset+=CHUNK_BYTES){check(token);await writer.write(encoded.subarray(offset,offset+CHUNK_BYTES));}
        };
        const flush=async()=>{if(pending){await writer.write(pending);pending='';pendingBytes=0;pendingRows=0;}};
        const output=async chunk=>{
          if(!chunk)return;
          const bytes=encoder.encode(chunk).byteLength;
          if(bytes>CHUNK_BYTES){await flush();await writeChunked(chunk);return;}
          if(pendingBytes+bytes>CHUNK_BYTES)await flush();
          pending+=chunk;pendingBytes+=bytes;pendingRows++;
          if(pendingRows>=100||pendingBytes>=CHUNK_BYTES)await flush();
        };
        const start=()=>{exporter=exporterFor(format,options,job);currentExporter=exporter;header=exporter.begin();};
        const open=async()=>{
          name=`${base}-${format}-${runId}-${String(++part).padStart(3,'0')}.${extension(format)}${options.gzip?'.gz':''}`;
          handle=await directory.getFileHandle(name,{create:true});generated.push(name);writer=await handle.createWritable();currentWriter=writer;
          if(options.gzip){writer=compressedWriter(writer,token);currentWriter=writer;}
          await writeChunked(header);
        };
        const finish=async()=>{
          if(!writer)await open();
          await flush();await writeChunked(exporter.finish());await writer.close();currentWriter=undefined;
          const file=await handle.getFile();files.push({name,file,count:exporter.count(),format,bytes:file.size});
          total+=exporter.count();exporter.free?.();currentExporter=undefined;writer=undefined;exporter=undefined;
        };
        start();
        do {
          check(token);const page=await storage.readPage(jobId,{after,limit:100});after=page.next;
          for(const message of page.messages){
            check(token);if(!exporter)start();
            const before=exporter.count(),chunk=exporter.push(JSON.stringify([message]));
            if(exporter.count()>before){if(!writer)await open();await output(chunk);}
            if(limit&&exporter.count()>=limit)await finish();
          }
          emit('export',{...job,count:total+(exporter?.count()||0)},undefined,undefined);check(token);
        } while(after!==null);
        if(exporter){if(exporter.count()||part===0)await finish();else{exporter.free?.();currentExporter=undefined;}}
      }
      check(token);const count=files.filter(f=>f.format===formats[0]).reduce((sum,f)=>sum+f.count,0);
      emit('export',{...job,count},undefined,undefined,true);check(token);return {files,count};
    } catch(error) {
      try{await currentWriter?.abort();}catch{}
      currentExporter?.free?.();
      for(const name of generated){try{await directory.removeEntry(name);}catch{}}
      throw error;
    }
  }

  // Consume compressed bytes continuously so both compression and disk writes apply backpressure.
  function compressedWriter(diskWriter,token) {
    const compression=createCompressionStream('gzip');
    const input=compression.writable.getWriter(),output=compression.readable.getReader(),encoder=new TextEncoder();
    const pumping=(async()=>{
      try {
        while(true){
          const {value,done}=await output.read();if(done)break;
          for(let offset=0;offset<value.byteLength;offset+=CHUNK_BYTES){check(token);await diskWriter.write(value.subarray(offset,offset+CHUNK_BYTES));}
        }
      } catch(error) {await output.cancel(error).catch(()=>{});throw error;}
    })();
    pumping.catch(()=>{});
    return {
      async write(chunk){check(token);await input.write(typeof chunk==='string'?encoder.encode(chunk):chunk);check(token);},
      async close(){await input.close();await pumping;check(token);await diskWriter.close();},
      async abort(){
        const reason=new Error('Operation cancelled');
        await Promise.allSettled([output.cancel(reason),input.abort(reason),diskWriter.abort()]);
        await pumping.catch(()=>{});
      }
    };
  }

  async function clearExports(token) {
    if(!getDirectory)throw new Error('OPFS disk export storage is unavailable.');
    let directory;
    try {directory=await (await getDirectory()).getDirectoryHandle(EXPORT_DIRECTORY);}
    catch(error){if(error.name==='NotFoundError')return {cleared:0};throw error;}
    let cleared=0;
    for await(const [name,entry] of directory.entries()){
      check(token);
      if(entry.kind==='file'){await directory.removeEntry(name);cleared++;}
    }
    return {cleared};
  }

  async function run(message,token) {
    await ensure();check(token);
    switch(message.type){
      case 'init':return {jobs:await storage.list(),storage:await estimate()};
      case 'create':return storage.create({channel:message.channel,settings:message.settings});
      case 'append':{
        const job=await jobFor(message.jobId);
        const records=JSON.parse(engine.normalize_batch(JSON.stringify(message.messages),JSON.stringify(job.channel)));
        const updated=await storage.append(job.id,records,message.checkpoint);emit('capture',updated);return updated;
      }
      case 'finish':{
        if(!['ready','paused','error'].includes(message.status))throw new Error('Invalid capture status');
        return storage.update(message.jobId,{status:message.status,error:message.error?String(message.error):null});
      }
      case 'summary':return storage.summary(message.jobId,message.search);
      case 'import':return importFile(message,token);
      case 'preview':return preview(message,token);
      case 'export':return exportFiles(message,token);
      case 'delete':return storage.delete(message.jobId);
      case 'clearExports':return clearExports(token);
      default:throw new Error(`Unknown archive operation: ${message.type}`);
    }
  }
  return {
    dispatch(message){
      if(message.type==='cancel'){cancellation++;return Promise.resolve({cancelled:true});}
      const task=queue.then(()=>run(message,cancellation)).catch(error=>{throw new Error(errorText(error));});
      queue=task.catch(()=>{});return task;
    }
  };
}

if(typeof WorkerGlobalScope!=='undefined'&&globalThis instanceof WorkerGlobalScope){
  const worker=createArchiveWorker({progress:message=>globalThis.postMessage(message)});
  globalThis.onmessage=async({data})=>{
    try{globalThis.postMessage({id:data.id,result:await worker.dispatch(data)});}
    catch(error){globalThis.postMessage({id:data.id,error:errorText(error)});}
  };
}
