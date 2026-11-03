/**
 * The ffmpeg.wasm fallback (3.5, T08's ST tier): the formats WebCodecs can't do — GIF, prores,
 * audio-track extraction, cold containers — through the same ask the main backend answers
 * (design D6: the caller never knows which tier ran). Single-threaded on purpose: the site does
 * not deploy COOP+COEP (T08: core-mt fails hard without both heads), and MT output is not
 * bit-reproducible anyway — the deterministic tier is ST (spec's 确定性产物只走 ST).
 *
 * The core is vendored, not fetched: scripts/vendor-ffmpeg.mjs copies @ffmpeg/core 0.12.10
 * (lockfile-pinned) into /ffmpeg/ at build; the version the site ships is the version the
 * lockfile says, with no third-party runtime dependency.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg';

/** Where the vendored core lives (public/ffmpeg, served from the site root). */
const CORE_BASE = '/ffmpeg';
const CORE_JS = `${CORE_BASE}/ffmpeg-core.js`;
const CORE_WASM = `${CORE_BASE}/ffmpeg-core.wasm`;
const WORKER_JS = `${CORE_BASE}/worker.js`;

/** The formats this tier exists for (the encode matrix's wasm column). */
export type FallbackFormat = 'gif' | 'prores' | 'mp3' | 'wav' | 'mkv';

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

/** Whether the tier can run here (worker + the WASM baseline). Cheap, no load. */
export function ffmpegAvailable(): boolean {
  return typeof Worker !== 'undefined' && typeof WebAssembly === 'object';
}

/** The shared instance, loaded once (31 MB wasm: the page asks for it only when a fallback
    format is actually requested — never at boot). */
async function ffmpeg(): Promise<FFmpeg> {
  instance ??= new FFmpeg();
  if (!loading) {
    loading = instance
      .load({
        coreURL: new URL(CORE_JS, location.origin).href,
        wasmURL: new URL(CORE_WASM, location.origin).href,
        classWorkerURL: new URL(WORKER_JS, location.origin).href,
      })
      .then(() => instance as FFmpeg);
  }
  return loading;
}

/** One ffmpeg run: the input file(s) in, argv (the format's own semantics, e.g. GIF's
    palettegen two-pass or prores' profile), the named output out. Answers the file's bytes. */
export async function ffmpegRun(input: { name: string; bytes: Uint8Array }, args: string[], outputName: string): Promise<Uint8Array> {
  const f = await ffmpeg();
  await f.writeFile(input.name, input.bytes);
  try {
    const code = await f.exec([...args]);
    if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
    const data = await f.readFile(outputName);
    return data instanceof Uint8Array ? data : new Uint8Array(data as unknown as ArrayBuffer);
  } finally {
    await f.deleteFile(input.name).catch(() => {});
    await f.deleteFile(outputName).catch(() => {});
  }
}

/** The frozen ask, fallback tier: one input video → the format's bytes. */
export async function encodeFallback(input: { name: string; bytes: Uint8Array }, format: FallbackFormat, opts: { fps?: number } = {}): Promise<{ blob: Blob; codec: string }> {
  const base = input.name.replace(/\.[^.]+$/, '');
  if (format === 'gif') {
    // palettegen two-pass (the GIF quality semantics; a single-pass dither is the cheap way out)
    const palette = `${base}-palette.png`;
    const out = `${base}.gif`;
    const fps = opts.fps ?? 12;
    const f = await ffmpeg();
    await f.writeFile(input.name, input.bytes);
    try {
      if ((await f.exec(['-i', input.name, '-vf', `fps=${fps},palettegen`, '-y', palette])) !== 0) throw new Error('ffmpeg exited non-zero (palettegen)');
      if ((await f.exec(['-i', input.name, '-i', palette, '-lavfi', `fps=${fps} [x]; [x][1:v] paletteuse`, '-y', out])) !== 0) throw new Error('ffmpeg exited non-zero (paletteuse)');
      const data = await f.readFile(out);
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as unknown as ArrayBuffer);
      return { blob: new Blob([bytes as BlobPart], { type: 'image/gif' }), codec: 'gif (palettegen/paletteuse)' };
    } finally {
      for (const name of [input.name, palette, out]) await f.deleteFile(name).catch(() => {});
    }
  }
  const formats: Record<Exclude<FallbackFormat, 'gif'>, { out: string; mime: string; codec: string; args: string[] }> = {
    prores: { out: `${base}.mov`, mime: 'video/quicktime', codec: 'prores_ks (profile 3)', args: ['-c:v', 'prores_ks', '-profile:v', '3', '-c:a', 'pcm_s16le', `${base}.mov`] },
    mp3: { out: `${base}.mp3`, mime: 'audio/mpeg', codec: 'libmp3lame', args: ['-vn', '-c:a', 'libmp3lame', '-q:a', '4', `${base}.mp3`] },
    wav: { out: `${base}.wav`, mime: 'audio/wav', codec: 'pcm_s16le', args: ['-vn', '-c:a', 'pcm_s16le', `${base}.wav`] },
    mkv: { out: `${base}.mkv`, mime: 'video/x-matroska', codec: 'copy', args: ['-c', 'copy', `${base}.mkv`] },
  };
  const run = formats[format];
  const bytes = await ffmpegRun(input, ['-i', input.name, ...run.args], run.out);
  return { blob: new Blob([bytes as BlobPart], { type: run.mime }), codec: run.codec };
}

/** Stop the worker (a long export cancelled): the instance loads again on the next ask. */
export function ffmpegTerminate(): void {
  instance?.terminate();
  instance = null;
  loading = null;
}
