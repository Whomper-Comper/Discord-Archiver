import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile,cp,rm} from 'node:fs/promises';
import {resolve,join,extname,relative,isAbsolute,sep} from 'node:path';
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
    server=createServer(async(req,res)=>{try{const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);const fromRoot=relative(root,path);if(isAbsolute(fromRoot)||fromRoot==='..'||fromRoot.startsWith('..'+sep))throw new Error('path');const data=await readFile(path);res.setHeader('Content-Type',({'.js':'application/javascript','.wasm':'application/wasm','.css':'text/css','.html':'text/html'}[extname(path)]||'application/octet-stream'));res.setHeader('Content-Security-Policy',"script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");res.end(data);}catch{res.statusCode=404;res.end('Not found');}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
}
const context=await chromium.launchPersistentContext(join(artifacts,'profile'),{...(process.env.TEST_BROWSER?{executablePath:process.env.TEST_BROWSER}:{}),headless:true,ignoreDefaultArgs:['--disable-extensions'],args:process.env.TEST_HTTP?[]:[`--disable-extensions-except=${staged}`,`--load-extension=${staged}`]});
try{
    const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin?`${origin}/workspace.html`:`chrome-extension://${extensionId}/workspace.html`);
    await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='Ready',null,{timeout:60000});
    assert.equal(await page.getByRole('tab',{name:'Organize a file',exact:true}).count(),1);
    assert.equal(await page.getByRole('tab',{name:'Organize a file',exact:true}).getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('#copyPreview').count(),1);
    await page.getByRole('tab',{name:'Organize a file',exact:true}).focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.getByRole('tab',{name:'Collect from Discord',exact:true}).getAttribute('aria-selected'),'true');
    await page.keyboard.press('End');
    assert.equal(await page.getByRole('tab',{name:'Organize a file',exact:true}).getAttribute('aria-selected'),'true');
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
    await page.getByRole('tab',{name:'Collect from Discord',exact:true}).click();
    await page.getByRole('tab',{name:'Organize a file',exact:true}).click();
    assert.equal(await page.locator('#userSelect').inputValue(),'id:102','switching source mode must preserve selected author');
    await page.locator('[name=format][value=compact]').uncheck();
    for(const format of ['full','cleaned','messages'])await page.locator(`[name=format][value=${format}]`).check();
    await page.locator('#export').click();
    await page.getByText('Downloads ready',{exact:true}).waitFor({timeout:60000});
    assert.equal(await page.locator('#downloads a').count(),3);
    const values=await page.locator('#downloads a').evaluateAll(async links=>Promise.all(links.map(async link=>({name:link.download,text:await (await fetch(link.href)).text()}))));
    assert.deepEqual(JSON.parse(values.find(v=>v.name.includes('-messages-')).text),['Reply <:party_blob:700>']);
    assert.equal(JSON.parse(values.find(v=>v.name.includes('-full-')).text).messages[0].author.id,'102');
    assert.equal(JSON.parse(values.find(v=>v.name.includes('-cleaned-')).text).messages[0].content,'Reply ');
    assert.equal(await page.locator('#downloadAll').isEnabled(),true);
    await page.locator('#copyPreview').click();
    await page.waitForFunction(()=>/clipboard|keyboard/.test(document.querySelector('#previewFeedback').textContent));
    for(const format of ['full','cleaned','messages'])await page.locator(`[name=format][value=${format}]`).uncheck();
    await page.locator('[name=format][value=compact]').check();
    await page.locator('.export-details > summary').click();
    await page.locator('#gzip').check();
    await page.locator('#export').click();
    await page.waitForFunction(()=>document.querySelectorAll('#downloads a').length===4);
    const zipped=await page.locator('#downloads a').last().evaluate(async link=>{
        const blob=await(await fetch(link.href)).blob();const reader=blob.stream().pipeThrough(new DecompressionStream('gzip'));return {name:link.download,text:await new Response(reader).text()};
    });
    assert.ok(zipped.name.endsWith('.json.gz'));assert.equal(JSON.parse(zipped.text).messages.length,1);
    await page.screenshot({path:join(artifacts,'workspace.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'narrow layout must not overflow horizontally');
    await page.screenshot({path:join(artifacts,'workspace-mobile.png'),fullPage:true});
    const dropped=await page.evaluateHandle(payload=>{
        const data=new DataTransfer();data.items.add(new File([JSON.stringify(payload)],'dropped.json',{type:'application/json'}));return data;
    },{schema_version:1,channel:{id:'20',name:'Dropped archive'},messages:[messages[0]]});
    await page.locator('#fileDrop').dispatchEvent('drop',{dataTransfer:dropped});
    await page.waitForFunction(()=>document.querySelector('#summaryArchive').textContent==='Dropped archive');
    assert.equal(await page.locator('#summaryMessages').textContent(),'1');
    assert.equal(await page.locator('#userSelect').inputValue(),'');
    await dropped.dispose();
    const baseId=await page.locator('#jobs').inputValue();
    await page.locator('.update-details > summary').click();
    await page.locator('#mergeFile').setInputFiles({name:'additional.json',mimeType:'application/json',buffer:Buffer.from(input)});
    await page.waitForFunction(()=>document.querySelector('#status').textContent==='Archive updated'&&document.querySelector('#summaryMessages').textContent==='3');
    assert.match(await page.locator('#details').textContent(),/2 added.*1 known duplicates/);
    assert.notEqual(await page.locator('#jobs').inputValue(),baseId);
    assert.ok(await page.locator('#jobs').evaluate((select,id)=>[...select.options].some(option=>option.value===id),baseId),'base archive is retained');
    assert.equal(await page.locator('#fetchNewer').isDisabled(),true,'live updating needs Discord context');
    const mergedId=await page.locator('#jobs').inputValue();
    await page.locator('#combineWith').selectOption(baseId);
    await page.locator('#combineSaved').click();
    await page.waitForFunction(id=>document.querySelector('#jobs').value!==id&&document.querySelector('#summaryMessages').textContent==='3',mergedId);
    assert.match(await page.locator('#details').textContent(),/0 added.*1 known duplicates/);
    await page.locator('#gzip').uncheck();
    const downloadCount=await page.locator('#downloads a').count();
    await page.locator('#export').click();
    await page.waitForFunction(count=>document.querySelectorAll('#downloads a').length>count,downloadCount);
    const combined=await page.locator('#downloads a').last().evaluate(async link=>JSON.parse(await(await fetch(link.href)).text()));
    assert.equal(combined.messages.length,3);
    assert.deepEqual(combined.messages.map(message=>message.i),['1003','1004','1005']);
    // Exercise live-update orchestration with synthetic pages; no Discord account/network.
    const updateBaseId=await page.locator('#jobs').inputValue();
    const updatePage=await context.newPage();
    await updatePage.addInitScript(seed=>{
        window.syntheticRequests=[];
        window.browser={storage:{local:{get:async()=>({}),set:async()=>{}}},scripting:{executeScript:async request=>{
            if(!request.args)return [];
            window.syntheticRequests.push(request.args);
            return [{result:{ok:true,status:200,messages:[{...seed,id:'1007',content:'newest'},{...seed,id:'1006',content:'newer'},{...seed,id:'1005'}],rate:{}}}];
        }}};
    },messages[0]);
    await updatePage.goto((origin?`${origin}/workspace.html`:`chrome-extension://${extensionId}/workspace.html`)+'?tabId=123&channelId=20&name=Test');
    await updatePage.waitForFunction(()=>document.querySelector('#status')?.textContent==='Ready');
    await updatePage.locator('#jobs').selectOption(updateBaseId);
    await updatePage.locator('#load').click();
    await updatePage.locator('.update-details > summary').click();
    await updatePage.locator('#fetchNewer').click();
    await updatePage.waitForFunction(()=>document.querySelector('#status').textContent==='Archive updated'&&document.querySelector('#summaryMessages').textContent==='5');
    assert.equal(await updatePage.evaluate(()=>syntheticRequests.length),1);
    assert.match(await updatePage.locator('#details').textContent(),/2 added/);
    assert.doesNotMatch(await updatePage.locator('#summaryState').textContent(),/partial/);
    assert.ok(await updatePage.locator('#jobs').evaluate((select,id)=>[...select.options].some(option=>option.value===id),updateBaseId));
    await updatePage.close();
    await page.setViewportSize({width:1280,height:900});
    await page.screenshot({path:join(artifacts,'workspace.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:join(artifacts,'workspace-mobile.png'),fullPage:true});
    page.once('dialog',dialog=>dialog.accept());await page.locator('#clearExports').click();
    await page.waitForFunction(()=>document.querySelectorAll('#downloads a').length===0&&document.querySelector('#downloadPanel').hidden);
    assert.deepEqual(errors,[]);
    await writeFile(join(artifacts,'result.json'),JSON.stringify({scope:origin?'secure localhost workspace with production CSP':'actual MV3 extension',browser:context.browser().version(),extensionId,tests:['compact-only defaults','real Rust/WASM import','IndexedDB persistence','duplicate-name user filtering','cleaned reply context','pinned user selection during search','OPFS multi-format exports','streaming gzip compact download','file merge with dedup and originals retained','saved archive combine and compact export','newer-message collection with synthetic pages','keyboard and narrow layout'],passed:true},null,2));
    console.log(`Browser smoke: passed (${origin?'secure localhost workspace with production CSP':'real MV3 extension'}, Rust/WASM, IndexedDB, OPFS, filtering, compact defaults and gzip).`);
}finally{await context.close();if(server)await new Promise(resolve=>server.close(resolve));}
