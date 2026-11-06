import type {PreviewPixelSource} from './web-export.ts';
import {capturePreviewFrame} from './frame-capture.ts';
type LoadedClip={id:string;src:string;at:number;end:number;nw?:number;nh?:number;el:HTMLIFrameElement|HTMLImageElement|HTMLVideoElement|null;kind:string};
export async function clipPixelSource(base:PreviewPixelSource,frame:()=>HTMLIFrameElement|null,id:string,audio:(src:string,from:number,to:number)=>Promise<AudioBuffer|null>):Promise<PreviewPixelSource>{
  const read=()=>{
    const win=frame()?.contentWindow as (Window&{__filmEditor?:{stage:{clips:()=>LoadedClip[]}}})|null;
    const clip=win?.__filmEditor?.stage.clips().find(c=>c.id===id);
    if(!clip||!clip.el||clip.kind==='sound')throw new Error('no visual clip '+id);return clip;
  };
  const initial=read();await base.seek(initial.at);const loaded=read();
  const size={w:loaded.nw??base.size().w,h:loaded.nh??base.size().h};
  return {
    size:()=>size,duration:()=>loaded.end-loaded.at,seek:t=>base.seek(loaded.at+t),
    captionTime:t=>loaded.at+t,
    audio:(from,to)=>audio(loaded.id,loaded.at+from,loaded.at+to),
    capture:async()=>{
      const clip=read(),el=clip.el!;
      if(el.tagName==='IFRAME')return capturePreviewFrame(el as HTMLIFrameElement,size,true);
      const canvas=document.createElement('canvas');canvas.width=size.w;canvas.height=size.h;
      canvas.getContext('2d',{alpha:true})!.drawImage(el as HTMLImageElement|HTMLVideoElement,0,0,size.w,size.h);return canvas;
    },
  };
}
