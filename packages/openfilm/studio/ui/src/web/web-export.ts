/**
 * The pure-Web export queue. ProjectView supplies the live preview as a pixel source; this module
 * owns one job at a time, drives it on the `(i + 0.5) / fps` grid, encodes in-page, writes the
 * finished bytes atomically to OPFS `downloads/`, and tells both UI and WebMCP the same receipts.
 */
import type { ExportJob, ExportRequest } from '../lib/export-jobs.ts';
import { exportFramedDims, exportGifDims } from '../lib/export-spec.ts';
import { filmFrameBox, type FilmFrameFill, type FilmFrameId } from '../lib/film-frame.ts';

export interface PreviewPixelSource {
  seek(t: number): Promise<void>;
  capture(): Promise<ImageBitmap | HTMLCanvasElement>;
  size(): { w: number; h: number };
  duration(): number;
  /** Optional project mix for a requested film range. Null means the film is silent. */
  audio?(from: number, to: number): Promise<AudioBuffer | null>;
}

type JobsState = { jobs: Map<string, ExportJob>; running: string | null };
const state = new Map<string, JobsState>();
const listeners = new Set<(job: ExportJob) => void>();
const aborts = new Map<string, AbortController>();
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
const tell = (job: ExportJob) => { for (const fn of [...listeners]) fn(job); };
const jobsOf = (projectId: string): JobsState => {
  let found = state.get(projectId);
  if (!found) { found = { jobs: new Map(), running: null }; state.set(projectId, found); }
  return found;
};
export const listWebExports = (projectId: string): ExportJob[] => [...jobsOf(projectId).jobs.values()];
export const webExportBusy = (projectId: string): boolean => jobsOf(projectId).running != null;
export const webExportBytes = (projectId: string): number => [...jobsOf(projectId).jobs.values()].reduce((sum, job) => sum + (job.bytes ?? 0), 0);

export function webExportSupports(request: ExportRequest): boolean {
  if (request.kind === 'video') return request.codec === 'h264' || request.codec === 'vp9';
  return request.kind === 'stills' || request.kind === 'poster' || request.kind === 'gif';
}
export const webExportCapabilities = () => ({
  h264: typeof VideoEncoder !== 'undefined', hevc: false, hevcAlpha: false,
  vp9: typeof VideoEncoder !== 'undefined', prores: false, proresChip: false, mp3: false,
});

export function cancelWebExport(projectId: string, jobId: string): boolean {
  const jobs = jobsOf(projectId);
  if (!jobs.jobs.has(jobId) || jobs.running !== jobId) return false;
  aborts.get(jobId)?.abort();
  return true;
}

export interface WebExportDeps {
  putFile: (id: string, path: string, data: Blob) => Promise<void>;
  readFile?: (id: string, path: string) => Promise<ArrayBuffer | null>;
  ffmpegRun?: (input: { name: string; bytes: Uint8Array }, args: string[], outputName: string) => Promise<Uint8Array>;
}

export function startWebExport(projectId: string, request: ExportRequest, source: PreviewPixelSource, deps: WebExportDeps): ExportJob {
  if (!webExportSupports(request)) throw Object.assign(new Error(`本站暂不支持 ${request.kind} 导出——MP4/WebM、静帧、海报和 GIF 可用`), { code: 'E_EXPORT_UNSUPPORTED' });
  const jobs = jobsOf(projectId);
  if (jobs.running != null) throw Object.assign(new Error('已有导出在进行——等它完成或先取消'), { code: 'E_EXPORT_BUSY' });
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
  jobs.jobs.set(id, job); jobs.running = id; tell({ ...job });
  void work(projectId, id, request, source, deps).catch((error) => {
    const current = jobs.jobs.get(id);
    if (!current || current.status === 'cancelled') return;
    Object.assign(current, { status: 'failed', phase: null, error: error instanceof Error ? error.message : String(error), finishedAt: Date.now() });
    jobs.running = null; tell({ ...current });
  });
  return job;
}

const setJob = (projectId: string, id: string, patch: Partial<ExportJob>): ExportJob | null => {
  const job = jobsOf(projectId).jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch); tell({ ...job }); return job;
};
const cancelled = (projectId: string, id: string): void => {
  const jobs = jobsOf(projectId);
  setJob(projectId, id, { status: 'cancelled', phase: null, finishedAt: Date.now() });
  jobs.running = null;
};
const done = (projectId: string, id: string, outputs: string[], bytes: number, encoder: string): void => {
  const jobs = jobsOf(projectId);
  setJob(projectId, id, { status: 'done', phase: null, progress: 1, outputs, bytes, encoder, finishedAt: Date.now() });
  jobs.running = null;
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

function outputCanvas(image: CanvasImageSource, stage: { w: number; h: number }, out: { w: number; h: number }, frame: FilmFrameId, fill: FilmFrameFill): HTMLCanvasElement {
  const box = filmFrameBox(stage, frame, fill);
  const sx = box.inner.left / box.w * out.w; const sy = box.inner.top / box.h * out.h;
  const sw = box.inner.w / box.w * out.w; const sh = box.inner.h / box.h * out.h;
  const canvas = document.createElement('canvas'); canvas.width = out.w; canvas.height = out.h;
  const ctx = canvas.getContext('2d', { alpha: true }); if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, out.w, out.h); ctx.drawImage(image, sx, sy, sw, sh);
  return canvas;
}

async function work(projectId: string, id: string, request: ExportRequest, source: PreviewPixelSource, deps: WebExportDeps): Promise<void> {
  const abort = new AbortController(); aborts.set(id, abort);
  try {
    setJob(projectId, id, { status: 'running', startedAt: Date.now(), phase: 'rendering' });
    const stage = source.size();
    if (request.kind === 'video' || request.kind === 'gif') {
      const fps = request.fps;
      const range = request.range ?? request.ranges?.[0] ?? [0, source.duration()];
      if (!range || !(range[1] > range[0])) throw new Error('a Web video/GIF export needs an explicit non-empty range');
      const [from, to] = range; const frameCount = Math.max(1, Math.round((to - from) * fps));
      const frame = request.frame ?? 'native'; const fill = request.fill ?? 'contain';
      const out = request.kind === 'video'
        ? exportFramedDims(stage, frame, fill, request.shortEdge ?? Math.min(stage.w, stage.h))
        : exportGifDims(filmFrameBox(stage, frame, fill), request.width);
      setJob(projectId, id, { framesTotal: frameCount, ...(request.kind === 'video' && request.audio ? { phase: 'audio' as const } : {}) });
      if (request.kind === 'video' && request.audio && !source.audio) throw new Error('the Web preview has no audio mixer');
      const audio = request.kind === 'video' && request.audio ? await source.audio!(from, to) : null;
      setJob(projectId, id, { phase: 'rendering' });
      const { createVideoEncodeSession } = await import('./encode-backend.ts');
      const encoder = await createVideoEncodeSession({
        width: out.w, height: out.h, fps,
        container: request.kind === 'video' && request.codec === 'vp9' ? 'webm' : 'mp4',
        ...(audio ? { audio: [{ buffer: audio }] } : {}),
      });
      let encoderSettled = false;
      try {
        const started = Date.now();
        for (let index = 0; index < frameCount; index += 1) {
          if (abort.signal.aborted) { cancelled(projectId, id); return; }
          const at = from + (index + 0.5) / fps;
          await source.seek(at);
          if (abort.signal.aborted) { cancelled(projectId, id); return; }
          const captured = await source.capture();
          if (abort.signal.aborted) { cancelled(projectId, id); return; }
          await encoder.add(outputCanvas(captured, stage, out, frame, fill));
          const made = index + 1; const rate = made / Math.max(0.001, (Date.now() - started) / 1000);
          setJob(projectId, id, { framesDone: made, progress: (made / frameCount) * 0.8, rate: Math.round(rate * 10) / 10, etaMs: Math.round((frameCount - made) / Math.max(rate, 0.001) * 1000) });
          if (index % 30 === 29) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        setJob(projectId, id, { phase: 'encoding', progress: 0.85 });
        const name = request.name ?? id;
        const intermediate = await encoder.finalize();
        encoderSettled = true;
        if (abort.signal.aborted) { cancelled(projectId, id); return; }
        if (request.kind === 'video') {
          const path = await putOutput(projectId, name, intermediate.container, intermediate.blob, deps);
          done(projectId, id, [path], intermediate.blob.size, intermediate.codec); return;
        }
        const run = deps.ffmpegRun ?? (await import('./ffmpeg-fallback.ts')).ffmpegRun;
        const inputName = `${id}.mp4`; const outputName = `${id}.gif`;
        const bytes = await run({ name: inputName, bytes: new Uint8Array(await intermediate.blob.arrayBuffer()) }, ['-i', inputName, '-filter_complex', `[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`, '-loop', '0', outputName], outputName);
        const blob = new Blob([bytes as BlobPart], { type: 'image/gif' });
        const path = await putOutput(projectId, name, 'gif', blob, deps); done(projectId, id, [path], blob.size, 'gif (palettegen/paletteuse)'); return;
      } finally {
        if (!encoderSettled) await encoder.cancel().catch(() => {});
      }
    }
    if (request.kind === 'stills' || request.kind === 'poster') {
      const times = request.kind === 'poster' ? [request.at ?? 0] : (request.at ?? [0]);
      const format = request.format; const frame = request.frame ?? 'native'; const fill = request.fill ?? 'contain';
      const out = exportFramedDims(stage, frame, fill, request.shortEdge ?? Math.min(stage.w, stage.h));
      const outputs: string[] = []; let bytes = 0;
      for (const [index, at] of times.entries()) {
        if (abort.signal.aborted) { cancelled(projectId, id); return; }
        await source.seek(at);
        if (abort.signal.aborted) { cancelled(projectId, id); return; }
        const captured = await source.capture();
        if (abort.signal.aborted) { cancelled(projectId, id); return; }
        const canvas = outputCanvas(captured, stage, out, frame, fill);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, format === 'jpg' ? 'image/jpeg' : 'image/png', 0.92));
        if (!blob) throw new Error('frame encoding returned no bytes');
        const suffix = times.length > 1 ? `-${String(index + 1).padStart(2, '0')}` : '';
        outputs.push(await putOutput(projectId, `${request.name ?? id}${suffix}`, format, blob, deps)); bytes += blob.size;
        setJob(projectId, id, { framesDone: index + 1, framesTotal: times.length, progress: ((index + 1) / times.length) * 0.95 });
      }
      done(projectId, id, outputs, bytes, format.toUpperCase()); return;
    }
    throw new Error(`unsupported web export kind: ${request.kind}`);
  } finally { aborts.delete(id); }
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
    stop = onWebExportJob((job) => {
      if (job.project !== projectId || job.id !== jobId || job.status === 'waiting' || job.status === 'running') return;
      settle(job);
    });
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
  anchor.href = url; anchor.download = downloadName; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { name: downloadName, size: blob.size, paths: [...paths] };
}

const mimeForExport = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase();
  return ({ mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
};

const fileName = (base: string, ext: string): string => {
  const clean = base.trim().replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').slice(0, 80) || 'export';
  return `${clean}.${ext}`;
};
