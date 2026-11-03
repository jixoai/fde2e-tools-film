/**
 * The export pump (3.3's web-face core): drives the film to a frame, waits for the picture to
 * really be there, captures the pixels on the picked lane, and hands each frame straight to the
 * encoder. Serial by design (the capture lanes are single-shot devices); the preview keeps
 * playing meanwhile — export and preview do not block each other (spec's 导出 while 预览).
 *
 * The pump works on a `FrameSource` — the preview's seek/ready protocol, or the bridge's
 * captureScreenshot against a hidden window; the caller plugs what it has. This module holds
 * only the part that must not drift: the (i+0.5)/fps grid, the serial loop, cancellation, and
 * the progress story.
 */
import { encodeVideo, type EncodeContainer, type EncodedVideo } from './encode-backend.ts';
import { laneFor } from './capture-lanes.ts';

/** A pixel source the pump drives: seek to t, resolve when the frame is on screen, read pixels. */
export interface FrameSource {
  seek(t: number): Promise<void>;
  capture(): Promise<ImageBitmap | VideoFrame | HTMLCanvasElement>;
}

export interface PumpProgress { frame: number; total: number; phase: 'capture' | 'encode' }
export interface PumpOptions {
  width: number;
  height: number;
  fps: number;
  /** How many frames the film is (duration × fps, the caller's rounding). */
  frameCount: number;
  source: FrameSource;
  container?: EncodeContainer;
  audio?: readonly { buffer: AudioBuffer }[];
  onProgress?: (progress: PumpProgress) => void;
  /** Frames already in the bag (a resumed export). */
  from?: number;
  /** Cancel mid-run: the pump finishes its current frame, answers `cancelled`, encodes nothing. */
  signal?: AbortSignal;
}
export interface PumpResult { result: EncodedVideo | null; frames: number; cancelled: boolean }

/** True when the pump can run here (a lane for the film's kinds and an encoder). */
export function pumpReady(): boolean {
  return laneFor('video') !== null && typeof VideoEncoder !== 'undefined';
}

/** Capture `frameCount` frames on the (i+0.5)/fps grid and encode them. */
export async function pumpExport(opts: PumpOptions): Promise<PumpResult> {
  const lane = laneFor('video');
  if (!lane) throw new Error('no capture lane for the film here');
  const container = opts.container ?? 'mp4';
  const frames: Array<{ image: CanvasImageSource; t: number }> = [];
  const stopped = () => opts.signal?.aborted === true;
  const total = opts.frameCount;
  for (let i = opts.from ?? 0; i < total; i++) {
    if (stopped()) return { result: null, frames: frames.length, cancelled: true };
    opts.onProgress?.({ frame: i, total, phase: 'capture' });
    await opts.source.seek((i + 0.5) / opts.fps); // the grid: the same t the encoder writes
    const image = await opts.source.capture();
    frames.push({ image, t: (i + 0.5) / opts.fps });
    if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0)); // yield: the page stays alive
  }
  opts.onProgress?.({ frame: total, total, phase: 'encode' });
  const result = await encodeVideo({
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    frames,
    audio: opts.audio,
    container,
  });
  return { result, frames: frames.length, cancelled: false };
}
