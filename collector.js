export const PRESETS = {
    adaptive: {intervalMs:0,batchSize:100,timeoutMs:30000,maxRetries:5},
    balanced: {intervalMs:500,batchSize:100,timeoutMs:30000,maxRetries:5},
    gentle: {intervalMs:1200,batchSize:100,timeoutMs:60000,maxRetries:5}
};
export async function withCaptureJobLock(locks,jobId,operation){
    if(!locks?.request)throw new Error('This browser cannot lock collection jobs.');
    return locks.request(`discord-archiver-job-${jobId}`,{ifAvailable:true},lock=>{
        if(!lock)throw new Error('Another workspace is already collecting this archive job.');
        return operation();
    });
}

export function normalizeSettings(raw = {}) {
    const result={...PRESETS.balanced,maxMessages:0,afterDate:'',beforeDate:'',beforeId:'',userIds:[],...raw};
    for (const [key,min,max] of [['batchSize',1,100],['intervalMs',0,60000],['timeoutMs',1000,120000],['maxRetries',0,10],['maxMessages',0,1000000000]]) {
        const value=Number(result[key]);
        if (!Number.isSafeInteger(value)||value<min||value>max) throw new Error(`${key} must be an integer from ${min} to ${max}.`);
        result[key]=value;
    }
    for (const key of ['afterDate','beforeDate']) {
        result[key]=String(result[key]||'');
        if (result[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(result[key]) || !Number.isFinite(Date.parse(result[key])) || new Date(result[key]).toISOString().slice(0,10)!==result[key] || Date.parse(result[key])<1420070400000)) throw new Error(`${key} must be a valid UTC date in 2015 or later.`);
    }
    if (result.afterDate && result.beforeDate && result.afterDate>=result.beforeDate) throw new Error('The start date must be before the end date.');
    result.beforeId=String(result.beforeId||'').trim();
    if (result.beforeId && !/^\d{1,20}$/.test(result.beforeId)) throw new Error('Starting message ID must contain only digits.');
    const ids=Array.isArray(result.userIds)?result.userIds:String(result.userIds||'').split(/[\s,]+/);
    result.userIds=[...new Set(ids.map(String).map(s=>s.trim()).filter(Boolean))];
    if (result.userIds.some(id=>!/^\d{1,20}$/.test(id))) throw new Error('User IDs must contain only digits, separated by commas or spaces.');
    return result;
}

export function abortableSleep(ms,signal) {
    return new Promise((resolve,reject)=>{
        if (signal?.aborted) return reject(new DOMException('Paused','AbortError'));
        const abort=()=>{clearTimeout(timer);reject(new DOMException('Paused','AbortError'));};
        const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
        signal?.addEventListener('abort',abort,{once:true});
    });
}

export async function runCollection({settings:raw,cursor=null,scanned=0,fetchPage,saveBatch,onProgress=()=>{},signal,sleep=abortableSleep}) {
    const settings=normalizeSettings(raw);
    const after=settings.afterDate?Date.parse(settings.afterDate):null;
    const before=settings.beforeDate?Date.parse(settings.beforeDate):null;
    if (!cursor) {
        cursor=settings.beforeId||null;
        if (before!==null) {
            const dateCursor=((BigInt(before)-1420070400000n)<<22n).toString();
            if (!cursor||BigInt(dateCursor)<BigInt(cursor)) cursor=dateCursor;
        }
    }
    const users=new Set(settings.userIds);
    let retries=0;
    try {
        while (!signal?.aborted) {
            if (settings.maxMessages && scanned>=settings.maxMessages) return {status:'ready',cursor,scanned,reason:'limit'};
            const limit=settings.maxMessages?Math.min(settings.batchSize,settings.maxMessages-scanned):settings.batchSize;
            let response;
            try {response=await fetchPage(cursor,limit,settings.timeoutMs);}
            catch(error) {if(signal?.aborted) break;response={ok:false,status:0,error:String(error.message||error),rate:{}};}
            if (signal?.aborted) break;
            if (!response.ok) {
                if (response.status===401||response.status===403) throw new Error(`Discord ${response.status}: ${response.error||'access denied'}. Saved progress can be resumed after access is restored.`);
                const transient=response.status===0||response.status===429||response.status>=500;
                if (!transient||retries>=settings.maxRetries) throw new Error(`Discord ${response.status||'network error'}: ${response.error||'request failed'}. Retry limit reached; saved progress is preserved.`);
                retries++;
                const retryAfter=response.rate?.retryAfter;
                const seconds=retryAfter===null||retryAfter===undefined?NaN:Number(retryAfter);
                const delay=response.status===429?Math.max(1000,Number.isFinite(seconds)&&seconds>=0?seconds*1000+100:5000):Math.min(30000,500*2**(retries-1));
                onProgress({status:response.status===429?'Rate limited; waiting for Discord.':'Retrying a temporary error.',scanned,cursor,delay});
                await sleep(Math.max(settings.intervalMs,delay),signal);
                continue;
            }
            retries=0;
            if (!Array.isArray(response.messages)) throw new Error('Discord returned an invalid message page.');
            const messages=response.messages.slice(0,limit);
            if (!messages.length) return {status:'ready',cursor,scanned,reason:'history'};
            const next=messages.at(-1)?.id;
            if (typeof next!=='string'||!/^\d{1,20}$/.test(next)||cursor&&BigInt(next)>=BigInt(cursor)) throw new Error('Discord pagination cursor did not advance; stopped to preserve saved progress.');
            let reachedStart=false;
            const selected=[];
            for (const message of messages) {
                const time=Date.parse(message.timestamp);
                if (!Number.isFinite(time)) throw new Error('A message has an invalid timestamp; page was not committed.');
                if (after!==null&&time<after) {reachedStart=true;continue;}
                if (before!==null&&time>=before) continue;
                if (users.size&&!users.has(message.author?.id)) continue;
                selected.push(message);
            }
            const nextScanned=scanned+messages.length;
            // Backpressure: checkpoint advances only after the worker's disk commit.
            await saveBatch(selected,{cursor:next,scanned:nextScanned,status:'collecting'});
            cursor=next;scanned=nextScanned;
            onProgress({status:'Collecting',scanned,cursor});
            if (reachedStart) return {status:'ready',cursor,scanned,reason:'date'};
            if (settings.maxMessages&&scanned>=settings.maxMessages) return {status:'ready',cursor,scanned,reason:'limit'};
            let delay=settings.intervalMs;
            const rate=response.rate||{};
            if (rate.remaining===0&&Number.isFinite(rate.resetAfter)&&rate.resetAfter>=0) delay=Math.max(delay,rate.resetAfter*1000+100);
            if (delay) await sleep(delay,signal);
        }
    } catch (error) {
        if (!signal?.aborted) throw error;
    }
    return {status:'paused',cursor,scanned,reason:'paused'};
}

// Self-contained: browser.scripting serializes this function into Discord MAIN.
// Return page data and rate metadata only; never return or store its token.
export async function fetchDiscordPage(channelId,before,limit,timeoutMs) {
    if (!/(^|\.)discord\.com$/.test(location.hostname) || location.pathname.match(/^\/channels\/(?:@me|\d+)\/(\d+)/)?.[1]!==channelId) throw new Error('Open the original Discord channel before collecting or resuming.');
    const chunks=window.webpackChunkdiscord_app;
    if (!chunks?.push) throw new Error('Discord is not ready; reload the channel.');
    let token=null;
    const chunk=[[Math.random()],{},req=>{
        for (const module of Object.values(req.c||{})) {
            const exp=module.exports;
            const getter=exp?.default?.getToken||exp?.getToken;
            if (typeof getter==='function') {const value=getter();if(typeof value==='string'&&value.length>50){token=value;break;}}
        }
    }];
    chunks.push(chunk);
    if (chunks.at(-1)===chunk) chunks.pop();
    if (!token) throw new Error('Discord session was unavailable; reload the channel.');
    const controller=new AbortController();
    window.__discordArchiverRequest=controller;
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
        const url=new URL(`/api/v10/channels/${channelId}/messages`,location.origin);
        url.searchParams.set('limit',String(limit));
        if(before)url.searchParams.set('before',before);
        const response=await fetch(url,{headers:{Authorization:token},signal:controller.signal});
        const body=await response.json().catch(()=>null);
        const numeric=name=>{const raw=response.headers.get(name);return raw===null?null:(Number.isFinite(Number(raw))?Number(raw):null);};
        const retries=[numeric('Retry-After'),typeof body?.retry_after==='number'?body.retry_after:null].filter(v=>v!==null&&v>=0);
        return {ok:response.ok,status:response.status,messages:response.ok?body:undefined,error:response.ok?undefined:String(body?.message||`HTTP ${response.status}`),rate:{remaining:numeric('X-RateLimit-Remaining'),resetAfter:numeric('X-RateLimit-Reset-After'),retryAfter:retries.length?Math.max(...retries):null}};
    } finally {
        clearTimeout(timer);token=null;
        if(window.__discordArchiverRequest===controller)delete window.__discordArchiverRequest;
    }
}
