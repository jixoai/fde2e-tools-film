import type {PreviewPixelSource,WebExportDeps} from './web-export.ts';
import {startWebExport,waitForWebExport,forgetTemporaryWebExport} from './web-export.ts';

/** Contact sheet and reverse-order redraw use the actual capture lane; no timeline files change. */
export async function inspectLook(id:string,source:PreviewPixelSource,input:{at?:number;range?:number[];moments?:number[];sheet?:boolean;shortEdge?:number;frame?:string;fill?:string},signal?:AbortSignal){
  const isolated=source.open?await source.open(signal??new AbortController().signal):null;
  try{
  if(isolated)source=isolated.source;
  const duration=source.duration();const edge=input.shortEdge??360;
  if(!Number.isInteger(edge)||edge<64||edge>1024)throw new Error('look shortEdge must be 64..1024');
  if([input.at!==undefined,input.range!==undefined,input.moments!==undefined].filter(Boolean).length>1)throw new Error('choose at, range or moments');
  const range=input.range??[0,duration];
  if(range.length!==2||!range.every(Number.isFinite)||range[0]<0||range[1]<=range[0]||range[1]>duration)throw new Error('invalid look range');
  const moments=input.moments??(input.at!==undefined?[input.at]:input.sheet||input.range?[0,1,2,3,4,5].map(i=>range[0]+(range[1]-range[0])*(i+0.5)/6):[0]);
  if(!moments.length||moments.length>16||moments.some(t=>!Number.isFinite(t)||t<0||t>duration))throw new Error('look expects 1..16 moments inside the film');
  const captures=async(times:number[])=>{
    const images=new Map<string,Blob>();const deps:WebExportDeps={temporary:true,putFile:async(_id,path,blob)=>{images.set(path,blob);}};
    const job=startWebExport(id,{kind:'stills',as:'files',format:'png',at:times,shortEdge:edge,frame:input.frame as never,fill:input.fill as never,name:'Look'},source,deps);
    try{const final=await waitForWebExport(id,job.id,signal);if(final.status!=='done')throw new Error(final.error??final.status);
    return final.outputs.map(path=>images.get(path)!);}finally{forgetTemporaryWebExport(id,job.id);}
  };
  const forward=await captures(moments),backward=(await captures([...moments].reverse())).reverse();
  const frames=[];let totalDiff=0,pixels=0;
  let difference: {t:number;first:string;repeat:string}|undefined;
  const columns=input.sheet||moments.length>1?Math.min(3,moments.length):1;
  const thumbs:HTMLCanvasElement[]=[];
  for(let i=0;i<forward.length;i++){
    const a=await createImageBitmap(forward[i]),b=await createImageBitmap(backward[i]);const c=document.createElement('canvas');c.width=a.width;c.height=a.height;
    const ctx=c.getContext('2d')!;ctx.drawImage(a,0,0);const first=ctx.getImageData(0,0,c.width,c.height).data;
    const d=document.createElement('canvas');d.width=c.width;d.height=c.height;const dc=d.getContext('2d')!;dc.drawImage(b,0,0);const second=dc.getImageData(0,0,d.width,d.height).data;
    let changed=0;for(let j=0;j<first.length;j+=4)if(first[j]!==second[j]||first[j+1]!==second[j+1]||first[j+2]!==second[j+2]||first[j+3]!==second[j+3])changed++;
    if(changed&&!difference)difference={t:moments[i],first:c.toDataURL('image/png'),repeat:d.toDataURL('image/png')};
    totalDiff+=changed;pixels+=c.width*c.height;frames.push({t:moments[i],w:c.width,h:c.height,diffPixels:changed});thumbs.push(c);a.close();b.close();
  }
  const sheet=document.createElement('canvas');const w=thumbs[0].width,h=thumbs[0].height;
  sheet.width=w*columns;sheet.height=(h+24)*Math.ceil(thumbs.length/columns);const ctx=sheet.getContext('2d')!;ctx.fillStyle='#111';ctx.fillRect(0,0,sheet.width,sheet.height);
  for(const [i,c] of thumbs.entries()){const x=i%columns*w,y=Math.floor(i/columns)*(h+24);ctx.drawImage(c,x,y);ctx.fillStyle='#fff';ctx.font='14px sans-serif';ctx.fillText(`${moments[i].toFixed(2)} s`,x+8,y+h+17);}
  return {ok:true,frames,determinism:{same:totalDiff===0,diffPixels:totalDiff,diffRatio:totalDiff/Math.max(1,pixels),order:'forward/reverse',...(difference?{difference}:{})},sheet:{mime:'image/png',w:sheet.width,h:sheet.height,dataUrl:sheet.toDataURL('image/png')}};
  }finally{isolated?.close();}
}
