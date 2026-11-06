/** Repair regression: real Film, real BU extension, mock transport only (no model gate claim). */
import { chromium } from 'playwright-core';
import { createFilmStaticServer } from './web-static-server.mjs';
import { resolve, join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
const film = resolve(import.meta.dirname,'..'); const main = resolve(film,'../../..');
const bu = join(main,'fde2e-bu-v1');
const {MockOmniServer,waitFor} = await import(join(bu,'apps/extension/scripts/lib/mock-omni.mjs'));
const evidence = process.env.FILM_REPAIR_EVIDENCE || join(main,'../../.agents/reports/tools-film/film-conformance-repair');
await mkdir(join(evidence,'img'),{recursive:true});
const profile = `/tmp/film-repair-chromium-${process.pid}`;
const mock = new MockOmniServer(); const mockBase = await mock.listen(13737);
const server = await createFilmStaticServer({dir:join(film,'studio/ui/dist'),port:13689});
const cross = createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><body style="margin:0;background:rgb(226,52,86)">Cross-origin pixels</body>'));
await new Promise(r=>cross.listen(13688,'127.0.0.1',r));
const ctx = await chromium.launchPersistentContext(profile,{
 executablePath:'/Users/kingsword09/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
 headless:false,viewport:{width:1440,height:900},args:[`--disable-extensions-except=${bu}/apps/extension`,`--load-extension=${bu}/apps/extension`,'--enable-blink-features=WebMCP','--autoplay-policy=no-user-gesture-required']
});
const steps=[]; const receipts=[]; let page;
async function shot(id,intent,assertion){const path=`img/${id}.png`;await page.screenshot({path:join(evidence,path)});steps.push({id,intent,assertion,ok:true,image:path});console.log(id,assertion);}
try {
 const sw=await waitFor(()=>ctx.serviceWorkers().find(w=>w.url().includes('background.js')),{timeout:20000});
 const options=await ctx.newPage(); await options.goto(`chrome-extension://${new URL(sw.url()).host}/dist/options.html`);
 await options.evaluate(async(base)=>{ const r=await chrome.runtime.sendMessage({type:'bu:bind',link:`${base}/link/filmrepair`,role:'master'}); if(r?.ok===false)throw new Error(JSON.stringify(r)); },mockBase);
 await waitFor(()=>mock.conn('filmrepair')?.welcomed,{timeout:20000});
 const run=async(command)=>{const r=await mock.command('filmrepair',command);receipts.push({command,reply:r});assert.equal(r.ok,true,JSON.stringify(r));return r;};
 await run({cmd:'windowCreate',url:'http://127.0.0.1:13689/index-web.html',windowTaskId:'film-repair',width:1440,height:1000});
 page=await waitFor(()=>ctx.pages().find(p=>p.url().includes(':13689')),{timeout:20000});
 page.on('console',msg=>{if(msg.type()==='error')console.log('page error:',msg.text());});
 await page.waitForFunction(()=>document.modelContext !== undefined,undefined,{timeout:30000});
 console.log('boot',await page.evaluate(()=>({title:document.title,body:document.body.innerText.slice(0,200),native:!!document.modelContext})));
 await new Promise(r=>setTimeout(r,1000));
 const list=await waitFor(async()=>{const l=await run({cmd:'webmcp_list'});return l.tools?.some(t=>t.name==='projects_import_package')?l:null;},{timeout:20000,interval:500,what:'registered Film tools'});
 const call=async(name,args={})=>{const r=await run({cmd:'webmcp_call',name,args,origin:'http://127.0.0.1:13689',timeoutMs:60000});const v=JSON.parse(r.result);assert(!v.error,JSON.stringify(v));return v;};
 await shot('S1','真实扩展枚举修复后的工具面',`${list.tools.length} tools; actual MV3 executor`);
 const p=await call('projects_create',{name:'Repair regression'}); await call('projects_open',{id:p.id});
 await page.waitForURL(`**/projects/${p.id}`);
 const html='<!doctype html><html><head><meta name="viewport" content="width=320, height=180"></head><body style="margin:0;background:#334455"><div id="color" style="position:absolute;inset:10%;background:#eebb44"></div><script>window.film={width:320,height:180,duration:2,frame(t){document.getElementById("color").style.transform="translateX("+t*60+"px)"}}<\/script></body></html>';
 await call('edit_write_page',{path:'pages/title.html',text:html});
 await call('edit_insert_clip',{src:'pages/title.html',time:[0,2],newTrack:1,at:0});
 await call('edit_set_stage',{w:320,h:180});
 const saved=await call('edit_save_version',{message:'nested baseline'});
 await call('edit_write_page',{path:'pages/title.html',text:html.replace('#eebb44','#11dd66'),expect:html});
 assert.equal((await call('edit_list_versions')).workingDiffers,true);
 await call('edit_checkout_version',{commit:saved.commit,discard:true});
 assert.equal((await call('edit_list_versions')).workingDiffers,false);
 await shot('S2','嵌套页面历史回退','dirty=true after page edit; checkout clears dirty and restores contents');
 const pack=await call('projects_export_package'); const copied=await call('projects_import_package',{zipBase64:pack.zipBase64,name:'roundtrip'});
 await page.waitForURL(`**/projects/${copied.id}`); await page.waitForSelector('.stage');
 assert.notEqual(copied.id,p.id);await call('projects_rename',{id:copied.id,name:'renamed copy'});
 await shot('S3','项目包经真实 WebMCP 往返','root/nested page included; independent project created and renamed');
 const render=async(id,input,check)=>{
  const job=await call('produce_render',{...input,wait:false});
  const final=await waitFor(async()=>{const s=await call('produce_export_status');const j=s.jobs.find(j=>j.id===job.jobId);return ['done','failed','cancelled'].includes(j?.status)?j:null;},{timeout:120000,interval:1000,what:id});
  assert.equal(final.status,'done',JSON.stringify(final));assert(final.bytes>0);
  const file=final.outputs[0]; const bytes=await page.evaluate(async({id,file})=>Array.from(new Uint8Array(await (await fetch(`/wf/${id}/${file}`)).arrayBuffer())),{id:copied.id,file});
  const dest=join(evidence,`${id}.${file.split('.').at(-1)}`); await writeFile(dest,Buffer.from(bytes));
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',dest],{encoding:'utf8'}));
  await writeFile(join(evidence,`${id}-probe.json`),JSON.stringify(probe,null,2));
  if(probe.streams.some(s=>s.codec_type==='video')){
   const raw=execFileSync('ffmpeg',['-v','error','-i',dest,'-frames:v','1','-vf','scale=32:18','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
   assert(raw.reduce((a,b)=>a+b,0)/raw.length>30,'decoded picture must not be black');
   if(check)check(raw,probe);
  } else assert(probe.streams.some(s=>s.codec_type==='audio'));
  await shot(id,`真实 ${input.codec||input.format||input.kind} 导出并独立解码`,JSON.stringify(final));return final;
 };
 // A selection overlay inside the stage must never appear in an exported frame.
 await page.evaluate(()=>{const e=document.createElement('div');e.id='test-selection';e.style.cssText='position:absolute;inset:0;background:rgb(0,255,0);z-index:999';document.querySelector('.stage').append(e);});
 await page.evaluate(()=>{const stage=document.querySelector('.stage').getBoundingClientRect();for(const [i,pointer] of ['none','auto'].entries()){const e=document.createElement('div');e.id=`test-portal-${i}`;e.style.cssText=`position:fixed;left:${stage.left+stage.width*(.2+i*.35)}px;top:${stage.top+stage.height*.2}px;width:40px;height:40px;background:rgb(0,255,0);pointer-events:${pointer};z-index:10200`;document.body.append(e);}});
 for (const [id,input] of [
  ['S4',{kind:'video',codec:'h264',from:0,to:1,fps:6,shortEdge:64,audio:false}],
  ['S5',{kind:'video',codec:'prores422hq',from:0,to:1,fps:3,shortEdge:64,audio:false}],
  ['S6',{kind:'gif',from:0,to:1,fps:3,width:64}],
 ]) {
   await render(id,input,(raw)=>{const middle=(9*32+16)*3;assert(raw[middle]>100 && raw[middle+2]<150,'must capture film, not green selection overlay');for(let i=0;i<raw.length;i+=3)assert(!(raw[i+1]>150 && raw[i]<90 && raw[i+2]<90),'body portal or pointer-events:none tooltip leaked into capture');});
 }
 await page.evaluate(()=>{for(const id of ['test-selection','test-portal-0','test-portal-1'])document.getElementById(id).remove();});
 const injected=await run({cmd:'film_inject',zipBase64:pack.zipBase64,name:'BU package',timeoutMs:30000});assert(injected.project.id);
 await call('projects_open',{id:copied.id});
 await shot('S7','扩展包注入等待真实持久化身份','film_inject returned a new verified OPFS project id');
 await page.evaluate(()=>{window.__savedVideoEncoder=window.VideoEncoder;Object.defineProperty(window,'VideoEncoder',{value:undefined,configurable:true});});
 const fallback=await render('S8',{kind:'video',codec:'h264',from:0,to:1,fps:3,shortEdge:64,audio:false});assert.equal(fallback.encoder,'libx264/ST');
 await page.evaluate(()=>Object.defineProperty(window,'VideoEncoder',{value:window.__savedVideoEncoder,configurable:true}));
 const sound=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=1','-f','wav','pipe:1']);
 const media=await call('projects_import_media',{name:'tone.wav',mime:'audio/wav',dataBase64:sound.toString('base64')});
 await call('edit_insert_clip',{src:media.path,time:[0,1],newTrack:2,at:0});
 await render('S9',{kind:'audio',format:'wav',from:0,to:1});
 await render('S10',{kind:'video',codec:'h264',from:0,to:1,fps:3,shortEdge:64,audio:true},(_raw,probe)=>assert(probe.streams.some(s=>s.codec_type==='audio')));
 await call('projects_read_file',{path:(await call('produce_export_status')).jobs.findLast(j=>j.status==='done').outputs[0],download:true});
 const artifact=await waitFor(async()=>{const s=await run({cmd:'getState',host:'127.0.0.1'});return s.artifacts?.find(a=>a.mime==='video/mp4');},{timeout:15000,interval:500,what:'MP4 artifact'});
 assert(artifact); await shot('S11','真实扩展捕获下载产物','MP4 bytes became a managed media artifact');
 const crossHtml=html.replace('<div id="color"', '<iframe src="http://127.0.0.1:13688/cross.html" style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe><div hidden id="color"');
 await call('edit_write_page',{path:'pages/title.html',text:crossHtml,expect:html});
 await waitFor(()=>page.frames().find(f=>f.url().includes(':13688')),{timeout:30000,what:'cross-origin clip ready'});
 await render('S12',{kind:'video',codec:'prores422hq',from:0,to:1,fps:3,shortEdge:64,audio:false},(raw)=>{const middle=(9*32+16)*3;assert(raw[middle]>170&&raw[middle+1]<100&&raw[middle+2]<130,'cross-origin red pixels must be captured');});
 const cancel=await call('produce_render',{kind:'video',codec:'prores422hq',from:0,to:2,fps:60,shortEdge:720,audio:false,wait:false});
 assert.equal((await call('produce_cancel_export',{jobId:cancel.jobId})).requested,true);
 const cancelled=await waitFor(async()=>{const s=await call('produce_export_status');return s.jobs.find(j=>j.id===cancel.jobId&&j.status==='cancelled');},{timeout:30000,what:'cancel terminal'});
 assert(cancelled);await shot('S13','取消真实 wasm 导出','job cancelled; no output committed');
 await call('edit_write_page',{path:'pages/title.html',text:html,expect:crossHtml});
 const raw=await call('projects_read_file',{path:'pages/title.html',length:1048576});
 assert.equal(Buffer.from(raw.dataBase64,'base64').toString(),html);assert.equal(raw.size,Buffer.byteLength(html));
 const look=await call('produce_look',{range:[0,2],sheet:true,shortEdge:128});assert.equal(look.frames.length,6);assert.equal(look.determinism.same,true);assert(look.sheet.dataUrl.startsWith('data:image/png'));
 await writeFile(join(evidence,'contact-sheet.png'),Buffer.from(look.sheet.dataUrl.split(',')[1],'base64'));
 await shot('S14','原始源码读取与六帧正反向复绘','HTML bytes exact; 6-frame contact sheet; reverse redraw has zero different pixels');
 const state=await call('film_state');const clip=state.film?.tracks?.[0]?.clips?.[0]?.id??state.tracks?.[0]?.clips?.[0]?.id;
 await call('edit_set_track',{track:1,field:'locked',value:true});
 const locked=await run({cmd:'webmcp_call',name:'edit_apply',args:{ops:[{op:'remove',clip}]},origin:'http://127.0.0.1:13689'});assert(JSON.parse(locked.result).error);
 await call('edit_set_track',{track:1,field:'locked',value:false});
 const overwrite=await run({cmd:'webmcp_call',name:'edit_write_page',args:{path:'pages/title.html',text:'overwritten',expect:''},origin:'http://127.0.0.1:13689'});assert(JSON.parse(overwrite.result).error);
 await shot('S15','锁轨与源码覆盖保护','raw edit cannot remove locked clip; empty expect cannot overwrite existing page');
 await call('edit_write_page',{path:'assets/tone.vtt',text:'WEBVTT\n\n00:00.000 --> 00:00.500\nFirst caption\n\n00:00.500 --> 00:01.000\nSecond caption\n'});
 const generic=async(input)=>{const job=await call('produce_render',{...input,wait:false});const terminal=await waitFor(async()=>{const s=await call('produce_export_status');return s.jobs.find(j=>j.id===job.jobId&&['done','failed','cancelled'].includes(j.status));},{timeout:90000,interval:500});assert.equal(terminal.status,'done',JSON.stringify(terminal));return terminal;};
 const sub=await generic({kind:'subtitles',format:'srt',from:0.25,to:0.75});
 const subBytes=await call('projects_read_file',{path:sub.outputs[0],length:1048576});const subText=Buffer.from(subBytes.dataBase64,'base64').toString();assert(subText.includes('First caption')&&subText.includes('Second caption')&&subText.includes('00:00:00,000'));
 const stillZip=await generic({kind:'stills',moments:[0.25,1.25],as:'zip',shortEdge:128});assert(stillZip.outputs[0].endsWith('.zip'));
 const projectZip=await generic({kind:'project'});assert(projectZip.outputs[0].endsWith('.zip'));
 await shot('S16','字幕与 ZIP 产品入口','SRT clips/rebases cues; stills ZIP and project ZIP complete');
 await render('S17',{kind:'video',codec:'h264',ranges:[[1,1.5],[0,0.5]],fps:6,shortEdge:64,audio:true},(_raw,probe)=>assert(Math.abs(Number(probe.format.duration)-1)<0.2));
 const one=await generic({kind:'video',codec:'png',clip,scale:0.5,fps:2,audio:false});assert(one.outputs[0].endsWith('.zip'));
 await shot('S18','片段独立导出与 PNG 序列','clip source exported at scale 0.5, PNG sequence packaged as ZIP');
 const beforeLook=await call('produce_export_status');
 const mediaLook=await call('produce_look',{media:'pages/title.html',range:[0,2],sheet:true,shortEdge:128});assert.equal(mediaLook.determinism.same,true);assert.equal(mediaLook.frames.length,6);
 const audioLook=await call('produce_look',{media:media.path,sheet:true,shortEdge:128});assert.equal(audioLook.determinism.same,true);
 assert.equal((await call('produce_export_status')).jobs.length,beforeLook.jobs.length,'inspection must not add phantom downloads');
 await shot('S19','素材原件检查与临时输出隔离','page contact sheet and audio waveform are deterministic; no new export jobs');
 await render('S20',{kind:'video',codec:'mkv',from:0,to:1,fps:3,shortEdge:64,audio:true},(_raw,probe)=>assert(probe.format.format_name.includes('matroska')));
 const transparent=html.replace('background:#334455','background:transparent');await call('edit_write_page',{path:'pages/title.html',text:transparent,expect:html});
 await render('S21',{kind:'video',codec:'prores4444',clip,scale:0.5,fps:2,audio:false},(_raw,probe)=>assert(probe.streams.some(s=>s.pix_fmt?.startsWith('yuva'))));
 const alpha=execFileSync('ffmpeg',['-v','error','-i',join(evidence,'S21.mov'),'-frames:v','1','-vf','alphaextract','-f','rawvideo','-pix_fmt','gray','pipe:1']);assert.equal(alpha[0],0);assert(alpha.some(v=>v>250));
 await call('edit_write_page',{path:'pages/title.html',text:html,expect:transparent});
 const audioClip=(await call('film_state')).tracks[1].clips[0].id;await call('edit_set_speed',{clip:audioClip,speed:2});
 const sped=await generic({kind:'audio',format:'wav',from:0,to:0.5,stems:true});assert.equal(sped.outputs.length,2);
 const sample=await call('projects_read_file',{path:sped.outputs[0],length:1048576});await writeFile(join(evidence,'sped.wav'),Buffer.from(sample.dataBase64,'base64'));
 const pcm=execFileSync('ffmpeg',['-v','error','-i',join(evidence,'sped.wav'),'-ac','1','-ar','16000','-f','f32le','pipe:1']);let crosses=0;for(let i=4;i<pcm.length;i+=4)if(pcm.readFloatLE(i-4)<=0&&pcm.readFloatLE(i)>0)crosses++;const hz=crosses/(pcm.length/4/16000);assert(hz>400&&hz<480,`pitch must stay near 440 Hz at 2x; got ${hz}`);
 await shot('S22','变速音频与分轨','2x source exports 0.5 seconds at unchanged pitch; mix and role stem both complete');
 await call('edit_set_speed',{clip:audioClip,speed:1});
 const burned=await render('S23',{kind:'video',codec:'h264',from:0,to:1,fps:3,shortEdge:180,audio:false,burnSubtitles:true,sidecar:'srt'});assert.equal(burned.outputs.length,2);assert(burned.outputs[1].endsWith('.srt'));
 const stateful=html.replace('window.film={','let calls=0;window.film={').replace('t*60','(++calls)*10');
 await call('edit_write_page',{path:'pages/title.html',text:stateful,expect:html});
 const unstable=await call('produce_look',{at:0.5,shortEdge:128});assert.equal(unstable.determinism.same,false,'same instance must expose accumulated frame state');
 await call('edit_write_page',{path:'pages/title.html',text:html,expect:stateful});
 await shot('S24','确定性反向对照','stateful frame counter is detected by two draws on the same isolated surface');
 const editorBefore=await page.evaluate(()=>document.querySelector('.stage-frames iframe:not([data-loading])').contentWindow.document.body.innerHTML);
 const long=await call('produce_render',{kind:'video',from:0,to:2,fps:60,shortEdge:720,audio:false});
 await waitFor(()=>ctx.pages().some(p=>p.url().includes('film-render=')),{timeout:15000,what:'independent render window'});
 const controls=await page.evaluate(()=>[...document.querySelectorAll('button')].filter(b=>getComputedStyle(b).visibility==='visible'&&b.getBoundingClientRect().width>0).length);assert(controls>5);
 assert.equal(await page.evaluate(()=>document.querySelector('.stage-frames iframe:not([data-loading])').contentWindow.document.body.innerHTML),editorBefore,'export does not seek the editor picture');
 await shot('S25','导出期间编辑器继续可见','visible controls and editor picture remain independent from the render window');
 await page.reload({waitUntil:'domcontentloaded'});await waitFor(()=>!ctx.pages().some(p=>p.url().includes('film-render=')),{timeout:15000,what:'render cleanup after parent reload'});
 await waitFor(async()=>{try{return(await call('produce_export_status')).previewReady;}catch{return false;}},{timeout:30000});
 await generic({kind:'poster',at:0.5,shortEdge:128});
 await shot('S26','父页刷新清理渲染窗口','reload closes the old render; a new export succeeds');
 await call('edit_write_page',{path:'pages/title.html',text:transparent,expect:html});
 await render('S27',{kind:'video',codec:'vp9',clip,scale:0.5,fps:2,audio:false},(_raw,probe)=>assert(probe.streams.some(s=>s.codec_name==='vp9'&&s.tags?.alpha_mode==='1')));
 const webmAlpha=execFileSync('ffmpeg',['-v','error','-c:v','libvpx-vp9','-i',join(evidence,'S27.webm'),'-frames:v','1','-vf','alphaextract','-f','rawvideo','-pix_fmt','gray','pipe:1']);assert.equal(webmAlpha[0],0);assert(webmAlpha.some(v=>v>250));
 await call('edit_write_page',{path:'pages/title.html',text:html,expect:transparent});
 await writeFile(join(evidence,'result.json'),JSON.stringify({ok:true,steps,receipts},null,2));
} catch(error) { if(page)await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{}); await writeFile(join(evidence,'failure.json'),JSON.stringify({error:String(error),receipts},null,2)); throw error; } finally {
 await writeFile(join(evidence,'steps.json'),JSON.stringify({title:'Film conformance repair browser regression',brand:'FDE2E · actual extension regression (model gate separate)',meta:'isolated Chromium + real BU + mock transport',thesis:'Repair regression results; original real Omni goal remains a separate required gate.',sections:[{title:'Browser steps',steps}]},null,2));
 await ctx.close();server.close();cross.close();await mock.close();await rm(profile,{recursive:true,force:true});
}
