/** Inspect a project source without inserting it into the timeline or writing preview files. */
import type { PreviewPixelSource } from './web-export.ts';
import { capturePreviewFrame } from './frame-capture.ts';
import { safeProjectPath } from './opfs/store.ts';

export async function mediaLookSource(id: string, path: string, signal?: AbortSignal): Promise<{source: PreviewPixelSource; close(): void}> {
  if (!safeProjectPath(path) || path.startsWith('.film/')) throw new Error('invalid media path');
  const url = `/wf/${encodeURIComponent(id)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const ext = path.split('.').at(-1)?.toLowerCase() ?? '';
  let element: HTMLElement | null = null;
  const close = () => {
    if (element instanceof HTMLMediaElement) { element.pause(); element.removeAttribute('src'); element.load(); }
    element?.remove();
  };
  const bounded=async<T>(pending:PromiseLike<T>|T):Promise<T>=>new Promise<T>((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();close();reject(signal?.reason??new DOMException('inspection cancelled','AbortError'));};
    const timer=setTimeout(()=>{cleanup();close();reject(new Error('media inspection did not finish within 20s'));},20000);
    if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
    Promise.resolve(pending).then(value=>{cleanup();resolve(value);},error=>{cleanup();close();reject(error);});
  });
  const wait = async (ready: () => boolean, error: () => unknown = () => null) => {
    const deadline = performance.now() + 20_000;
    while (!ready()) {
      signal?.throwIfAborted();
      const failed = error(); if (failed) throw new Error(`media could not load: ${String(failed)}`);
      if (performance.now() >= deadline) throw new Error('media did not become ready within 20s');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    const canvas = (w:number,h:number) => { const c=document.createElement('canvas'); c.width=w;c.height=h;return c; };
    if (['html','htm'].includes(ext)) {
      const iframe = document.createElement('iframe'); element=iframe;
      iframe.style.cssText='position:fixed;left:-20000px;top:0;border:0;width:1280px;height:720px;pointer-events:none';
      iframe.src=url;document.body.append(iframe);
      type FilmWindow=Window & {film?:{width:number;height:number;duration:number;ready?:Promise<void>;frame(t:number):Promise<void>|void};filmHost?:{time?(t:number):void;settle?(t:number):void}};
      const filmWindow=()=>iframe.contentWindow as FilmWindow;
      await wait(()=>typeof filmWindow()?.film?.frame==='function');
      const f=filmWindow().film!;await bounded(f.ready);
      const size={w:f.width||1280,h:f.height||720};iframe.style.width=`${size.w}px`;iframe.style.height=`${size.h}px`;
      return {close,source:{size:()=>size,duration:()=>Number.isFinite(f.duration)&&f.duration>0?f.duration:1,
        seek:async t=>{signal?.throwIfAborted();filmWindow().filmHost?.time?.(t);await bounded(f.frame(t));filmWindow().filmHost?.settle?.(t);},
        capture:()=>capturePreviewFrame(iframe,size,true)}};
    }
    if (['png','jpg','jpeg','webp','gif','avif','svg'].includes(ext)) {
      const image=new Image();image.src=url;await bounded(image.decode());signal?.throwIfAborted();
      return {close,source:{size:()=>({w:image.naturalWidth,h:image.naturalHeight}),duration:()=>1,seek:async()=>{},capture:async()=>{
        const c=canvas(image.naturalWidth,image.naturalHeight);c.getContext('2d')!.drawImage(image,0,0);return c;
      }}};
    }
    if (['mp3','wav','m4a','aac','ogg','opus','flac'].includes(ext)) {
      const response=await fetch(url,{signal});if(!response.ok)throw new Error('media file is missing');
      const context=new OfflineAudioContext(1,1,48000);const buffer=await bounded(context.decodeAudioData(await response.arrayBuffer()));let at=0;
      return {close,source:{size:()=>({w:960,h:240}),duration:()=>buffer.duration,seek:async t=>{at=t;},
        audio:async(from,to)=>{const start=Math.floor(from*buffer.sampleRate),length=Math.max(1,Math.round((to-from)*buffer.sampleRate));const out=new AudioBuffer({sampleRate:buffer.sampleRate,numberOfChannels:buffer.numberOfChannels,length});for(let c=0;c<out.numberOfChannels;c++)out.copyToChannel(buffer.getChannelData(c).subarray(start,start+length),c);return out;},
        capture:async()=>{const c=canvas(960,240),g=c.getContext('2d')!;g.fillStyle='#17212b';g.fillRect(0,0,960,240);g.fillStyle='#8ac8dc';const samples=buffer.getChannelData(0);for(let x=0;x<960;x++){let peak=0;for(let i=Math.floor(x*samples.length/960);i<Math.floor((x+1)*samples.length/960);i++)peak=Math.max(peak,Math.abs(samples[i]));g.fillRect(x,120-peak*110,1,Math.max(1,peak*220));}g.fillStyle='#fff';g.fillRect(at/buffer.duration*960,0,2,240);return c;}}};
    }
    if (!['mp4','webm','mov','m4v','ogv'].includes(ext)) throw new Error('unsupported media inspection type');
    const video=document.createElement('video');element=video;video.muted=true;video.preload='auto';video.src=url;
    await wait(()=>video.readyState>=2&&Number.isFinite(video.duration),()=>video.error?.message);
    return {close,source:{size:()=>({w:video.videoWidth,h:video.videoHeight}),duration:()=>video.duration,
      seek:async t=>{video.currentTime=Math.min(Math.max(0,t)+.001,video.duration-.001);await wait(()=>!video.seeking&&video.readyState>=2,()=>video.error?.message);},
      capture:async()=>{const c=canvas(video.videoWidth,video.videoHeight);c.getContext('2d')!.drawImage(video,0,0);return c;}}};
  } catch(error) {close();throw error;}
}
