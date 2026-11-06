import {projectCaptions} from './captions.ts';
import {filmSubtitleSrt,filmSubtitleVtt,filmSubtitleTranscript,filmSubtitleCuesInRanges,filmSubtitleFrameHtml,parseFilmSubtitleStyle,filmSubtitleShown} from '../../../server/film-subtitle.mjs';
import {readFileText} from './opfs/index.ts';
export async function subtitleFile(id:string,format:'srt'|'vtt'|'txt',ranges:number[][]):Promise<Blob>{
  const {cues}=await projectCaptions(id);const raw=await readFileText(id,'.film/subtitle-style.json');
  const shown=filmSubtitleShown(cues,parseFilmSubtitleStyle(raw?JSON.parse(raw):{}));
  const selected=filmSubtitleCuesInRanges(shown,ranges.map(([a,b])=>[a*1000,b*1000]));
  return new Blob([(format==='srt'?filmSubtitleSrt:format==='vtt'?filmSubtitleVtt:filmSubtitleTranscript)(selected)],{type:format==='vtt'?'text/vtt':'text/plain'});
}
export async function burnCaptions(canvas:HTMLCanvasElement,id:string,seconds:number):Promise<void>{
  const {cues}=await projectCaptions(id);const raw=await readFileText(id,'.film/subtitle-style.json');
  const style=parseFilmSubtitleStyle(raw?JSON.parse(raw):{});
  const html=filmSubtitleFrameHtml(cues,{...style,on:true},{w:canvas.width,h:canvas.height},seconds*1000);if(!html)return;
  const doc=new DOMParser().parseFromString(`<html xmlns="http://www.w3.org/1999/xhtml"><body style="margin:0">${html}</body></html>`,'text/html');
  const xhtml=new XMLSerializer().serializeToString(doc.documentElement);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  const image=new Image();image.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;await image.decode();canvas.getContext('2d')!.drawImage(image,0,0);
}
