/** Actual MV3 capture, with continuous viewport/visibility observations. Mock transport only. */
import {chromium} from 'playwright-core';
import {createFilmStaticServer} from './web-static-server.mjs';
import {resolve,join} from 'node:path';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
const root=resolve(import.meta.dirname,'../../..');const bu=resolve(root,'../fde2e-bu-v1');
const {MockOmniServer,waitFor}=await import(join(bu,'apps/extension/scripts/lib/mock-omni.mjs'));
const evidence=process.env.FILM_FLICKER_EVIDENCE||`/tmp/film-flicker-${process.pid}`;const seconds=Number(process.env.FILM_FLICKER_SECONDS||2);
const fps=Number(process.env.FILM_FPS||24);const stage={w:Number(process.env.FILM_STAGE_W||1280),h:Number(process.env.FILM_STAGE_H||720)};
await mkdir(join(evidence,'img'),{recursive:true});
const native=process.env.FILM_NATIVE_VIEWPORT==='1';
const captureOverride=process.env.FILM_FORCE_BEYOND==='1'?true:process.env.FILM_NO_BEYOND==='1'?false:null;
if(process.env.FILM_EXPECT_STABLE==='1')assert.equal(captureOverride,null,'stable gate must exercise unmodified production capture');
const profile=`/tmp/film-flicker-chrome-${process.pid}`;const mock=new MockOmniServer();const mockBase=await mock.listen(13744);
const server=await createFilmStaticServer({dir:resolve(root,'packages/openfilm/studio/ui/dist'),port:13686});
const cross=process.env.FILM_CROSS_ORIGIN==='1'?createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><body style="margin:0;background:rgb(226,52,86)">Cross-origin pixels</body>')):null;
if(cross)await new Promise(r=>cross.listen(13688,'127.0.0.1',r));
let context;let page,sw;const captureSessions=[];const visual=[];let visualDropped=0;let screenCaptureWork=Promise.resolve();
const record=async(target,label)=>{
 const session=await context.newCDPSession(target);captureSessions.push(session);
 session.on('Page.screencastFrame',ev=>{
  void session.send('Page.screencastFrameAck',{sessionId:ev.sessionId}).catch(()=>{});
  if(visual.length>=12000){visualDropped++;return;}
  const n=visual.length;const file=`img/${label}-${String(n).padStart(4,'0')}.png`;
  visual.push({n,file,target:label,t:Date.now(),metadata:ev.metadata});
  screenCaptureWork=screenCaptureWork.then(()=>writeFile(join(evidence,file),Buffer.from(ev.data,'base64')));
 });
 await session.send('Page.startScreencast',{format:'png',maxWidth:640,maxHeight:360,everyNthFrame:1});
};
try {
 context=await chromium.launchPersistentContext(profile,{...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{channel:'chromium'}),headless:false,viewport:native?null:{width:1440,height:900},...(!native?{deviceScaleFactor:Number(process.env.FILM_DPR||1)}:{}),args:[`--disable-extensions-except=${bu}/apps/extension`,`--load-extension=${bu}/apps/extension`,'--enable-blink-features=WebMCP','--autoplay-policy=no-user-gesture-required']});
 await context.addInitScript(()=>{
  const a=window.__flicker={url:location.href,events:[],frames:0,last:null,scroll:[]};
  const state=()=>({w:innerWidth,h:innerHeight,x:scrollX,y:scrollY,visible:document.visibilityState,focus:document.hasFocus()});
  for(const type of ['resize','scroll','focus','blur','pageshow','pagehide','visibilitychange'])addEventListener(type,()=>a.events.push({type,t:performance.now(),...state()}));
  function poll(){a.frames++;if(a.frames%30===0&&document.scrollingElement)a.scroll.push({t:performance.now(),w:document.scrollingElement.scrollWidth,h:document.scrollingElement.scrollHeight});const s=JSON.stringify(state());if(s!==a.last){a.events.push({type:'sample',t:performance.now(),...state()});a.last=s;}requestAnimationFrame(poll);}requestAnimationFrame(poll);
 });
 context.on('page',p=>{p.on('pageerror',e=>console.log('pageerror',p.url(),e.message));});
 sw=await waitFor(()=>context.serviceWorkers().find(w=>w.url().includes('background.js')),{timeout:20000});
 const options=await context.newPage();await options.goto(`chrome-extension://${new URL(sw.url()).host}/dist/options.html`);
 await options.evaluate(async base=>{const r=await chrome.runtime.sendMessage({type:'bu:bind',link:base+'/link/flicker',role:'master'});if(r?.ok===false)throw Error(JSON.stringify(r));},mockBase);
 await waitFor(()=>mock.conn('flicker')?.welcomed,{timeout:20000});
 const run=async command=>{const r=await mock.command('flicker',command);assert.equal(r.ok,true,JSON.stringify(r));return r;};
 await run({cmd:'windowCreate',url:'http://127.0.0.1:13686/index-web.html',windowTaskId:'flicker',width:1440,height:1000});
 page=await waitFor(()=>context.pages().find(p=>p.url().includes(':13686')),{timeout:20000});
 await waitFor(async()=>{const r=await run({cmd:'webmcp_list'});return r.tools?.length===44;},{timeout:30000});
 const call=async(name,args={})=>{const r=await run({cmd:'webmcp_call',name,args,origin:'http://127.0.0.1:13686',timeoutMs:60000});const v=JSON.parse(r.result);assert(!v.error,JSON.stringify(v));return v;};
 const project=await call('projects_create',{name:'Export visibility regression'});await call('projects_open',{id:project.id});
 await call('edit_write_page',{path:'scene.html',text:`<!doctype html><body style="margin:0;background:#142b43;color:white"><div id="box" style="position:absolute;top:160px;left:100px;width:160px;height:160px;background:#e0b45b"></div><h1 style="position:absolute;left:80px;top:50px;font:70px sans-serif">FDE2E Film</h1><script>window.film={duration:30,width:${stage.w},height:${stage.h},frame(t){document.getElementById('box').style.transform='translateX('+t*25+'px)'}}<\/script>`});
 await call('edit_insert_clip',{src:'scene.html',time:[0,30],newTrack:1,at:0});await call('edit_set_stage',stage);
 if(cross){const existing=await call('projects_read_file',{path:'scene.html',length:65536});await call('edit_write_page',{path:'scene.html',expect:Buffer.from(existing.dataBase64,'base64').toString(),text:`<!doctype html><body style="margin:0"><iframe src="http://127.0.0.1:13688/cross.html" style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe><script>window.film={duration:30,width:${stage.w},height:${stage.h},frame(){}}<\/script>`});}
 const audio=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=30','-f','wav','pipe:1'],{maxBuffer:8*1024*1024});
 await mkdir(resolve(root,'packages/openfilm/studio/ui/dist/flicker-fixture'),{recursive:true});await writeFile(resolve(root,'packages/openfilm/studio/ui/dist/flicker-fixture/tone.wav'),audio);
 const media=await call('projects_import_media',{url:'http://127.0.0.1:13686/flicker-fixture/tone.wav',name:'tone.wav'});await call('edit_insert_clip',{src:media.path,time:[0,30],newTrack:2,at:0});
 await page.waitForSelector('.stage iframe[title="film"]');
 await page.screenshot({path:join(evidence,'img/before.png')});
 await sw.evaluate((captureOverride)=>{
  globalThis.__flickerBridge={commands:[],focus:[],captures:0};
  chrome.windows.onFocusChanged.addListener(id=>globalThis.__flickerBridge.focus.push({id,t:Date.now()}));
  const original=chrome.debugger.sendCommand.bind(chrome.debugger);
  chrome.debugger.sendCommand=async(target,method,params)=>{
   if(method==='Page.captureScreenshot'){
    globalThis.__flickerBridge.captures++;
    if(captureOverride!==null)params={...params,captureBeyondViewport:captureOverride};
    const before=await chrome.scripting.executeScript({target:{tabId:target.tabId},world:'MAIN',func:()=>({resizeCount:window.__flicker.events.filter(e=>e.type==='resize').length,t:Date.now()})});
    const result=await original(target,method,params);
    const r=await chrome.scripting.executeScript({target:{tabId:target.tabId},world:'MAIN',func:()=>{const o=window.__flicker;return {url:location.href,frames:o.frames,events:o.events.slice(-4),resizeCount:o.events.filter(e=>e.type==='resize').length,viewport:{w:innerWidth,h:innerHeight,dpr:devicePixelRatio}}}});
    globalThis.__flickerBridge.commands.push({method,target,params,before:before[0]?.result,afterTime:Date.now(),observation:r[0]?.result});return result;
   }
   if(method==='Emulation.setDeviceMetricsOverride'||method==='Page.bringToFront')globalThis.__flickerBridge.commands.push({method,target,params});
   return original(target,method,params);
  };
 },captureOverride);
 await page.evaluate(()=>{window.__flicker.events=[];window.__flicker.frames=0;});
 if(process.env.FILM_CANCEL_CHECK==='1'){
 const cancelled=await call('produce_render',{kind:'video',codec:'h264',from:0,to:30,fps:24,shortEdge:720,audio:false,wait:false});
 await waitFor(async()=>{const j=(await call('produce_export_status')).jobs.find(j=>j.id===cancelled.jobId);return j?.framesDone>=3;},{timeout:30000,interval:200});
 const cancelAt=Date.now();await call('produce_cancel_export',{jobId:cancelled.jobId});
 const cancelFinal=await waitFor(async()=>{const j=(await call('produce_export_status')).jobs.find(j=>j.id===cancelled.jobId);return ['cancelled','done','failed'].includes(j?.status)?j:null;},{timeout:10000,interval:200,what:'cancel terminal'});console.log('cancel',JSON.stringify(cancelFinal));assert.equal(cancelFinal.status,'cancelled');await writeFile(join(evidence,'cancellation.json'),JSON.stringify({job:cancelFinal,latencyMs:Date.now()-cancelAt},null,2));
 await waitFor(()=>context.pages().filter(p=>p.url().includes('film-render=')).length===0,{timeout:10000});
 await page.screenshot({path:join(evidence,'img/cancelled.png')});
 await sw.evaluate(()=>{__flickerBridge.commands=[];__flickerBridge.captures=0;__flickerBridge.focus=[];});
 await page.evaluate(()=>{__flicker.events=[];__flicker.scroll=[];});
 }
 await record(page,'editor');
 const job=await call('produce_render',{kind:'video',codec:'h264',from:0,to:seconds,fps,shortEdge:720,audio:true,wait:false});
 const renderPage=await waitFor(()=>context.pages().find(p=>p.url().includes('film-render=')),{timeout:30000,what:'render page'});
 await record(renderPage,'surface');
 await page.screenshot({path:join(evidence,'img/during.png')});
 const final=await waitFor(async()=>{const j=(await call('produce_export_status')).jobs.find(j=>j.id===job.jobId);return ['done','failed','cancelled'].includes(j?.status)?j:null;},{timeout:180000,interval:500,what:'export terminal'});
 await Promise.all(captureSessions.map(s=>s.send('Page.stopScreencast').catch(()=>{})));await screenCaptureWork;await writeFile(join(evidence,'visual-frames.json'),JSON.stringify(visual,null,2));
 const bridge=await sw.evaluate(()=>globalThis.__flickerBridge);const editor=await page.evaluate(()=>window.__flicker);
 const windows=await run({cmd:'windowList'});
 await page.screenshot({path:join(evidence,'img/after.png')});
 const result={final,editor,bridge,windows,visualDropped,environment:{captureOverride,stage,seconds,fps,browser:context.browser()?.version(),native,dpr:await page.evaluate(()=>devicePixelRatio)}};await writeFile(join(evidence,'result.json'),JSON.stringify(result,null,2));
 const observations=bridge.commands.filter(c=>c.observation);const captureResizes=observations.at(-1).observation.resizeCount-observations[0].before.resizeCount;
 console.log(JSON.stringify({status:final.status,frames:final.framesDone,captures:bridge.captures,focus:bridge.focus,editorEvents:editor.events,captureResizes,visualFrames:visual.length,editorScrollSizes:[...new Set(editor.scroll.map(v=>v.w+'x'+v.h))]},null,2));
 assert.equal(final.status,'done',JSON.stringify(final));
 const bytes=await page.evaluate(async({id,path})=>Array.from(new Uint8Array(await(await fetch(`/wf/${id}/${path}`)).arrayBuffer())),{id:project.id,path:final.outputs[0]});
 await writeFile(join(evidence,'export.mp4'),Buffer.from(bytes));
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',join(evidence,'export.mp4')],{encoding:'utf8'}));await writeFile(join(evidence,'probe.json'),JSON.stringify(probe,null,2));
 const v=probe.streams.find(s=>s.codec_type==='video'),a=probe.streams.find(s=>s.codec_type==='audio');assert.equal(v.width,1280);assert.equal(v.height,720);assert.equal(Number(v.nb_frames),seconds*fps);assert(a,'audio track required');
 if(cross){const raw=execFileSync('ffmpeg',['-v','error','-i',join(evidence,'export.mp4'),'-frames:v','1','-vf','scale=32:18','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);const m=(9*32+16)*3;assert(raw[m]>170&&raw[m+1]<100&&raw[m+2]<130,'cross-origin red pixels must be captured');}
 if(process.env.FILM_EXPECT_STABLE==='1'){assert.equal(visualDropped,0,'continuous recording must not truncate');assert.equal(editor.events.length,0,'editor must not resize, scroll, reload, or toggle visibility during capture');assert(bridge.focus.length<=2,'focus may only switch once at initialization and restore');assert.equal(captureResizes,0,'per-frame capture must not resize the render viewport');assert.equal(new Set(editor.scroll.map(v=>v.w+'x'+v.h)).size,1,'export surface must not change editor scrolling dimensions');}
 await waitFor(()=>context.pages().filter(p=>p.url().includes('film-render=')).length===0,{timeout:10000});
 await writeFile(join(evidence,'cleanup.json'),JSON.stringify({renderWindows:0,cancelCheck:process.env.FILM_CANCEL_CHECK==='1'}));
} catch(error) {await writeFile(join(evidence,'failure.json'),JSON.stringify({message:error.message,stack:error.stack}));throw error;} finally {await screenCaptureWork;await context?.close().catch(()=>{});await new Promise(r=>server.close(r));await mock.close();if(cross)await new Promise(r=>cross.close(r));await rm(profile,{recursive:true,force:true});}
