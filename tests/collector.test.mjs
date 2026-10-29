import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSettings,runCollection,withCaptureJobLock} from '../collector.js';

const msg = (id,user='101',date='2026-10-28T12:00:00Z') => ({id,author:{id:user,username:user},timestamp:date,content:`message ${id}`});
const ok = (messages,rate={}) => ({ok:true,status:200,messages,rate});
const defaults = () => normalizeSettings({batchSize:100,intervalMs:0,maxMessages:0,maxRetries:2,timeoutMs:30000});

test('settings reject invalid limits, dates and IDs and retain defaults', () => {
    assert.equal(normalizeSettings({}).batchSize,100);
    for (const raw of [{batchSize:101},{intervalMs:-1},{maxRetries:20},{maxMessages:-1},{beforeId:'oops'},{afterDate:'not-a-date'},{afterDate:'2026-11-01',beforeDate:'2026-10-01'}]) {
        assert.throws(()=>normalizeSettings(raw));
    }
});

test('paginates sequentially with a fetched cap and commits each cursor', async () => {
    const calls=[],saved=[];
    const result=await runCollection({settings:{...defaults(),maxMessages:3,batchSize:2},fetchPage:async(before,limit)=>{
        calls.push([before,limit]); return ok(before?[msg('1')]:[msg('3'),msg('2')]);
    },saveBatch:async(messages,checkpoint)=>saved.push({messages,checkpoint}),sleep:async()=>{}});
    assert.deepEqual(calls,[[null,2],['2',1]]);
    assert.equal(result.scanned,3);
    assert.equal(result.cursor,'1');
    assert.equal(result.status,'ready');
    assert.equal(saved[1].checkpoint.scanned,3);
});

test('honors exhausted bucket and 429 retry-after even in adaptive mode', async () => {
    const waits=[],responses=[ok([msg('3')],{remaining:0,resetAfter:1.5}),{ok:false,status:429,rate:{retryAfter:2},error:'rate limited'},ok([])];
    await runCollection({settings:defaults(),fetchPage:async()=>responses.shift(),saveBatch:async()=>{},sleep:async ms=>waits.push(ms)});
    assert.ok(waits[0]>=1500);
    assert.ok(waits[1]>=2000);
});

test('user filtering still advances scanned cursor and lower UTC date stops pagination', async () => {
    const saved=[]; let requests=0;
    const result=await runCollection({settings:{...defaults(),userIds:['101'],afterDate:'2026-10-28'},fetchPage:async()=>{
        requests++;return ok([msg('3','102'),msg('2','101'),msg('1','101','2026-10-27T23:59:00Z')]);
    },saveBatch:async(messages,checkpoint)=>saved.push({messages,checkpoint}),sleep:async()=>{}});
    assert.equal(requests,1);
    assert.deepEqual(saved[0].messages.map(m=>m.id),['2']);
    assert.equal(result.scanned,3);
    assert.equal(result.status,'ready');
});

test('authentication stops immediately while transient errors have bounded retries', async () => {
    for (const status of [401,403]) {
        let calls=0;
        await assert.rejects(runCollection({settings:defaults(),fetchPage:async()=>{calls++;return {ok:false,status,error:'denied',rate:{}};},saveBatch:async()=>{},sleep:async()=>{}}));
        assert.equal(calls,1);
    }
    let calls=0;
    await assert.rejects(runCollection({settings:defaults(),fetchPage:async()=>{calls++;return {ok:false,status:503,error:'offline',rate:{}};},saveBatch:async()=>{},sleep:async()=>{}}));
    assert.equal(calls,3);
});

test('resumes original cursor, pauses after cancellation, and rejects stalled pagination', async () => {
    const abort = new AbortController(); const calls=[];
    const result=await runCollection({settings:defaults(),cursor:'10',scanned:100,signal:abort.signal,fetchPage:async before=>{calls.push(before);return ok([msg('9')]);},saveBatch:async()=>abort.abort(),sleep:async()=>{}});
    assert.deepEqual(calls,['10']);
    assert.equal(result.status,'paused');
    assert.equal(result.scanned,101);
    await assert.rejects(runCollection({settings:defaults(),cursor:'10',fetchPage:async()=>ok([msg('10')]),saveBatch:async()=>{},sleep:async()=>{}}),/advance|cursor/i);
});

test('a missing retry-after value uses the conservative five-second fallback',async()=>{
    const waits=[],responses=[{ok:false,status:429,rate:{retryAfter:null}},ok([])];
    await runCollection({settings:defaults(),fetchPage:async()=>responses.shift(),saveBatch:async()=>{},sleep:async ms=>waits.push(ms)});
    assert.ok(waits[0]>=5000);
});

test('a capture job can only be resumed by one workspace even from different tabs',async()=>{
    const held=new Set();const locks={async request(name,options,callback){if(held.has(name))return callback(null);held.add(name);try{return await callback({name});}finally{held.delete(name);}}};
    let release;const gate=new Promise(resolve=>{release=resolve;});
    const first=withCaptureJobLock(locks,'same-job',()=>gate);
    await assert.rejects(withCaptureJobLock(locks,'same-job',async()=>{}),/already|collecting|workspace/i);
    await withCaptureJobLock(locks,'other-job',async()=>{});
    release();await first;
    await withCaptureJobLock(locks,'same-job',async()=>{});
});

test('incremental updates stop at the known newest message ID and keep only newer messages',async()=>{
    const calls=[],saved=[];
    const result=await runCollection({settings:{...defaults(),afterId:'2'},fetchPage:async(before,limit)=>{calls.push([before,limit]);return ok(calls.length===1?[msg('4'),msg('3'),msg('2'),msg('1')]:[]);},saveBatch:async(messages,checkpoint)=>saved.push({messages,checkpoint}),sleep:async()=>{}});
    assert.equal(calls.length,1);
    assert.deepEqual(saved[0].messages.map(message=>message.id),['4','3']);
    assert.equal(result.reason,'boundary');
    assert.equal(result.scanned,4);
    assert.equal(result.cursor,'1');
    assert.throws(()=>normalizeSettings({afterId:'bad-id'}));
});
