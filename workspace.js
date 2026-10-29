import {PRESETS,normalizeSettings,runCollection,fetchDiscordPage,withCaptureJobLock} from './collector.js';

const api=globalThis.browser??globalThis.chrome;
const $=id=>document.getElementById(id);
const worker=new Worker(new URL('./archive-worker.js',import.meta.url),{type:'module'});
const pending=new Map();let sequence=0,currentJob=null,busy=false,controller=null,previewRevision=0,summaryRevision=0,selectionRevision=0,workerFailure=null;
const urls=new Set();const params=new URLSearchParams(location.search);
const preparedFiles=[];
let operationKind='init',operationStarted=0,operationTimer=null,previewPending=false;
let updateBoundaryInfo=null;
const source={tabId:Number(params.get('tabId')),channelId:params.get('channelId'),name:params.get('name')||'Discord channel'};
const canCollect=Number.isSafeInteger(source.tabId)&&source.tabId>0&&/^\d{1,20}$/.test(source.channelId||'')&&!!api?.scripting;
const bytes=value=>{if(!Number.isFinite(value)||value<0)return '—';if(value<1024)return `${Math.round(value)} B`;if(value<1048576)return `${(value/1024).toFixed(1)} KiB`;if(value<1073741824)return `${(value/1048576).toFixed(1)} MiB`;return `${(value/1073741824).toFixed(2)} GiB`;};
const fmt=value=>Number(value||0).toLocaleString();

function setSourceMode(mode,{focus=false}={}) {
    if(busy)return;
    const collecting=mode==='collect';
    for(const [id,selected] of [['modeCollect',collecting],['modeImport',!collecting]]){
        $(id).setAttribute('aria-selected',String(selected));
        $(id).tabIndex=selected?0:-1;
        if(selected&&focus)$(id).focus();
    }
    $('collectPanel').hidden=!collecting;
    $('importPanel').hidden=collecting;
}

function updateElapsed() {
    const seconds=Math.max(0,Math.floor((performance.now()-operationStarted)/1000));
    const minutes=Math.floor(seconds/60);
    $('elapsed').textContent=`${minutes}:${String(seconds%60).padStart(2,'0')} elapsed`;
}

function updateSummary() {
    $('summaryArchive').textContent=currentJob?.channel?.name||currentJob?.name||'No archive selected';
    $('summaryArchive').title=$('summaryArchive').textContent;
    $('summaryMessages').textContent=currentJob?fmt(currentJob.count):'—';
    const selected=$('userSelect').selectedOptions[0];
    $('summaryScope').textContent=$('userSelect').value?(selected?.textContent||'Selected author'):'All authors';
    $('summaryScope').title=$('summaryScope').textContent;
    const labels={ready:'Ready to export',paused:'Paused · resumable',collecting:'Collection in progress',importing:'Incomplete import',error:'Needs attention'};
    $('summaryState').textContent=currentJob?`${labels[currentJob.status]||currentJob.status}${currentJob.partial?' · partial history':''}`:'Choose a source';
    $('exportEmpty').hidden=!!currentJob;
}

function updateFormatNote() {
    const count=document.querySelectorAll('[name=format]:checked').length;
    $('selectionNote').textContent=`${count} ${count===1?'format':'formats'} selected · ${$('pretty').checked?'readable JSON':'minified output'}${$('gzip').checked?' · gzip':''}`;
}

function updateDownloads() {
    $('downloadPanel').hidden=!preparedFiles.length;
    $('downloadSummary').textContent=`${preparedFiles.length} ${preparedFiles.length===1?'file':'files'} · ${bytes(preparedFiles.reduce((sum,file)=>sum+file.bytes,0))}`;
    $('downloadAll').disabled=busy||preparedFiles.length<2;
}

function rpc(type,fields={}) {
    if(workerFailure)return Promise.reject(workerFailure);
    const id=++sequence;
    return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,type,...fields});});
}
function error(value){$('error').hidden=!value;$('errorMessage').textContent=value?String(value.message||value):'';if(!busy)$('operationBadge').textContent=value?'Needs attention':'Ready';}
function status(message,detail=''){$('status').textContent=message;if(detail)$('details').textContent=detail;}
function setBusy(value,kind=operationKind){
    if(value&&!busy){
        operationKind=kind;operationStarted=performance.now();$('elapsed').hidden=kind==='init';updateElapsed();
        operationTimer=setInterval(updateElapsed,1000);
        $('progress').value=0;$('progressTrack').hidden=true;$('progress').hidden=true;
    }else if(!value&&busy){
        clearInterval(operationTimer);operationTimer=null;updateElapsed();$('progressTrack').hidden=true;$('progress').hidden=true;
    }
    busy=value;
    $('workspace').setAttribute('aria-busy',String(value));
    for(const element of document.querySelectorAll('main input,main select,main button,main summary')) {
        if(element.id!=='pause') {element.disabled=value; if(element.tagName==='SUMMARY')element.style.pointerEvents=value?'none':'';}
    }
    $('pause').disabled=!value;
    $('collect').disabled=value||!canCollect;
    $('export').disabled=value||!currentJob||currentJob.status==='importing';
    $('resume').disabled=value||!currentJob||currentJob.kind!=='capture'||currentJob.status==='ready';
    $('delete').disabled=value||!currentJob;
    $('load').disabled=value||!$('jobs').value;
    $('mergeFile').disabled=value||!currentJob||currentJob.status==='importing';
    $('combineWith').disabled=value||!currentJob||currentJob.status==='importing';
    $('combineSaved').disabled=value||!currentJob||!$('combineWith').value||currentJob.status==='importing';
    $('fetchNewer').disabled=value||!currentJob||!canCollect||!updateBoundaryInfo?.newestId||updateBoundaryInfo.job.id!==currentJob.id;
    $('finishUpdate').hidden=currentJob?.kind!=='capture'||!currentJob?.settings?.updateBaseJobId||currentJob.status!=='ready';
    $('finishUpdate').disabled=value;
    $('copyPreview').disabled=value||!currentJob||currentJob.status==='importing'||previewPending;
    const operationLabels={init:'Starting',collect:'Collecting',import:'Organizing',merge:'Combining',export:'Exporting'};
    $('operationBadge').textContent=value?(operationLabels[operationKind]||'Working'):($('error').hidden?'Ready':'Needs attention');
    $('pause').textContent=operationKind==='collect'?'Pause collection':operationKind==='import'?'Cancel import':operationKind==='merge'?'Cancel update':operationKind==='export'?'Cancel export':'Pause / cancel';
    if(value&&kind==='init')$('pause').disabled=true;
    updateDownloads();
}
worker.onmessage=({data})=>{
    if(data.type==='progress') {
        const label=data.operation==='import'?'Importing file':data.operation==='export'?'Preparing export':['merge','combine'].includes(data.operation)?'Combining archives':'Collecting messages';
        status(label,`${fmt(data.count)} messages ${data.operation==='export'?'written':'saved'}${data.bytes&&data.operation!=='export'?` · ${bytes(data.bytes)}`:''}${data.totalBytes?` of ${bytes(data.totalBytes)}`:''}.`);
        $('progress').hidden=!data.totalBytes;
        $('progressTrack').hidden=!data.totalBytes;
        if(data.totalBytes){$('progress').max=data.totalBytes;$('progress').value=data.bytes||0;$('progressPercent').textContent=`${Math.min(100,Math.max(0,Math.floor((data.bytes||0)/data.totalBytes*100)))}%`;}
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
    const previousAdditional=$('combineWith').value;
    $('combineWith').replaceChildren(new Option('Choose another archive',''));
    for(const job of jobs)if(job.status!=='importing')$('combineWith').append(new Option(`${job.name} · ${fmt(job.count)} messages`,job.id));
    if([...$('combineWith').options].some(option=>option.value===previousAdditional))$('combineWith').value=previousAdditional;
    if(!busy)$('load').disabled=!$('jobs').value;
    return jobs;
}
async function chooseJob(id){
    if(!id)return;
    const revision=++selectionRevision;summaryRevision++;previewRevision++;updateBoundaryInfo=null;
    const result=await rpc('summary',{jobId:id});if(revision!==selectionRevision)return;currentJob=result.job;
    $('filename').value=currentJob.channel?.name||currentJob.name||'discord_archive';
    $('userSearch').value='';$('userSelect').replaceChildren(new Option('Everyone',''));
    renderSummary(result);
    $('jobInfo').textContent=`${fmt(currentJob.count)} saved · ${fmt(currentJob.scanned)} scanned · ${currentJob.status}. ${currentJob.kind==='capture'?'Resume uses this job’s original settings.':'Imported file order is preserved.'}`;
    $('warnings').textContent=(currentJob.warnings||[]).join('\n');
    $('updateTarget').textContent=`Add messages to “${currentJob.name}”. Originals stay in the cache; the combined archive is a new copy.`;
    for(const option of $('combineWith').options)option.disabled=option.value===id;
    if($('combineWith').value===id)$('combineWith').value='';
    $('updateInfo').textContent=canCollect?'Checking this channel’s newest saved message…':'Open this workspace from the matching Discord channel to fetch newer messages. Files can be combined here at any time.';
    updateSummary();
    setBusy(busy);
    if(canCollect&&currentJob.status!=='importing'){
        const info=await rpc('updateInfo',{jobId:id,channelId:source.channelId});
        if(revision!==selectionRevision)return;
        updateBoundaryInfo=info;
        $('updateInfo').textContent=info.newestId?`Fetch messages newer than saved ID ${info.newestId} in #${source.name}. Uses your request size, pacing, message cap, and user IDs; date/start-before fields are ignored. This does not fill older gaps.`:'No saved message IDs for this channel. Combine a newer file, or collect this channel first. Original HTML can still be converted and combined.';
        setBusy(busy);
    }
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
    updateSummary();
}
async function updatePreview(){
    if(!currentJob||currentJob.status==='importing'||busy)return;
    const revision=++previewRevision,jobId=currentJob.id;
    previewPending=true;$('copyPreview').disabled=true;$('previewFeedback').textContent='Updating preview…';updateSummary();
    let result;
    try{result=await rpc('preview',{jobId,format:$('previewFormat').value,options:exportOptions()});}
    catch(failure){if(revision===previewRevision){previewPending=false;$('preview').textContent='The preview could not be prepared. Choose another format or retry.';$('previewFeedback').textContent='Preview unavailable.';}throw failure;}
    if(revision===previewRevision&&jobId===currentJob?.id){
        let text=result.text;
        if(['compact','compact-cleaned','full','cleaned','messages'].includes($('previewFormat').value)){try{text=JSON.stringify(JSON.parse(text),null,2);}catch{}}
        $('preview').textContent=text||'(No matching message text.)';
        previewPending=false;$('copyPreview').disabled=busy;$('previewFeedback').textContent='Preview formatting does not increase your output file size.';
    }
}

async function collect(resume=false,updateBaseJobId=null){
    error(null);if(!canCollect)throw new Error('Open this workspace from the desired Discord channel using the extension popup.');
    let job;
    if(resume){
        job=currentJob;
        if(!job||job.kind!=='capture'||job.channel.id!==source.channelId)throw new Error('Open the original Discord channel and its workspace to resume this archive.');
        displaySettings(job.settings);
    }
    let settings=resume?normalizeSettings(job.settings):collectionSettings();
    if(updateBaseJobId){
        const boundary=await rpc('updateInfo',{jobId:updateBaseJobId,channelId:source.channelId});
        if(!boundary.newestId)throw new Error('This archive has no saved message IDs for the open channel. Add messages from a file or start a new collection.');
        settings=normalizeSettings({...settings,afterId:boundary.newestId,beforeId:'',afterDate:'',beforeDate:'',updateBaseJobId});
    }
    await saveSettings();
    const perform=async lock=>{
        if(!lock)throw new Error('Another workspace is already collecting from this Discord tab.');
        setBusy(true,'collect');controller=new AbortController();let committed=job;
        try{
            if(!committed)committed=await rpc('create',{channel:{id:source.channelId,name:source.name},settings});
            await withCaptureJobLock(navigator.locks,committed.id,async()=>{
            // Re-read after acquiring ownership; another workspace may have advanced it.
            committed=(await rpc('summary',{jobId:committed.id})).job;
            if(resume&&committed.status==='ready')throw new Error('This archive has already finished collecting.');
            try{
            currentJob=committed;status(settings.updateBaseJobId?'Collecting newer messages':'Collecting channel history','Do not close the Discord tab. Closing this workspace pauses at the last committed page.');
            const result=await runCollection({settings,cursor:committed.cursor,scanned:committed.scanned,signal:controller.signal,
                fetchPage:async(before,limit,timeout)=>{
                    const responses=await api.scripting.executeScript({target:{tabId:source.tabId},world:'MAIN',func:fetchDiscordPage,args:[source.channelId,before,limit,timeout]});
                    if(!responses?.[0]?.result)throw new Error('Discord did not return a page; keep the original channel open.');
                    return responses[0].result;
                },
                saveBatch:async(messages,checkpoint)=>{committed=await rpc('append',{jobId:committed.id,messages,checkpoint});currentJob=committed;updateSummary();},
                onProgress:progress=>status(progress.status,`${fmt(progress.scanned)} scanned · ${fmt(committed.count)} saved${progress.delay?` · waiting ${(progress.delay/1000).toFixed(1)}s`:''}`)
            });
            committed=await rpc('finish',{jobId:committed.id,status:result.status,reason:result.reason});currentJob=committed;
            status(result.status==='paused'?'Collection paused':'Requested collection finished',`${fmt(committed.count)} saved messages. ${result.reason==='limit'?'The fetched-message limit was reached.':''}`);
            if(result.status==='ready'&&settings.updateBaseJobId){
                status('Combining newer messages','Your original archive and new collection remain available.');
                currentJob=await rpc('combine',{baseJobId:settings.updateBaseJobId,additionalJobId:committed.id});
                showMergeResult(currentJob);
            }
            }catch(failure){
                if(committed.status!=='ready')try{currentJob=await rpc('finish',{jobId:committed.id,status:'paused',error:String(failure.message||failure)});}catch{}
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

function listen(id,event,fn){$(id).addEventListener(event,async e=>{try{await fn(e);}catch(failure){error(failure);if(!busy)status('Operation stopped','Review the message above and try again. Saved archives remain available.');}});}
listen('collectionForm','submit',async event=>{event.preventDefault();if(!busy)await collect();});
listen('resume','click',()=>collect(true));
listen('load','click',()=>chooseJob($('jobs').value));
listen('jobs','change',()=>{$('load').disabled=busy||!$('jobs').value;});
listen('combineWith','change',()=>setBusy(busy));
function showMergeResult(job){
    const stats=job.mergeStats||{};
    status('Archive updated',`${fmt(stats.added)} added · ${fmt(stats.duplicates)} known duplicates skipped · ${fmt(job.count)} total. Export the combined copy below.${stats.unidentified?' Some messages have no stable IDs; overlapping legacy messages may repeat.':''}`);
}
async function updateArchive(fields){
    if(busy||!currentJob)return;
    const baseJobId=currentJob.id;error(null);setBusy(true,'merge');
    try{status('Combining archives','Writing a new combined copy. Original archives stay available.');currentJob=fields.file?await rpc('merge',{baseJobId,file:fields.file}):await rpc('combine',{baseJobId,additionalJobId:fields.additionalJobId});showMergeResult(currentJob);}
    finally{setBusy(false);$('mergeFile').value='';await refreshJobs(currentJob?.id);if(currentJob)await chooseJob(currentJob.id);}
}
listen('mergeFile','change',()=>{const file=$('mergeFile').files[0];if(file)return updateArchive({file});});
listen('combineSaved','click',()=>updateArchive({additionalJobId:$('combineWith').value}));
listen('fetchNewer','click',async()=>{
    if(busy||!currentJob)return;
    const id=currentJob.id;error(null);setBusy(true,'collect');
    try{await collect(false,id);}finally{setBusy(false);}
});
listen('finishUpdate','click',async()=>{
    if(busy||!currentJob?.settings?.updateBaseJobId)return;
    const additionalJobId=currentJob.id,baseJobId=currentJob.settings.updateBaseJobId;
    error(null);setBusy(true,'merge');
    try{currentJob=await rpc('combine',{baseJobId,additionalJobId});showMergeResult(currentJob);}
    finally{setBusy(false);await refreshJobs(currentJob?.id);if(currentJob)await chooseJob(currentJob.id);}
});
listen('modeCollect','click',()=>setSourceMode('collect'));
listen('modeImport','click',()=>setSourceMode('import'));
for(const id of ['modeCollect','modeImport'])listen(id,'keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const mode=event.key==='Home'?'collect':event.key==='End'?'import':id==='modeCollect'?'import':'collect';setSourceMode(mode,{focus:true});
});
listen('dismissError','click',()=>error(null));
listen('preset','change',()=>{const preset=PRESETS[$('preset').value];if(preset)displaySettings({...collectionSettings(),...preset});});
for(const id of ['intervalMs','batchSize','timeoutMs','maxRetries'])listen(id,'change',()=>{$('preset').value='custom';});
listen('pause','click',async()=>{
    controller?.abort();
    if(controller&&canCollect){api.scripting.executeScript({target:{tabId:source.tabId},world:'MAIN',func:()=>window.__discordArchiverRequest?.abort()}).catch(()=>{});}
    await rpc('cancel');status('Stopping after the current disk operation…');
});
async function importFile(file){
    if(!file||busy)return;error(null);setBusy(true,'import');
    try{status('Importing archive',`${file.name} · ${bytes(file.size)}`);const job=await rpc('import',{file});currentJob=job;status('Import finished',`${fmt(job.count)} messages saved.`);}
    finally{setBusy(false);$('progress').hidden=true;await refreshJobs(currentJob?.id);if(currentJob)await chooseJob(currentJob.id);$('file').value='';}
}
listen('file','change',()=>importFile($('file').files[0]));
listen('fileDrop','dragover',event=>{event.preventDefault();if(!busy)$('fileDrop').classList.add('is-dragging');});
listen('fileDrop','dragleave',event=>{if(!event.relatedTarget||!$('fileDrop').contains(event.relatedTarget))$('fileDrop').classList.remove('is-dragging');});
listen('fileDrop','drop',async event=>{event.preventDefault();$('fileDrop').classList.remove('is-dragging');if(!busy)await importFile(event.dataTransfer.files[0]);});
listen('delete','click',async()=>{
    if(!currentJob||busy)return;
    if(!confirm(`Delete the local cache for “${currentJob.name}”? Downloaded files are kept.`))return;
    await rpc('delete',{jobId:currentJob.id});currentJob=null;$('preview').textContent='Choose another archive.';await refreshJobs();updateSummary();setBusy(false);status('Local archive cache deleted');
});
let searchTimer;
listen('userSearch','input',()=>{
    clearTimeout(searchTimer);const revision=++summaryRevision;
    searchTimer=setTimeout(async()=>{try{if(!currentJob||busy)return;const jobId=currentJob.id;const result=await rpc('summary',{jobId,search:$('userSearch').value});if(revision===summaryRevision&&currentJob?.id===jobId&&result.job.id===jobId)renderSummary(result);}catch(failure){error(failure);}},180);
});
for(const id of ['userSelect','previewFormat','skipEmpty','includeMedia','includeReplyText','pretty','htmlQuality','includeMachineData'])listen(id,'change',updatePreview);
for(const element of document.querySelectorAll('[name=format]'))element.addEventListener('change',updateFormatNote);
for(const id of ['pretty','gzip'])listen(id,'change',updateFormatNote);
listen('copyPreview','click',async()=>{
    if(busy||previewPending||!currentJob)return;
    try{if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');await navigator.clipboard.writeText($('preview').textContent);$('previewFeedback').textContent='Preview copied to clipboard.';}
    catch{$('previewFeedback').textContent='Select the preview text and copy it with your keyboard.';}
});
listen('downloadAll','click',()=>{if(busy)return;for(const link of $('downloads').querySelectorAll('a'))link.click();});
listen('export','click',async()=>{
    if(!currentJob||busy)return;
    const formats=[...document.querySelectorAll('[name=format]:checked')].map(e=>e.value);
    const splitMessages=Number($('splitMessages').value);
    if(!formats.length)throw new Error('Select at least one export format.');
    if(!Number.isSafeInteger(splitMessages)||splitMessages<0||splitMessages>1000000000)throw new Error('Messages per file must be a non-negative integer.');
    await saveSettings(false);error(null);setBusy(true,'export');status('Preparing downloads','Writing files in small batches. Downloads will appear below.');
    try{
        const result=await rpc('export',{jobId:currentJob.id,formats,options:exportOptions(),splitMessages,filename:$('filename').value});
        for(const file of result.files){
            const url=URL.createObjectURL(file.file);urls.add(url);
            const row=document.createElement('div');row.className='download';
            const link=document.createElement('a');link.href=url;link.download=file.name;link.textContent=file.name;
            const detail=document.createElement('span');detail.textContent=`${fmt(file.count)} messages · ${bytes(file.bytes)}`;
            row.append(link,detail);$('downloads').append(row);
            preparedFiles.push({name:file.name,bytes:file.bytes,count:file.count});
        }
        updateDownloads();
        status('Downloads ready',`${result.files.length} files. Click the links below the preview to save them.`);
    }finally{setBusy(false);$('progress').hidden=true;await refreshJobs(currentJob.id);}
});
listen('clearExports','click',async()=>{
    if(busy||!confirm('Clear all prepared export files and their download links, including other workspace tabs? Files already saved to your Downloads folder and archived message caches are kept.'))return;
    const result=await rpc('clearExports');for(const url of urls)URL.revokeObjectURL(url);urls.clear();$('downloads').replaceChildren();
    preparedFiles.length=0;updateDownloads();
    await refreshJobs(currentJob?.id);status('Prepared export files cleared',`${result.cleared} temporary files removed.`);
});

window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
window.addEventListener('unload',()=>{clearInterval(operationTimer);for(const url of urls)URL.revokeObjectURL(url);});

async function start(){
    setSourceMode(canCollect?'collect':'import');updateSummary();
    $('channel').textContent=canCollect?`Source: #${source.name}. Collection uses the original Discord tab.`:'Import a local archive, or open this workspace from a Discord channel to collect history.';
    setBusy(true,'init');
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
    updateFormatNote();const jobs=await refreshJobs();setBusy(false);status('Ready','Choose a source or return to a saved archive. Content stays on this device.');
    if(jobs.length)await chooseJob($('jobs').value);
}
start().catch(failure=>{error(failure);setBusy(false);$('collect').disabled=true;$('export').disabled=true;status('Workspace could not start','Check that the packaged WASM files are present and this browser supports local disk storage.');});
