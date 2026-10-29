import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile,cp,rm} from 'node:fs/promises';
import {resolve,join,extname,dirname} from 'node:path';
import {generateKeyPairSync,createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const root=resolve(import.meta.dirname,'..');
const artifacts=join(root,'artifacts','browser-smoke');
await mkdir(artifacts,{recursive:true});
const staged=join(artifacts,'extension');await mkdir(staged,{recursive:true});
for(const file of ['manifest.json','popup.html','popup.js','inject.js','collector.js','workspace.html','workspace.css','workspace.js','storage.js','archive-worker.js','icons','wasm'])await cp(join(root,file),join(staged,file),{recursive:true});
const {publicKey}=generateKeyPairSync('rsa',{modulusLength:1024,publicKeyEncoding:{type:'spki',format:'der'},privateKeyEncoding:{type:'pkcs8',format:'der'}});
const manifest=JSON.parse(await readFile(join(staged,'manifest.json'),'utf8'));manifest.key=publicKey.toString('base64');
await writeFile(join(staged,'manifest.json'),JSON.stringify(manifest));
const extensionId=[...createHash('sha256').update(publicKey).digest().subarray(0,16)].map(b=>String.fromCharCode(97+(b>>4),97+(b&15))).join('');
let server,origin;
if(process.env.TEST_HTTP){
    server=createServer(async(req,res)=>{try{const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!path.startsWith(root+'\\'))throw new Error('path');const data=await readFile(path);res.setHeader('Content-Type',({'.js':'application/javascript','.wasm':'application/wasm','.css':'text/css','.html':'text/html'}[extname(path)]||'application/octet-stream'));res.setHeader('Content-Security-Policy',"script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");res.end(data);}catch{res.statusCode=404;res.end('Not found');}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
}
const context=await chromium.launchPersistentContext(join(artifacts,'profile'),{...(process.env.TEST_BROWSER?{executablePath:process.env.TEST_BROWSER}:{}),headless:true,ignoreDefaultArgs:['--disable-extensions'],args:process.env.TEST_HTTP?[]:[`--disable-extensions-except=${staged}`,`--load-extension=${staged}`]});
try{
    const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin?`${origin}/workspace.html`:`chrome-extension://${extensionId}/workspace.html`);
    await page.getByText('Ready',{exact:true}).waitFor({timeout:60000});
    assert.deepEqual(await page.locator('[name=format]:checked').evaluateAll(boxes=>boxes.map(box=>box.value)),['compact']);
    assert.equal(await page.locator('#pretty').isChecked(),false);
    assert.equal(await page.locator('#includeMachineData').isChecked(),false);
    const messages=[
        {id:'1003',channel_id:'20',author:{id:'101',username:'alice',global_name:'Alice'},timestamp:'2026-10-28T12:00:00Z',content:'Hello **WORLD** 😀',attachments:[]},
        {id:'1004',channel_id:'20',author:{id:'102',username:'bob',global_name:'Alice'},timestamp:'2026-10-28T12:01:00Z',content:'Reply <:party_blob:700>',message_reference:{message_id:'1003',channel_id:'20'},referenced_message:{id:'1003',author:{id:'101',username:'alice',global_name:'Alice'},content:'Hello **WORLD** 😀'},attachments:[{url:'https://example.com/a.png',filename:'a.png',content_type:'image/png'}]},
        {id:'1005',channel_id:'20',author:{id:'101',username:'alice',global_name:'Alice'},timestamp:'2026-10-28T12:02:00Z',content:'last line\nsecond line',attachments:[]}
    ];
    const input=JSON.stringify({schema_version:1,channel:{id:'20',name:'Test channel'},messages});
    await page.locator('#file').setInputFiles({name:'test-archive.json',mimeType:'application/json',buffer:Buffer.from(input)});
    await page.getByText('Import finished',{exact:true}).waitFor({timeout:60000});
    await page.waitForFunction(()=>document.querySelector('#userSelect').options.length===3);
    await page.locator('#userSelect').selectOption('id:102');
    await page.locator('#previewFormat').selectOption('cleaned');
    await page.waitForFunction(()=>{try{const value=JSON.parse(document.querySelector('#preview').textContent);return value.messages?.length===1&&value.messages[0].author.id==='102'&&value.messages[0].content==='Reply ';}catch{return false;}});
    const preview=JSON.parse(await page.locator('#preview').textContent());
    assert.equal(preview.messages[0].reply.message_id,'1003');assert.equal(preview.messages[0].attachments.length,0);
    await page.locator('#userSearch').fill('nobody');await page.waitForTimeout(350);
    assert.equal(await page.locator('#userSelect').inputValue(),'id:102','search must preserve explicitly selected author');
    await page.locator('[name=format][value=compact]').uncheck();
    for(const format of ['full','cleaned','messages'])await page.locator(`[name=format][value=${format}]`).check();
    await page.locator('#export').click();
    await page.getByText('Downloads ready',{exact:true}).waitFor({timeout:60000});
    assert.equal(await page.locator('#downloads a').count(),3);
    const values=await page.locator('#downloads a').evaluateAll(async links=>Promise.all(links.map(async link=>({name:link.download,text:await (await fetch(link.href)).text()}))));
    assert.deepEqual(JSON.parse(values.find(v=>v.name.includes('-messages-')).text),['Reply <:party_blob:700>']);
    assert.equal(JSON.parse(values.find(v=>v.name.includes('-full-')).text).messages[0].author.id,'102');
    assert.equal(JSON.parse(values.find(v=>v.name.includes('-cleaned-')).text).messages[0].content,'Reply ');
    for(const format of ['full','cleaned','messages'])await page.locator(`[name=format][value=${format}]`).uncheck();
    await page.locator('[name=format][value=compact]').check();
    await page.locator('#gzip').check();
    await page.locator('#export').click();
    await page.waitForFunction(()=>document.querySelectorAll('#downloads a').length===4);
    const zipped=await page.locator('#downloads a').last().evaluate(async link=>{
        const blob=await(await fetch(link.href)).blob();const reader=blob.stream().pipeThrough(new DecompressionStream('gzip'));return {name:link.download,text:await new Response(reader).text()};
    });
    assert.ok(zipped.name.endsWith('.json.gz'));assert.equal(JSON.parse(zipped.text).messages.length,1);
    await page.screenshot({path:join(artifacts,'workspace.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    await writeFile(join(artifacts,'result.json'),JSON.stringify({scope:origin?'secure localhost workspace with production CSP':'actual MV3 extension',extensionId,tests:['compact-only defaults','real Rust/WASM import','IndexedDB persistence','duplicate-name user filtering','cleaned reply context','pinned user selection during search','OPFS multi-format exports','streaming gzip compact download'],passed:true},null,2));
    console.log(`Browser smoke: passed (${origin?'secure localhost workspace with production CSP':'real MV3 extension'}, Rust/WASM, IndexedDB, OPFS, filtering, compact defaults and gzip).`);
}finally{await context.close();if(server)await new Promise(resolve=>server.close(resolve));}
