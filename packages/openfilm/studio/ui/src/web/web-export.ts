/**
 * The pure-Web export queue. ProjectView supplies the live preview as a pixel source; this module
 * owns one job at a time, drives it on the `(i + 0.5) / fps` grid, encodes in-page, writes the
 * finished bytes atomically to OPFS `downloads/`, and tells both UI and WebMCP the same receipts.
 */
import type { ExportJob, ExportRequest } from '../lib/export-jobs.ts';
import { exportFramedDims, exportGifDims } from '../lib/export-spec.ts';
import { filmFrameBox, type FilmFrameFill, type FilmFrameId } from '../lib/film-frame.ts';
import { renderSelection, selectionFrame } from '../../../../src/render-ranges.mjs';
import {subtitleFile,burnCaptions} from './export-captions.ts';

export interface PreviewPixelSource {
  open?(signal:AbortSignal):Promise<{source:PreviewPixelSource;close():void|Promise<void>}>;
  ready?(): boolean;
  seek(t: number): Promise<void>;
  capture(transparent?: boolean): Promise<ImageBitmap | HTMLCanvasElement>;
  clip?(id: string): Promise<PreviewPixelSource>;
  captionTime?(local:number):number;
  size(): { w: number; h: number };
  duration(): number;
  /** Optional project mix for a requested film range. Null means the film is silent. */
  audio?(from: number, to: number, signal?: AbortSignal): Promise<AudioBuffer | null>;
  stems?(from: number, to: number, signal?:AbortSignal): Promise<Array<{ name: string; buffer: AudioBuffer }>>;
}

type JobsState = { jobs: Map<string, ExportJob>; running: string | null };
const state = new Map<string, JobsState>();
const listeners = new Set<(job: ExportJob) => void>();
const completionListeners = new Set<(job: ExportJob) => void>();
const temporaryJobs = new Set<string>();
const aborts = new Map<string, AbortController>();
const queued = new Map<string, Array<{ id: string; run: () => void }>>();
// Publish terminal receipts only after the isolated source is closed and the
// writer is handed to the next queued job. Completion listeners may re-enter.
const terminal = new Map<string, Partial<ExportJob>>();
let fallbackJobSequence = 0;

const newJobId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `web-${globalThis.crypto.randomUUID()}`;
  fallbackJobSequence += 1;
  return `web-${Date.now().toString(36)}-${fallbackJobSequence.toString(36)}`;
};

export function onWebExportJob(listener: (job: ExportJob) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const tell = (job: ExportJob) => {
  for (const fn of [...completionListeners]) fn(job);
  if (!temporaryJobs.has(job.id)) for (const fn of [...listeners]) fn(job);
};
const jobsOf = (projectId: string): JobsState => {
  let found = state.get(projectId);
  if (!found) { found = { jobs: new Map(), running: null }; state.set(projectId, found); }
  return found;
};
export const listWebExports = (projectId: string): ExportJob[] => [...jobsOf(projectId).jobs.values()].filter(job => !temporaryJobs.has(job.id));
export const webExportBusy = (projectId: string): boolean => jobsOf(projectId).running != null;
export const webExportBytes = (projectId: string): number => [...jobsOf(projectId).jobs.values()].reduce((sum, job) => sum + (job.bytes ?? 0), 0);
export function forgetTemporaryWebExport(projectId:string,id:string):void {
  const job=jobsOf(projectId).jobs.get(id);
  if(job && !['waiting','running'].includes(job.status)){jobsOf(projectId).jobs.delete(id);temporaryJobs.delete(id);}
}

export function webExportSupports(request: ExportRequest): boolean {
  if (request.kind === 'video') return ['h264', 'vp9', 'hevc', 'prores422hq', 'prores4444', 'png', 'mkv'].includes(request.codec);
  if (request.kind === 'audio') return ['wav', 'm4a', 'mp3'].includes(request.format);
  return request.kind === 'stills' || request.kind === 'poster' || request.kind === 'gif' || request.kind === 'subtitles' || (request.kind === 'project' && request.as === 'zip' && !request.parts.length);
}
const wasmAvailable = () => typeof Worker !== 'undefined' && typeof WebAssembly === 'object';
export const webExportCapabilities = () => ({
  h264: typeof VideoEncoder !== 'undefined' || wasmAvailable(), hevc: wasmAvailable(), hevcAlpha: false,
  vp9: wasmAvailable(), prores: wasmAvailable(), proresChip: false, mp3: wasmAvailable(),
});

export function cancelWebExport(projectId: string, jobId: string): boolean {
  const jobs = jobsOf(projectId);
  const waiting = queued.get(projectId); const index = waiting?.findIndex((entry) => entry.id === jobId) ?? -1;
  if (waiting && index >= 0) {
    waiting.splice(index, 1); setJob(projectId, jobId, {status:'cancelled',finishedAt:Date.now()}); return true;
  }
  if (!jobs.jobs.has(jobId) || jobs.running !== jobId) return false;
  aborts.get(jobId)?.abort();
  return true;
}

export interface WebExportDeps {
  /** Inspection shares the capture lock but never appears as a downloadable export. */
  temporary?: boolean;
  putFile: (id: string, path: string, data: Blob) => Promise<void>;
  readFile?: (id: string, path: string) => Promise<ArrayBuffer | null>;
  ffmpegRun?: (input: { name: string; bytes: Uint8Array }, args: string[], outputName: string) => Promise<Uint8Array>;
}

async function audioForRanges(source: PreviewPixelSource, ranges: number[][], signal: AbortSignal): Promise<AudioBuffer | null> {
  if (!source.audio) throw new Error('the preview has no audio mixer');
  const segments: Array<{buffer:AudioBuffer|null;seconds:number}> = [];
  for(const [from,to] of ranges) { signal.throwIfAborted(); segments.push({buffer:await source.audio(from,to,signal),seconds:to-from}); }
  const first = segments.find(s=>s.buffer)?.buffer; if(!first)return null;
  if(segments.length===1)return first;
  const rate=first.sampleRate;const result=new AudioBuffer({numberOfChannels:first.numberOfChannels,sampleRate:rate,length:Math.round(segments.reduce((n,s)=>n+s.seconds,0)*rate)});
  let offset=0;for(const part of segments){const length=Math.round(part.seconds*rate);if(part.buffer){if(part.buffer.sampleRate!==rate)throw new Error('audio sample rates changed across ranges');for(let c=0;c<result.numberOfChannels;c++)result.copyToChannel(part.buffer.getChannelData(Math.min(c,part.buffer.numberOfChannels-1)).subarray(0,length),c,offset);}offset+=length;}
  return result;
}

export function startWebExport(projectId: string, request: ExportRequest, source: PreviewPixelSource, deps: WebExportDeps, enqueue = false): ExportJob {
  if (!webExportSupports(request)) throw Object.assign(new Error(`本站暂不支持 ${request.kind} 导出——MP4/WebM/ProRes、音轨、静帧、海报和 GIF 可用`), { code: 'E_EXPORT_UNSUPPORTED' });
  const jobs = jobsOf(projectId);
  if (!enqueue && jobs.running != null) throw Object.assign(new Error('已有导出在进行——等它完成或先取消'), { code: 'E_EXPORT_BUSY' });
  /* The abort registry is process-wide while one writer is allowed *per project*. A timestamp-only
     id can collide when two projects start in the same millisecond and make cancelling one abort
     the other. Use a real unique identity, with a monotonic fallback for older browsers. */
  const id = newJobId();
  const now = Date.now();
  const job: ExportJob = {
    id, project: projectId, name: request.name ?? request.label ?? 'Export', label: request.label ?? '', kind: request.kind,
    status: 'waiting', phase: null, progress: 0, framesDone: 0, framesTotal: 0, rate: 0, etaMs: null,
    encoder: null, outputs: [], bytes: null, alpha: null, at: now, startedAt: null, finishedAt: null,
  };
  if (deps.temporary) temporaryJobs.add(id);
  jobs.jobs.set(id, job); tell({ ...job });
  const run = () => { jobs.running = id; void work(projectId, id, request, source, deps).catch((error) => {
    const current = jobs.jobs.get(id);
    if (!current || current.status === 'cancelled') return;
    if (error?.name === 'AbortError') { cancelled(id); return; }
    terminal.set(id, { status: 'failed', phase: null, error: error instanceof Error ? error.message : String(error), finishedAt: Date.now() });
  }).finally(() => {
    if (jobs.running === id) {
      jobs.running = null;
      const next = queued.get(projectId)?.shift(); next?.run();
    }
    const receipt = terminal.get(id); terminal.delete(id);
    if (receipt) setJob(projectId, id, receipt);
  }); };
  if (jobs.running !== null) { const list = queued.get(projectId) ?? []; list.push({id,run}); queued.set(projectId,list); }
  else run();
  return job;
}

/** Validate the entire selection first; every accepted request obtains an observable queued job. */
export function queueWebExports(projectId: string, requests: ExportRequest[], source: PreviewPixelSource, deps: WebExportDeps): ExportJob[] {
  if (requests.some((request) => !webExportSupports(request))) throw new Error('selection contains an unsupported export');
  return requests.map((request) => startWebExport(projectId, request, source, deps, true));
}

const setJob = (projectId: string, id: string, patch: Partial<ExportJob>): ExportJob | null => {
  const job = jobsOf(projectId).jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch); tell({ ...job }); return job;
};
const cancelled = (id: string): void => {
  terminal.set(id, { status: 'cancelled', phase: null, finishedAt: Date.now() });
};
const done = (id: string, outputs: string[], bytes: number, encoder: string): void => {
  terminal.set(id, { status: 'done', phase: null, progress: 1, outputs, bytes, encoder, finishedAt: Date.now() });
};

async function freePath(projectId: string, path: string, deps: WebExportDeps): Promise<string> {
  if (!deps.readFile) return path;
  const slash = path.lastIndexOf('/'); const dot = path.lastIndexOf('.');
  const prefix = dot > slash ? path.slice(0, dot) : path; const ext = dot > slash ? path.slice(dot) : '';
  let candidate = path;
  for (let index = 2; await deps.readFile(projectId, candidate); index += 1) candidate = `${prefix} ${index}${ext}`;
  return candidate;
}

async function putOutput(projectId: string, name: string, ext: string, blob: Blob, deps: WebExportDeps): Promise<string> {
  const path = await freePath(projectId, `downloads/${fileName(name, ext)}`, deps);
  await deps.putFile(projectId, path, blob);
  return path;
}

function outputCanvas(image: CanvasImageSource, stage: { w: number; h: number }, out: { w: number; h: number }, frame: FilmFrameId, fill: FilmFrameFill, alpha = false): HTMLCanvasElement {
  const box = filmFrameBox(stage, frame, fill);
  const sx = box.inner.left / box.w * out.w; const sy = box.inner.top / box.h * out.h;
  const sw = box.inner.w / box.w * out.w; const sh = box.inner.h / box.h * out.h;
  const canvas = document.createElement('canvas'); canvas.width = out.w; canvas.height = out.h;
  const ctx = canvas.getContext('2d', { alpha: true }); if (!ctx) throw new Error('2D canvas is unavailable');
  if (!alpha) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, out.w, out.h); }
  ctx.drawImage(image, sx, sy, sw, sh);
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
  return canvas;
}

async function work(projectId: string, id: string, request: ExportRequest, source: PreviewPixelSource, deps: WebExportDeps): Promise<void> {
  const abort = new AbortController(); aborts.set(id, abort);
  let isolated:Awaited<ReturnType<NonNullable<PreviewPixelSource['open']>>>|undefined;
  try {
    setJob(projectId, id, { status: 'running', startedAt: Date.now(), phase: 'rendering' });
    if(source.open&&request.kind!=='project'&&request.kind!=='subtitles'){isolated=await source.open(abort.signal);source=isolated.source;}
    if(request.kind==='video'&&request.clip){if(!source.clip)throw new Error('clip capture is unavailable');source=await source.clip(request.clip);}
    const stage = source.size();
    if (request.kind === 'project') {
      const { buildPackage, zipEntries } = await import('./interchange.ts');
      const pack = await buildPackage(projectId); abort.signal.throwIfAborted();
      const blob = new Blob([zipEntries(pack.entries)],{type:'application/zip'});
      done(id,[await putOutput(projectId,request.name??pack.name,'zip',blob,deps)],blob.size,'project/ZIP');return;
    }
    if (request.kind === 'subtitles') {
      const blob=await subtitleFile(projectId,request.format,request.ranges??[request.range??[0,source.duration()]]);
      done(id,[await putOutput(projectId,request.name??'Subtitles',request.format,blob,deps)],blob.size,'subtitles/text');return;
    }
    if (request.kind === 'video' || request.kind === 'gif') {
      const fps = request.fps;
      const ranges = request.ranges ?? [request.range ?? [0, source.duration()]];
      const selection = renderSelection(ranges, fps, source.duration()); const frameCount = selection.count;
      const frame = request.frame ?? 'native'; const fill = request.fill ?? 'contain';
      const out = request.kind === 'video'
        ? exportFramedDims(stage, frame, fill, request.clip ? Math.min(stage.w,stage.h)*(request.scale??1) : request.shortEdge ?? Math.min(stage.w, stage.h))
        : exportGifDims(filmFrameBox(stage, frame, fill), request.width);
      setJob(projectId, id, { framesTotal: frameCount, ...(request.kind === 'video' && request.audio ? { phase: 'audio' as const } : {}) });
      if (request.kind === 'video' && request.audio && !source.audio) throw new Error('the Web preview has no audio mixer');
      const audio = request.kind === 'video' && request.audio ? await audioForRanges(source, selection.spans.map((s: {from:number;to:number}) => [s.from,s.to]), abort.signal) : null;
      setJob(projectId, id, { phase: 'rendering' });
      if(request.kind==='video' && request.codec==='png') {
        const zip=await(await import('./export-zip.ts')).exportZip(abort.signal);
        try {
        for(let index=0;index<frameCount;index++){
          abort.signal.throwIfAborted();await source.seek((selectionFrame(selection.spans,index)+0.5)/fps);
          const canvas=outputCanvas(await source.capture(true),stage,out,frame,fill,true);
          if(request.burnSubtitles){const t=(selectionFrame(selection.spans,index)+0.5)/fps;await burnCaptions(canvas,projectId,source.captionTime?.(t)??t);}
          const blob=await new Promise<Blob|null>(r=>canvas.toBlob(r,'image/png'));if(!blob)throw new Error('frame encoding failed');
          await zip.add(`frame-${String(index+1).padStart(6,'0')}.png`,blob);
          setJob(projectId,id,{framesDone:index+1,progress:(index+1)/frameCount});
        }
        const blob=await zip.finish();
        done(id,[await putOutput(projectId,request.name??id,'zip',blob,deps)],blob.size,'PNG/ZIP');return;
        } finally {await zip.cleanup();}
      }
      const format = request.kind === 'gif' ? 'gif' : request.codec as import('./wasm-encode-session.ts').WasmFormat;
      const makeWasm = async () => (await import('./wasm-encode-session.ts')).createWasmEncodeSession({
        format, fps, audio, signal: abort.signal, quality:request.kind==='video'?request.quality:undefined,
        progress: (value) => setJob(projectId, id, { phase: 'encoding', progress: 0.8 + value * 0.19 }),
      });
      let encoder: { codec: string; add(canvas: HTMLCanvasElement): Promise<void>; finalize(): Promise<{ blob: Blob; codec: string; extension: string }>; cancel(): Promise<void> };
      // WebCodecs VP9 drops alpha. The ST libvpx path preserves the WebM contract.
      if (request.kind === 'video' && request.codec === 'h264') {
        try {
          const { createVideoEncodeSession } = await import('./encode-backend.ts');
          const main = await createVideoEncodeSession({ width: out.w, height: out.h, fps,
            videoBitrate: Math.min(120_000_000,Math.max(2_000_000,out.w*out.h*fps*({standard:0.07,high:0.11,master:0.2}[request.quality]))),
            container: 'mp4', ...(audio ? { audio: [{ buffer: audio }] } : {}) });
          encoder = { ...main, finalize: async () => { const r = await main.finalize(); return { ...r, extension: r.container }; } };
        } catch (error) {
          if ((error as Error).name !== 'EncodeUnsupportedError') throw error;
          encoder = await makeWasm();
        }
      } else encoder = await makeWasm();
      setJob(projectId, id, { encoder: encoder.codec });
      let encoderSettled = false;
      try {
        const started = Date.now();
        for (let index = 0; index < frameCount; index += 1) {
          if (abort.signal.aborted) { cancelled(id); return; }
          const at = (selectionFrame(selection.spans, index) + 0.5) / fps;
          await source.seek(at);
          if (abort.signal.aborted) { cancelled(id); return; }
          const alpha = request.kind === 'video' && (request.codec === 'prores4444' || request.codec === 'vp9');
          const captured = await source.capture(alpha);
          if (abort.signal.aborted) { cancelled(id); return; }
          const canvas=outputCanvas(captured, stage, out, frame, fill, alpha);
          if(request.burnSubtitles)await burnCaptions(canvas,projectId,source.captionTime?.(at)??at);
          await encoder.add(canvas);
          const made = index + 1; const rate = made / Math.max(0.001, (Date.now() - started) / 1000);
          setJob(projectId, id, { framesDone: made, progress: (made / frameCount) * 0.8, rate: Math.round(rate * 10) / 10, etaMs: Math.round((frameCount - made) / Math.max(rate, 0.001) * 1000) });
          if (index % 30 === 29) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        setJob(projectId, id, { phase: 'encoding', progress: 0.85 });
        const name = request.name ?? id;
        const intermediate = await encoder.finalize();
        encoderSettled = true;
        if (abort.signal.aborted) { cancelled(id); return; }
        const path = await putOutput(projectId, name, intermediate.extension, intermediate.blob, deps);
        const outputs=[path];let bytes=intermediate.blob.size;
        if(request.kind==='video'&&request.sidecar){const captions=ranges.map(([a,b])=>[source.captionTime?.(a)??a,source.captionTime?.(b)??b]);const blob=await subtitleFile(projectId,request.sidecar,captions);outputs.push(await putOutput(projectId,name,request.sidecar,blob,deps));bytes+=blob.size;}
        done(id, outputs, bytes, intermediate.codec); return;
      } finally {
        if (!encoderSettled) await encoder.cancel().catch(() => {});
      }
    }
    if (request.kind === 'audio') {
      if (!source.audio) throw new Error('the preview has no audio mixer');
      const ranges = request.ranges ?? [request.range ?? [0, source.duration()]];
      const tracks: Array<{ name: string; buffer: AudioBuffer }> = [];
      if (request.mix) { const mix = await audioForRanges(source, ranges, abort.signal); if (mix) tracks.push({ name: request.name ?? 'Mix', buffer: mix }); }
      if (request.stems) {
        if (!source.stems) throw new Error('audio stems are unavailable');
        const parts:Array<Array<{name:string;buffer:AudioBuffer}>>=[];for(const [from,to] of ranges){abort.signal.throwIfAborted();parts.push(await source.stems(from,to,abort.signal));}
        for(const name of new Set(parts.flatMap(p=>p.map(t=>t.name)))){
          let segment=0;
          const buffer=await audioForRanges({...source,audio:async()=>parts[segment++]?.find(t=>t.name===name)?.buffer??null},ranges,abort.signal);
          if(buffer)tracks.push({name,buffer});
        }
      }
      if (!tracks.length) throw new Error('the selected range has no audible tracks');
      const outputs: string[] = []; let bytes = 0;
      const { createWasmEncodeSession } = await import('./wasm-encode-session.ts');
      for (const [index, track] of tracks.entries()) {
        abort.signal.throwIfAborted();
        const encoder = await createWasmEncodeSession({ format: request.format, fps: 1, audio: track.buffer, signal: abort.signal,
          progress: (value) => setJob(projectId, id, { phase: 'audio', progress: (index + value) / tracks.length }) });
        try {
          const result = await encoder.finalize();
          outputs.push(await putOutput(projectId, track.name, result.extension, result.blob, deps)); bytes += result.blob.size;
        } finally { await encoder.cancel(); }
      }
      done(id, outputs, bytes, `${request.format}/ST`); return;
    }
    if (request.kind === 'stills' || request.kind === 'poster') {
      const times = request.kind === 'poster' ? [request.at ?? 0] : (request.at ?? [0]);
      const format = request.format; const frame = request.frame ?? 'native'; const fill = request.fill ?? 'contain';
      const out = exportFramedDims(stage, frame, fill, request.shortEdge ?? Math.min(stage.w, stage.h));
      const outputs: string[] = []; let bytes = 0;
      for (const [index, at] of times.entries()) {
        if (abort.signal.aborted) { cancelled(id); return; }
        await source.seek(at);
        if (abort.signal.aborted) { cancelled(id); return; }
        const captured = await source.capture();
        if (abort.signal.aborted) { cancelled(id); return; }
        const canvas = outputCanvas(captured, stage, out, frame, fill);
        if(request.burnSubtitles)await burnCaptions(canvas,projectId,at);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, format === 'jpg' ? 'image/jpeg' : 'image/png', 0.92));
        if (!blob) throw new Error('frame encoding returned no bytes');
        const suffix = times.length > 1 ? `-${String(index + 1).padStart(2, '0')}` : '';
        outputs.push(await putOutput(projectId, `${request.name ?? id}${suffix}`, format, blob, deps)); bytes += blob.size;
        setJob(projectId, id, { framesDone: index + 1, framesTotal: times.length, progress: ((index + 1) / times.length) * 0.95 });
      }
      if(request.kind==='stills'&&request.as==='zip'){
        const {zipEntries}=await import('./interchange.ts');const entries=[];
        for(const path of outputs){const data=await deps.readFile?.(projectId,path);if(!data)throw new Error('image bytes are missing');entries.push({path:path.split('/').at(-1)!,bytes:data});}
        const blob=new Blob([zipEntries(entries)],{type:'application/zip'});
        done(id,[await putOutput(projectId,request.name??id,'zip',blob,deps)],blob.size,'PNG/ZIP');return;
      }
      done(id, outputs, bytes, format.toUpperCase()); return;
    }
    throw new Error(`unsupported web export kind: ${request.kind}`);
  } catch (error) {
    // Closing a render window can reject an in-flight capture with a CDP error
    // rather than AbortError. The job's own signal is the cancellation authority.
    if (abort.signal.aborted) { cancelled(id); return; }
    throw error;
  } finally {try{await isolated?.close();}finally{aborts.delete(id);} }
}

export async function waitForWebExport(projectId: string, jobId: string, signal?: AbortSignal): Promise<ExportJob> {
  const current = jobsOf(projectId).jobs.get(jobId);
  if (!current) throw new Error(`no such export: ${jobId}`);
  if (current.status !== 'waiting' && current.status !== 'running') return { ...current };
  return await new Promise<ExportJob>((resolve, reject) => {
    let stop = () => {};
    const cleanup = () => { stop(); signal?.removeEventListener('abort', abort); };
    const settle = (job: ExportJob) => { cleanup(); resolve({ ...job }); };
    const abort = () => {
      cleanup();
      cancelWebExport(projectId, jobId);
      reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
    };
    const listener = (job: ExportJob) => {
      if (job.project !== projectId || job.id !== jobId || job.status === 'waiting' || job.status === 'running') return;
      settle(job);
    };
    completionListeners.add(listener);
    stop = () => { completionListeners.delete(listener); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    /* The job can settle between the first read above and listener registration. Re-read after
       subscribing so a fast one-frame export cannot leave the waiter asleep forever. */
    const latest = jobsOf(projectId).jobs.get(jobId);
    if (latest && latest.status !== 'waiting' && latest.status !== 'running') settle(latest);
  });
}

export async function downloadWebExport(projectId: string, jobId: string, readFile: (id: string, path: string) => Promise<ArrayBuffer | null>): Promise<{ name: string; size: number; paths: string[] }> {
  const job = jobsOf(projectId).jobs.get(jobId);
  const paths = job?.status === 'done' ? job.outputs : [];
  if (!job || paths.length === 0) throw new Error('the export is not ready');
  const entries = await Promise.all(paths.map(async (path) => {
    const bytes = await readFile(projectId, path);
    if (!bytes) throw new Error(`the export bytes are gone: ${path}`);
    return { path: path.split('/').pop() ?? path, bytes };
  }));
  const single = entries.length === 1 ? entries[0]! : null;
  const blob = single
    ? new Blob([single.bytes], { type: mimeForExport(single.path) })
    : new Blob([(await import('./interchange.ts')).zipEntries(entries)], { type: 'application/zip' });
  const downloadName = single?.path ?? fileName(job.name, 'zip');
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = downloadName; anchor.hidden = true;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { name: downloadName, size: blob.size, paths: [...paths] };
}

const mimeForExport = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase();
  return ({ mp4: 'video/mp4', mkv:'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
};

const fileName = (base: string, ext: string): string => {
  const clean = base.trim().replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').slice(0, 80) || 'export';
  return `${clean}.${ext}`;
};
