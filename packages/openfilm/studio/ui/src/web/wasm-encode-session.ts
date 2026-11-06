/** Disk-backed frame staging for the ST fallback. WORKERFS reads OPFS File snapshots on demand. */
import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { ffmpegAssetUrls } from './ffmpeg-fallback.ts';
export type WasmFormat = 'h264' | 'vp9' | 'hevc' | 'prores422hq' | 'prores4444' | 'gif' | 'wav' | 'mp3' | 'm4a' | 'mkv';
export interface WasmResult { blob: Blob; codec: string; extension: string }
const formats: Record<WasmFormat, { extension: string; mime: string; codec: string; args: string[] }> = {
  h264: { extension: 'mp4', mime: 'video/mp4', codec: 'libx264/ST', args: ['-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart'] },
  // The vendored ST libvpx crashes on inter prediction and higher speed presets.
  // Default speed plus intra frames preserves changing pictures and alpha.
  vp9: { extension: 'webm', mime: 'video/webm', codec: 'libvpx-vp9/ST', args: ['-c:v','libvpx-vp9','-g','1','-crf','30','-b:v','0','-pix_fmt','yuva420p','-auto-alt-ref','0','-c:a','libopus'] },
  hevc: { extension: 'mp4', mime: 'video/mp4', codec: 'libx265/ST', args: ['-c:v','libx265','-preset','ultrafast','-x265-params','pools=none:frame-threads=1','-tag:v','hvc1','-c:a','aac'] },
  prores422hq: { extension: 'mov', mime: 'video/quicktime', codec: 'prores_ks/ST', args: ['-c:v','prores_ks','-profile:v','3','-pix_fmt','yuv422p10le','-c:a','pcm_s16le'] },
  prores4444: { extension: 'mov', mime: 'video/quicktime', codec: 'prores_ks/ST', args: ['-c:v','prores_ks','-profile:v','4','-pix_fmt','yuva444p10le','-c:a','pcm_s16le'] },
  gif: { extension: 'gif', mime: 'image/gif', codec: 'gif/palette/ST', args: ['-filter_complex','[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle','-loop','0'] },
  wav: { extension: 'wav', mime: 'audio/wav', codec: 'pcm_s16le/ST', args: ['-vn','-c:a','pcm_s16le'] },
  mp3: { extension: 'mp3', mime: 'audio/mpeg', codec: 'libmp3lame/ST', args: ['-vn','-c:a','libmp3lame','-q:a','2'] },
  m4a: { extension: 'm4a', mime: 'audio/mp4', codec: 'aac/ST', args: ['-vn','-c:a','aac','-b:a','192k'] },
  mkv: { extension: 'mkv', mime: 'video/x-matroska', codec: 'libx264/ST', args: ['-c:v','libx264','-preset','veryfast','-crf','20','-c:a','flac'] },
};
export function audioWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels; const bytes = buffer.length * channels * 2;
  if (bytes > 0xffffffff - 44) throw new Error('audio exceeds WAV container size');
  const header = new ArrayBuffer(44); const view = new DataView(header);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0,'RIFF'); view.setUint32(4, bytes + 36, true); text(8,'WAVE'); text(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,channels,true);
  view.setUint32(24,buffer.sampleRate,true); view.setUint32(28,buffer.sampleRate * channels * 2,true);
  view.setUint16(32,channels * 2,true); view.setUint16(34,16,true); text(36,'data'); view.setUint32(40,bytes,true);
  const parts: BlobPart[] = [header]; const data = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  for (let offset = 0; offset < buffer.length; offset += 16384) {
    const count = Math.min(16384, buffer.length - offset); const chunk = new DataView(new ArrayBuffer(count * channels * 2));
    for (let i = 0; i < count; i++) for (let c = 0; c < channels; c++) {
      const value = Math.max(-1, Math.min(1, data[c][offset + i]));
      chunk.setInt16((i * channels + c) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    parts.push(chunk.buffer);
  }
  return new Blob(parts, { type: 'audio/wav' });
}
export async function createWasmEncodeSession(request: {
  format: WasmFormat; fps: number; audio?: AudioBuffer | null; signal: AbortSignal;
  quality?: 'standard'|'high'|'master';
  progress?: (value: number) => void;
}) {
  const format = formats[request.format]; if (!format) throw new Error('unsupported wasm format');
  request.signal.throwIfAborted();
  const root = await navigator.storage.getDirectory();
  const cache = await root.getDirectoryHandle('fde2e-render-cache', { create: true });
  const id = crypto.randomUUID(); const dir = await cache.getDirectoryHandle(id, { create: true });
  const files: File[] = []; const f = new FFmpeg(); let closed = false; let loaded = false;
  const terminate = () => { f.terminate(); };
  request.signal.addEventListener('abort', terminate, { once: true });
  const cleanup = async () => {
    if (closed) return; closed = true;
    request.signal.removeEventListener('abort', terminate);
    f.terminate(); files.length = 0;
    await cache.removeEntry(id, { recursive: true }).catch(() => {});
  };
  const stage = async (name: string, blob: Blob) => {
    request.signal.throwIfAborted();
    const handle = await dir.getFileHandle(name, { create: true }); const writer = await handle.createWritable();
    try { await writer.write(blob); await writer.close(); } catch (e) { await writer.abort().catch(() => {}); throw e; }
    files.push(await handle.getFile());
  };
  let frames = 0;
  return {
    codec: format.codec,
    async add(canvas: HTMLCanvasElement) {
      if (closed) throw new Error('encoder is closed');
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG frame encoding failed');
      await stage(`frame-${String(frames++).padStart(8,'0')}.png`, blob);
    },
    async finalize(): Promise<WasmResult> {
      if (closed) throw new Error('encoder is closed');
      try {
        if (request.audio) await stage('audio.wav', audioWav(request.audio));
        request.signal.throwIfAborted();
        await f.load(ffmpegAssetUrls(location.origin)); loaded = true;
        request.signal.throwIfAborted();
        await f.createDir('/input'); await f.mount(FFFSType.WORKERFS, { files }, '/input');
        f.on('progress', ({ progress }) => request.progress?.(Math.max(0, Math.min(1, progress))));
        const inputs = frames ? ['-framerate',String(request.fps),'-i','/input/frame-%08d.png'] : [];
        if (request.audio) inputs.push('-i','/input/audio.wav');
        if (!inputs.length) throw new Error('no frames or audio to encode');
        const output = `/output.${format.extension}`;
        const encoding=[...format.args];const crf=encoding.indexOf('-crf');
        if(crf>=0)encoding[crf+1]=String(({standard:24,high:20,master:14}[request.quality??'high'])+(request.format==='vp9'?10:0));
        const args = ['-threads','1','-filter_threads','1','-filter_complex_threads','1',...inputs,...encoding,'-threads','1','-y',output];
        if (await f.exec(args) !== 0) throw new Error(`ST encoder failed for ${request.format}`);
        request.signal.throwIfAborted(); const bytes = await f.readFile(output);
        if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('encoder returned no bytes');
        return { blob: new Blob([bytes as BlobPart], { type: format.mime }), codec: format.codec, extension: format.extension };
      } finally { if (loaded) await f.unmount('/input').catch(() => {}); await cleanup(); }
    },
    cancel: cleanup,
  };
}
