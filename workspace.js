import {PRESETS,normalizeSettings,runCollection,fetchDiscordPage,withCaptureJobLock} from './collector.js';

const api=globalThis.browser??globalThis.chrome;
const $=id=>document.getElementById(id);
const worker=new Worker(new URL('./archive-worker.js',import.meta.url),{type:'module'});
const pending=new Map();let sequence=0,currentJob=null,busy=false,controller=null,previewRevision=0,summaryRevision=0,selectionRevision=0,workerFailure=null;
const urls=new Set();const params=new URLSearchParams(location.search);
const source={tabId:Number(params.get('tabId')),channelId:params.get('channelId'),name:params.get('name')||'Discord channel'};
const canCollect=Number.isSafeInteger(source.tabId)&&source.tabId>0&&/^\d{1,20}$/.test(source.channelId||'')&&!!api?.scripting;
const bytes=value=>value<1048576?`${(value/1024).toFixed(1)} KiB`:`${(value/1048576).toFixed(1)} MiB`;
const fmt=value=>Number(value||0).toLocaleString();

function rpc(type,fields={}) {
    if(workerFailure)return Promise.reject(workerFailure);
    const id=++sequence;
    return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,type,...fields});});
}
function error(value){$('error').hidden=!value;$('error').textContent=value?String(value.message||value):'';}
function status(message,detail=''){$('status').textContent=message;if(detail)$('details').textContent=detail;}
function setBusy(value){
    busy=value;
    for(const element of document.querySelectorAll('main input,main select,main button,main summary')) {
        if(element.id!=='pause') {element.disabled=value; if(element.tagName==='SUMMARY')element.style.pointerEvents=value?'none':'';}
    }
    $('pause').disabled=!value;
    $('collect').disabled=value||!canCollect;
    $('export').disabled=value||!currentJob||currentJob.status==='importing';
    $('resume').disabled=value||!currentJob||currentJob.kind!=='capture'||currentJob.status==='ready';
    $('delete').disabled=value||!currentJob;
}
worker.onmessage=({data})=>{
    if(data.type==='progress') {
        const label=data.operation==='import'?'Importing file':data.operation==='export'?'Preparing export':'Collecting messages';
        status(label,`${fmt(data.count)} messages saved${data.bytes?` · ${bytes(data.bytes)}`:''}. Batches are committed to local storage.`);
        $('progress').hidden=!data.totalBytes;
        if(data.totalBytes){$('progress').max=data.totalBytes;$('progress').value=data.bytes||0;}
        return;
    }
    const request=pending.get(data.id);if(!request)return;pending.delete(data.id);
    data.error?request.reject(new Error(data.error)):request.resolve(data.result);
};
worker.onerror=event=>{
    const failure=new Error(event.message||'The processing worker stopped. Reload this workspace to recover committed collection batches.');
    workerFailure=failure;
    for(const request of pending.values())request.reject(failure);pending.clear();controller?.abort();error(failure);setBusy(false);
};

function collectionSettings(){
    const raw={};for(const key of ['batchSize','intervalMs','timeoutMs','maxRetries','maxMessages','afterDate','beforeDate','beforeId','userIds'])raw[key]=$(key).value;
    return normalizeSettings(raw);
}
function displaySettings(settings){
    for(const key of ['batchSize','intervalMs','timeoutMs','maxRetries','maxMessages','afterDate','beforeDate','beforeId'])if(settings[key]!==undefined)$(key).value=settings[key];
    $('userIds').value=(settings.userIds||[]).join(', ');
}
function exportOptions(){return {user_key:$('userSelect').value||null,skip_empty:$('skipEmpty').checked,include_media:$('includeMedia').checked,pretty:$('pretty').checked,gzip:$('gzip').checked,include_reply_text:$('includeReplyText').checked,html_quality:$('htmlQuality').value,include_machine_data:$('includeMachineData').checked};}
async function saveSettings(includeCollection=true){
    if(!api?.storage?.local)return;
    await api.storage.local.set({...(includeCollection?{collectionSettings:collectionSettings()}:{}),exportSettings:{formats:[...document.querySelectorAll('[name=format]:checked')].map(e=>e.value),splitMessages:Number($('splitMessages').value),options:exportOptions()}});
}
async function refreshJobs(selectId=currentJob?.id){
    const result=await rpc('init');
    const usage=result.storage?.usage||0,quota=result.storage?.quota;
    $('storage').textContent=`Local cache: ${bytes(usage)}${quota?` / ${bytes(quota)}`:''}`;
    const previous=$('jobs').value;
    $('jobs').replaceChildren();
    const jobs=result.jobs.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    for(const job of jobs){const option=new Option(`${job.name} — ${fmt(job.count)} messages · ${job.status}`,job.id);$('jobs').append(option);}
    if(!jobs.length)$('jobs').append(new Option('No archives yet',''));
    const chosen=selectId||previous;if(jobs.some(j=>j.id===chosen))$('jobs').value=chosen;
    return jobs;
}
async function chooseJob(id){
    if(!id)return;
    const revision=++selectionRevision;summaryRevision++;previewRevision++;
    const result=await rpc('summary',{jobId:id});if(revision!==selectionRevision)return;currentJob=result.job;
    $('filename').value=currentJob.channel?.name||currentJob.name||'discord_archive';
    $('userSearch').value='';$('userSelect').replaceChildren(new Option('Everyone',''));
    renderSummary(result);
    $('jobInfo').textContent=`${fmt(currentJob.count)} saved · ${fmt(currentJob.scanned)} scanned · ${currentJob.status}. ${currentJob.kind==='capture'?'Resume uses this job’s original settings.':'Imported file order is preserved.'}`;
    $('warnings').textContent=(currentJob.warnings||[]).join('\n');
    setBusy(busy);
    if(currentJob.status==='importing'){$('preview').textContent='This import was interrupted. Delete its staging cache and import the file again.';$('export').disabled=true;}
    else await updatePreview();
}
function renderSummary(result){
    const previous=$('userSelect').value;
    const previousLabel=$('userSelect').selectedOptions[0]?.textContent;
    $('userSelect').replaceChildren(new Option('Everyone',''));
    for(const user of result.users){$('userSelect').append(new Option(`${user.display_name} (${fmt(user.count)}) · ${user.id||'name only'}`,user.key));}
    if(previous && ![...$('userSelect').options].some(option=>option.value===previous))$('userSelect').append(new Option(previousLabel||previous,previous));
    $('userSelect').value=previous;
    $('previewInfo').textContent=result.truncatedUsers?'User list shows the first 200 matches. Refine the search. Preview shows up to 3 messages.':'Preview shows up to three matching messages.';
}
async function updatePreview(){
    if(!currentJob||currentJob.status==='importing'||busy)return;
    const revision=++previewRevision,jobId=currentJob.id;
    const result=await rpc('preview',{jobId,format:$('previewFormat').value,options:exportOptions()});
    if(revision===previewRevision&&jobId===currentJob?.id){
        let text=result.text;
        if(['compact','compact-cleaned','full','cleaned','messages'].includes($('previewFormat').value)){try{text=JSON.stringify(JSON.parse(text),null,2);}catch{}}
        $('preview').textContent=text||'(No matching message text.)';
    }
}

async function collect(resume=false){
    error(null);if(!canCollect)throw new Error('Open this workspace from the desired Discord channel using the extension popup.');
    let job;
    if(resume){
        job=currentJob;
        if(!job||job.kind!=='capture'||job.channel.id!==source.channelId)throw new Error('Open the original Discord channel and its workspace to resume this archive.');
        displaySettings(job.settings);
    }
    const settings=resume?normalizeSettings(job.settings):collectionSettings();
    await saveSettings();
    const perform=async lock=>{
        if(!lock)throw new Error('Another workspace is already collecting from this Discord tab.');
        setBusy(true);controller=new AbortController();let committed=job;
        try{
            if(!committed)committed=await rpc('create',{channel:{id:source.channelId,name:source.name},settings});
            await withCaptureJobLock(navigator.locks,committed.id,async()=>{
            // Re-read after acquiring ownership; another workspace may have advanced it.
            committed=(await rpc('summary',{jobId:committed.id})).job;
            if(resume&&committed.status==='ready')throw new Error('This archive has already finished collecting.');
            try{
            currentJob=committed;status('Collecting channel history','Do not close the Discord tab. Closing this workspace pauses at the last committed page.');
            const result=await runCollection({settings,cursor:committed.cursor,scanned:committed.scanned,signal:controller.signal,
                fetchPage:async(before,limit,timeout)=>{
                    const responses=await api.scripting.executeScript({target:{tabId:source.tabId},world:'MAIN',func:fetchDiscordPage,args:[source.channelId,before,limit,timeout]});
                    if(!responses?.[0]?.result)throw new Error('Discord did not return a page; keep the original channel open.');
                    return responses[0].result;
                },
                saveBatch:async(messages,checkpoint)=>{committed=await rpc('append',{jobId:committed.id,messages,checkpoint});currentJob=committed;},
                onProgress:progress=>status(progress.status,`${fmt(progress.scanned)} scanned · ${fmt(committed.count)} saved${progress.delay?` · waiting ${(progress.delay/1000).toFixed(1)}s`:''}`)
            });
            committed=await rpc('finish',{jobId:committed.id,status:result.status});currentJob=committed;
            status(result.status==='paused'?'Collection paused':'Requested collection finished',`${fmt(committed.count)} saved messages. ${result.reason==='limit'?'The fetched-message limit was reached.':''}`);
            }catch(failure){
                try{currentJob=await rpc('finish',{jobId:committed.id,status:'paused',error:String(failure.message||failure)});}catch{}
                throw failure;
            }
            });
        }catch(failure){
            throw failure;
        }finally{
            controller=null;setBusy(false);$('progress').hidden=true;await refreshJobs(currentJob?.id);if(currentJob)await chooseJob(currentJob.id);
        }
    };
    if(!navigator.locks?.request)throw new Error('This browser does not support the collection lock needed to prevent duplicate jobs.');
    await navigator.locks.request(`discord-archiver-tab-${source.tabId}`,{ifAvailable:true},perform);
}

function listen(id,event,fn){$(id).addEventListener(event,async e=>{try{await fn(e);}catch(failure){error(failure);}});}
listen('collectionForm','submit',async event=>{event.preventDefault();if(!busy)await collect();});
listen('resume','click',()=>collect(true));
listen('load','click',()=>chooseJob($('jobs').value));
listen('preset','change',()=>{const preset=PRESETS[$('preset').value];if(preset)displaySettings({...collectionSettings(),...preset});});
for(const id of ['intervalMs','batchSize','timeoutMs','maxRetries'])listen(id,'change',()=>{$('preset').value='custom';});
listen('pause','click',async()=>{
    controller?.abort();
    if(controller&&canCollect){api.scripting.executeScript({target:{tabId:source.tabId},world:'MAIN',func:()=>window.__discordArchiverRequest?.abort()}).catch(()=>{});}
    await rpc('cancel');status('Stopping after the current disk operation…');
});
listen('file','change',async()=>{
    const file=$('file').files[0];if(!file||busy)return;error(null);setBusy(true);
    try{status('Importing archive',`${file.name} · ${bytes(file.size)}`);const job=await rpc('import',{file});currentJob=job;status('Import finished',`${fmt(job.count)} messages saved.`);}
    finally{setBusy(false);$('progress').hidden=true;await refreshJobs(currentJob?.id);if(currentJob)await chooseJob(currentJob.id);$('file').value='';}
});
listen('delete','click',async()=>{
    if(!currentJob||busy)return;
    if(!confirm(`Delete the local cache for “${currentJob.name}”? Downloaded files are kept.`))return;
    await rpc('delete',{jobId:currentJob.id});currentJob=null;$('preview').textContent='Choose another archive.';await refreshJobs();setBusy(false);status('Local archive cache deleted');
});
let searchTimer;
listen('userSearch','input',()=>{
    clearTimeout(searchTimer);const revision=++summaryRevision;
    searchTimer=setTimeout(async()=>{try{if(!currentJob||busy)return;const jobId=currentJob.id;const result=await rpc('summary',{jobId,search:$('userSearch').value});if(revision===summaryRevision&&currentJob?.id===jobId&&result.job.id===jobId)renderSummary(result);}catch(failure){error(failure);}},180);
});
for(const id of ['userSelect','previewFormat','skipEmpty','includeMedia','includeReplyText','pretty','htmlQuality','includeMachineData'])listen(id,'change',updatePreview);
listen('export','click',async()=>{
    if(!currentJob||busy)return;
    const formats=[...document.querySelectorAll('[name=format]:checked')].map(e=>e.value);
    const splitMessages=Number($('splitMessages').value);
    if(!formats.length)throw new Error('Select at least one export format.');
    if(!Number.isSafeInteger(splitMessages)||splitMessages<0||splitMessages>1000000000)throw new Error('Messages per file must be a non-negative integer.');
    await saveSettings(false);error(null);setBusy(true);status('Preparing downloads','Each file is written to local disk in bounded chunks.');
    try{
        const result=await rpc('export',{jobId:currentJob.id,formats,options:exportOptions(),splitMessages,filename:$('filename').value});
        for(const file of result.files){
            const url=URL.createObjectURL(file.file);urls.add(url);
            const row=document.createElement('div');row.className='download';
            const link=document.createElement('a');link.href=url;link.download=file.name;link.textContent=file.name;
            const detail=document.createElement('span');detail.textContent=`${fmt(file.count)} messages · ${bytes(file.bytes)}`;
            row.append(link,detail);$('downloads').append(row);
        }
        status('Downloads ready',`${result.files.length} files. Click the links below the preview to save them.`);
    }finally{setBusy(false);$('progress').hidden=true;await refreshJobs(currentJob.id);}
});
listen('clearExports','click',async()=>{
    if(busy||!confirm('Clear all prepared export files and their download links, including other workspace tabs? Files already saved to your Downloads folder and archived message caches are kept.'))return;
    const result=await rpc('clearExports');for(const url of urls)URL.revokeObjectURL(url);urls.clear();$('downloads').replaceChildren();
    await refreshJobs(currentJob?.id);status('Prepared export files cleared',`${result.cleared} temporary files removed.`);
});

window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
window.addEventListener('unload',()=>{for(const url of urls)URL.revokeObjectURL(url);});

async function start(){
    $('channel').textContent=canCollect?`Source: #${source.name}. Collection uses the original Discord tab.`:'Import a local archive, or open this workspace from a Discord channel to collect history.';
    setBusy(true);
    if(api?.storage?.local){
        const saved=await api.storage.local.get(['collectionSettings','exportSettings']);
        if(saved.collectionSettings){try{displaySettings(normalizeSettings(saved.collectionSettings));}catch{}}
        const output=saved.exportSettings;
        if(output){
            if(Array.isArray(output.formats))for(const box of document.querySelectorAll('[name=format]'))box.checked=output.formats.includes(box.value);
            if(Number.isSafeInteger(output.splitMessages))$('splitMessages').value=output.splitMessages;
            if(output.options){$('skipEmpty').checked=!!output.options.skip_empty;$('includeMedia').checked=!!output.options.include_media;$('pretty').checked=!!output.options.pretty;$('gzip').checked=!!output.options.gzip;$('includeReplyText').checked=!!output.options.include_reply_text;$('includeMachineData').checked=!!output.options.include_machine_data;if(['compact','standard','rich'].includes(output.options.html_quality))$('htmlQuality').value=output.options.html_quality;}
        }
    }
    const jobs=await refreshJobs();setBusy(false);status('Ready','Choose an archive or collect a channel. Content stays in local browser storage.');
    if(jobs.length)await chooseJob($('jobs').value);
}
start().catch(failure=>{error(failure);setBusy(false);$('collect').disabled=true;$('export').disabled=true;status('Workspace could not start','Check that the packaged WASM files are present and this browser supports local disk storage.');});
