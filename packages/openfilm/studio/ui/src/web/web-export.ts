/**
 * The web face's export queue (3.3 留档落点): the export tray's jobs, worked by the page
 * itself — the preview's pixels on the (i+0.5)/fps grid (export-pump) for video/stills/
 * poster, the ffmpeg.wasm fallback (3.5) for gif/audio, the encoder (3.4) underneath.
 * Products land in the project's `downloads/` folder (OPFS, putFile) and are told through
 * the store's own event — the tray and the panels follow them the same way they follow the
 * server face's jobs (lib/export-jobs ExportJob shape, same status ladder).
 *
 * One queue at a time per project (the capture lanes are single-shot devices and the
 * preview serves one film); a start while one is running is refused (`E_EXPORT_BUSY`),
 * never silently queued — the caller sees what happened. Same ids the tray tracks
 * (`web-<ts36>`); every state change re-tells the whole job (the tray's merge is idempotent).
 */
import type { ExportJob, ExportRequest } from '../lib/export-jobs.ts';

/** The preview's pixel face (PreviewHandle.frame's iframe + seek): what a web export drives. */
export interface PreviewPixelSource {
  /** Seek the preview to film second `t` and resolve when the picture is drawn. */
  seek(t: number): Promise<void>;
  /** Read the current picture as pixels (offscreen canvas draw). */
  capture(): Promise<ImageBitmap | HTMLCanvasElement>;
  /** The film's width/height as the preview draws it (the stage). */
  size(): { w: number; h: number };
}

type JobsState = { jobs: Map<string, ExportJob>; running: string | null };
const state = new Map<string, JobsState>();

const listeners = new Set<(job: ExportJob) => void>();
/** A job changed (status/progress/error). The tray merges these. */
export function onWebExportJob(listener: (job: ExportJob) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const tell = (job: ExportJob) => { for (const fn of [...listeners]) fn(job); };

const jobsOf = (projectId: string): JobsState => {
  let s = state.get(projectId);
  if (!s) { s = { jobs: new Map(), running: null }; state.set(projectId, s); }
  return s;
};

/** The web face's jobs so far (the tray's initial fill; newest last). */
export function listWebExports(projectId: string): ExportJob[] {
  return [...jobsOf(projectId).jobs.values()];
}

/** Whether an export is running right now (the ExportCenter's queue button gates on it). */
export const webExportBusy = (projectId: string): boolean => jobsOf(projectId).running != null;

/** Whether this request kind can be worked on the web face (the center hides the rest). */
export function webExportSupports(request: ExportRequest): boolean {
  if (request.kind === 'video') return request.codec === 'h264' || request.codec === 'vp9';
  if (request.kind === 'stills' || request.kind === 'poster') return true;
  if (request.kind === 'gif' || request.kind === 'audio') return true;
  return false; // subtitles/slides/nle/drafts: the server face's (batch 6.x)
}

/** What the center offers on this face (ExportCapabilities shape; the choices it gates). */
export const webExportCapabilities = () => ({
  h264: typeof VideoEncoder !== 'undefined',
  hevc: false,
  hevcAlpha: false,
  vp9: typeof VideoEncoder !== 'undefined',
  prores: false,
  proresChip: false,
  mp3: true, // ffmpeg.wasm fallback (3.5)
});

/** The byte cost of one worked job so far (the tray shows MB). */
export const webExportBytes = (projectId: string): number =>
  [...jobsOf(projectId).jobs.values()].reduce((sum, j) => sum + (j.bytes ?? 0), 0);

/** Cancel: the pump's AbortSignal semantics — the current frame finishes, nothing encodes. */
export function cancelWebExport(projectId: string, jobId: string): boolean {
  const s = jobsOf(projectId);
  const job = s.jobs.get(jobId);
  if (!job || s.running !== jobId) return false;
  aborts.get(jobId)?.abort();
  return true;
}

// The abort handle lives beside the state (one running export per project).
const aborts = new Map<string, AbortController>();

/** Queue one export request on the web face. Answers the job (waiting → the tray tracks it);
 *  the work runs in the background against the given pixel source. Refused (throws) when
 *  another export is running or the kind is not workable here. */
export function startWebExport(
  projectId: string,
  request: ExportRequest,
  source: PreviewPixelSource,
  deps: { putFile: (id: string, path: string, data: Blob) => Promise<void>; ffmpegRun?: (input: { name: string; bytes: Uint8Array }, args: string[], outputName: string) => Promise<Uint8Array> },
): ExportJob {
  if (!webExportSupports(request)) {
    throw Object.assign(new Error(`本站暂不支持 ${request.kind} 导出——视频/静帧/海报/GIF/音频可用`), { code: 'E_EXPORT_UNSUPPORTED' });
  }
  const s = jobsOf(projectId);
  if (s.running != null) {
    throw Object.assign(new Error('已有导出在进行——等它完成或先取消'), { code: 'E_EXPORT_BUSY' });
  }
  const id = `web-${Date.now().toString(36)}`;
  const now = Date.now();
  const job: ExportJob = {
    id, project: projectId, name: request.name ?? request.label ?? 'Export',
    label: request.label ?? '',
    kind: request.kind as ExportJob['kind'],
    status: 'waiting', phase: null, progress: 0, framesDone: 0, framesTotal: 0,
    rate: 0, etaMs: null, encoder: null, outputs: [], bytes: null, alpha: null,
    at: now, startedAt: null, finishedAt: null,
  };
  s.jobs.set(id, job);
  s.running = id;
  tell({ ...job });
  void work(projectId, id, request, source, deps).catch((e) => {
    const j = s.jobs.get(id);
    if (j && j.status !== 'cancelled') {
      j.status = 'failed';
      j.error = e instanceof Error ? e.message : String(e);
      j.finishedAt = Date.now();
      s.running = null;
      tell({ ...j });
    }
  });
  return job;
}

const setJob = (projectId: string, id: string, patch: Partial<ExportJob>): ExportJob | null => {
  const s = jobsOf(projectId);
  const job = s.jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  tell({ ...job });
  return job;
};

/** The work: waiting → running (capture/encode phases) → done (bytes into OPFS) / failed. */
async function work(
  projectId: string,
  id: string,
  request: ExportRequest,
  source: PreviewPixelSource,
  deps: { putFile: (id: string, path: string, data: Blob) => Promise<void>; ffmpegRun?: (input: { name: string; bytes: Uint8Array }, args: string[], outputName: string) => Promise<Uint8Array> },
): Promise<void> {
  const s = jobsOf(projectId);
  const abort = new AbortController();
  aborts.set(id, abort);
  const stopped = () => abort.signal.aborted;
  try {
    setJob(projectId, id, { status: 'running', startedAt: Date.now(), phase: 'rendering' });
    const { w, h } = source.size();
    if (request.kind === 'video') {
      const fps = request.kind === 'video' ? request.fps : 30;
      const [a, b] = request.range ?? [0, 0];
      const sec = Number.isFinite(b) ? b - a : 0;
      const frameCount = Math.max(1, Math.min(3600, Math.round(sec * fps)));
      setJob(projectId, id, { framesTotal: frameCount });
      const { pumpExport } = await import('./export-pump.ts');
      const pump = await pumpExport({
        width: w, height: h, fps, frameCount, source,
        container: request.codec === 'vp9' ? 'webm' : 'mp4',
        onProgress: ({ frame, total, phase }) => {
          const job = setJob(projectId, id, {
            framesDone: frame, progress: total > 0 ? (frame / total) * (phase === 'capture' ? 0.8 : 0.95) : 0.5,
            phase: phase === 'capture' ? 'rendering' : 'encoding',
          });
          if (job) {
            const done = job.framesDone;
            const rate = done > 2 ? done / ((Date.now() - (job.startedAt ?? Date.now())) / 1000) : 0;
            const remaining = total - done;
            setJob(projectId, id, { rate: Math.round(rate * 10) / 10, etaMs: rate > 0 ? Math.round((remaining / rate) * 1000) : null });
          }
        },
        signal: abort.signal,
      });
      if (pump.cancelled || !pump.result) {
        const job = setJob(projectId, id, { status: 'cancelled', finishedAt: Date.now() });
        if (job) s.running = null;
        return;
      }
      setJob(projectId, id, { phase: 'encoding', progress: 0.96, encoder: pump.result.codec });
      const blob = pump.result.blob;
      const path = `downloads/${fileName(request.name ?? id, request.codec === 'vp9' ? 'webm' : 'mp4')}`;
      await deps.putFile(projectId, path, blob);
      setJob(projectId, id, { status: 'done', progress: 1, outputs: [path], bytes: blob.size, finishedAt: Date.now() });
      s.running = null;
      return;
    }
    // stills / poster: single frames as png/jpg
    if (request.kind === 'stills' || request.kind === 'poster') {
      const ats = request.kind === 'poster' ? [request.at ?? 0] : (request.at ?? [0]);
      const format = request.kind === 'poster' ? request.format : (request as { format?: 'png' | 'jpg' }).format ?? 'png';
      const outputs: string[] = [];
      let bytes = 0;
      for (const [i, at] of ats.entries()) {
        if (stopped()) { setJob(projectId, id, { status: 'cancelled', finishedAt: Date.now() }); s.running = null; return; }
        await source.seek(at);
        const image = await source.capture();
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d')!.drawImage(image as CanvasImageSource, 0, 0);
        const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, format === 'jpg' ? 'image/jpeg' : 'image/png'));
        if (!blob) throw new Error('帧编码失败（canvas.toBlob 空）');
        const path = `downloads/${fileName(`${request.name ?? id}${ats.length > 1 ? `-${String(i + 1).padStart(2, '0')}` : ''}`, format)}`;
        await deps.putFile(projectId, path, blob);
        outputs.push(path);
        bytes += blob.size;
        setJob(projectId, id, { framesDone: i + 1, framesTotal: ats.length, progress: ((i + 1) / ats.length) * 0.95 });
      }
      setJob(projectId, id, { status: 'done', progress: 1, outputs, bytes, finishedAt: Date.now() });
      s.running = null;
      return;
    }
    // gif / audio: the ffmpeg.wasm fallback needs the bytes of a source render first —
    // video→gif rides the pump (frames → a first mp4 → the wasm), audio rides the player's
    // mix. Those rides land with the produce family wiring (4.x produce tools); the queue
    // refuses them honestly until then (T08's fallback is wired for one-shot runs, not yet
    // plugged into the tray's source here).
    throw Object.assign(new Error(`${request.kind} 导出随 produce 族接线开放（泵→wasm 两段）`), { code: 'E_EXPORT_UNSUPPORTED' });
  } finally {
    aborts.delete(id);
  }
}

const fileName = (base: string, ext: string): string => {
  const clean = base.trim().replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').slice(0, 80) || 'export';
  return `${clean}.${ext}`;
};
