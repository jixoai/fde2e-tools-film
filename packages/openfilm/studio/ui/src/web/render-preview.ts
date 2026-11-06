/** A full-size export document: the editor's preview, playhead and controls stay independent. */
import { Player } from '../editor/player.ts';
import type { FilmInfo } from '../editor/Preview.tsx';
import type { PreviewPixelSource } from './web-export.ts';
import { capturePreviewFrame } from './frame-capture.ts';
import { openPluginRender, pluginCaptureAvailable } from './plugin-capture.ts';
import { clipPixelSource } from './clip-source.ts';

export async function renderPreview(projectId:string,size:{w:number;h:number},signal:AbortSignal,host=false){
  const iframe=document.createElement('iframe');
  iframe.dataset.filmRenderSurface='';iframe.setAttribute('aria-hidden','true');iframe.tabIndex=-1;
  iframe.style.cssText=`position:absolute;left:0;top:${host?0:10000}px;width:${size.w}px;height:${size.h}px;border:0;pointer-events:none;color-scheme:light`;
  iframe.src=`/wf/${encodeURIComponent(projectId)}/film.html?load=export-${crypto.randomUUID()}`;
  const player=new Player();let seq=0,info:FilmInfo|null=null;
  let remote:Awaited<ReturnType<typeof openPluginRender>>|undefined;
  const waiting=new Map<number,{resolve():void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
  let readyResolve:(info:FilmInfo)=>void,readyReject:(error:Error)=>void;
  const ready=new Promise<FilmInfo>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const message=(event:MessageEvent)=>{
    if(event.origin!==location.origin||event.source!==iframe.contentWindow||event.data?.source!=='openfilm-film')return;
    const m=event.data;
    if(m.type==='ready'){info=m;player.load(location.origin,m.sounds,m.duration);readyResolve(m);}
    if(m.type==='seeked'){const entry=waiting.get(Number(m.seq));if(entry){waiting.delete(Number(m.seq));clearTimeout(entry.timer);entry.resolve();}}
    if(m.type==='error'){const error=new Error(String(m.message));readyReject(error);for(const entry of waiting.values()){clearTimeout(entry.timer);entry.reject(error);}waiting.clear();}
  };
  const close=()=>{window.removeEventListener('message',message);signal.removeEventListener('abort',abort);iframe.remove();player.close();void remote?.close().catch(()=>{});for(const entry of waiting.values()){clearTimeout(entry.timer);entry.reject(new DOMException('render closed','AbortError'));}waiting.clear();};
  const abort=()=>{readyReject(new DOMException('render cancelled','AbortError'));close();};
  window.addEventListener('message',message);signal.addEventListener('abort',abort,{once:true});document.body.append(iframe);
  const timer=setTimeout(()=>readyReject(new Error('render document did not become ready within 20s')),20_000);
  try{signal.throwIfAborted();await ready;}catch(error){close();throw error;}finally{clearTimeout(timer);}
  if(!host&&pluginCaptureAvailable())try{remote=await openPluginRender(projectId,size);signal.throwIfAborted();}catch(error){close();throw error;}
  const source:PreviewPixelSource={
    size:()=>size,duration:()=>info!.duration,
    seek:async t=>{
      signal.throwIfAborted();const id=++seq;
      await new Promise<void>((resolve,reject)=>{
        waiting.set(id,{resolve,reject,timer:setTimeout(()=>{waiting.delete(id);reject(new Error('render frame did not finish within 20s'));},20_000)});
        iframe.contentWindow!.postMessage({source:'openfilm-studio',type:'seek',t,seq:id,strict:true},location.origin);
      });
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
      if(remote)await remote.seek(t);
    },
    capture:async transparent=>{
      signal.throwIfAborted();
      if(transparent)return capturePreviewFrame(iframe,size,true);
      if(remote)return remote.capture();
      return capturePreviewFrame(iframe,size);
    },
    audio:(from,to,abort)=>player.mixdown(from,to,undefined,abort),stems:(from,to,abort)=>player.mixStems(from,to,abort),
    clip:id=>clipPixelSource(source,()=>iframe,id,(clip,from,to)=>player.mixdown(from,to,{clip},signal)),
  };
  return {source,close};
}
