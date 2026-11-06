import {FFmpeg} from '@ffmpeg/ffmpeg';
import {ffmpegAssetUrls} from './ffmpeg-fallback.ts';
import {audioWav} from './wasm-encode-session.ts';
/** ST atempo preserves pitch at the same speeds the live player supports. */
export async function stretchAudio(buffer:AudioBuffer,speed:number,signal?:AbortSignal):Promise<AudioBuffer>{
  const factors=[];let rate=speed;while(rate>2){factors.push(2);rate/=2;}while(rate<0.5){factors.push(0.5);rate/=0.5;}factors.push(rate);
  const ff=new FFmpeg();const stop=()=>ff.terminate();signal?.throwIfAborted();signal?.addEventListener('abort',stop,{once:true});
  try{
    await ff.load(ffmpegAssetUrls(location.origin));signal?.throwIfAborted();
    await ff.writeFile('in.wav',new Uint8Array(await audioWav(buffer).arrayBuffer()));
    if(await ff.exec(['-threads','1','-i','in.wav','-af',factors.map(f=>`atempo=${f}`).join(','),'-c:a','pcm_f32le','-y','out.wav'])!==0)throw new Error('audio tempo conversion failed');
    const bytes=await ff.readFile('out.wav');if(!(bytes instanceof Uint8Array))throw new Error('invalid audio output');
    const context=new OfflineAudioContext(buffer.numberOfChannels,1,buffer.sampleRate);
    return context.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
  }finally{signal?.removeEventListener('abort',stop);ff.terminate();}
}
