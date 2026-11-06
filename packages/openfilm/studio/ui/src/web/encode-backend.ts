/**
 * The encode backend (design D6, spec web-film-encode): ONE frozen ask —
 *
 *   encodeVideo({ width, height, fps, frames, audio, container }) → { blob, codec }
 *
 * and the implementation is probed, never chosen by the caller: WebCodecs here (the main path,
 * secure context, no COI needed), ffmpeg.wasm later as 3.5's fallback for the formats this can't
 * do (GIF, prores, track extraction). Multiplexing is mediabunny's (1.65, mp4/webm); AAC rides
 * the high-level AudioBufferSource so initial_padding is written correctly (the −44ms priming
 * trap); frame timestamps are `(i + 0.5) / fps` — the same t a preview would draw, locked to the
 * frame grid.
 *
 * Determinism note (spec's 确定性产物只走 ST): this path is single-threaded by nature, so its
 * output can be hash-certified; a future MT wasm tier must not be used for published hashes.
 */
import { AudioBufferSource, BufferTarget, Mp4OutputFormat, Output, VideoSample, VideoSampleSource, WebMOutputFormat, canEncodeVideo, type VideoCodec } from 'mediabunny';

export type EncodeContainer = 'mp4' | 'webm';

export interface EncodeVideoFrame {
  /** The frame's pixels in any canvas source the platform draws (ImageBitmap/VideoFrame/Canvas). */
  image: CanvasImageSource;
  /** The moment it stands for, in seconds (monotone; the encoder maps it to the frame grid). */
  t: number;
}

export interface EncodeAudioTrack {
  /** Decoded PCM the caller holds (player.ts's AudioBuffer chain). */
  buffer: AudioBuffer;
}

export interface EncodeVideoRequest {
  width: number;
  height: number;
  fps: number;
  /** The frames in order. Their `t` is informational; timestamps are derived from the index so a
      re-run of the same request is bit-comparable. */
  frames: readonly EncodeVideoFrame[];
  audio?: readonly EncodeAudioTrack[];
  container: EncodeContainer;
  /** Bits per second for the video track; undefined: the quality ladder decides. */
  videoBitrate?: number;
}

export interface EncodedVideo { blob: Blob; codec: string; container: EncodeContainer }

/** Whether this browser can encode at all (WebCodecs present and the codec negotiable). */
export async function encodeAvailable(container: EncodeContainer, width = 1920, height = 1080): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return false;
  const codec = await pickVideoCodec(container, width, height);
  return codec !== null;
}

/** The codec the container wants, checked against the device: h264 for mp4 (the universal one),
    vp9 for webm; av1 tried first for mp4 when the device has it (smaller at the same quality). */
async function pickVideoCodec(container: EncodeContainer, width: number, height: number): Promise<VideoCodec | null> {
  const wants: VideoCodec[] = container === 'mp4' ? ['avc'] : ['vp9'];
  for (const codec of wants) {
    if (await canEncodeVideo(codec, { width, height }).catch(() => false)) return codec;
  }
  return null;
}

export interface VideoEncodeSession {
  codec: string;
  add(image: CanvasImageSource): Promise<void>;
  finalize(): Promise<EncodedVideo>;
  cancel(): Promise<void>;
}

/** A bounded-memory encoder session: each frame is handed to WebCodecs and closed before the
    next one is captured. Long films therefore cost encoder queue memory, not width×height×frames. */
export async function createVideoEncodeSession(request: Omit<EncodeVideoRequest, 'frames'>): Promise<VideoEncodeSession> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') throw new EncodeUnsupportedError('WebCodecs is not available in this browser');
  const codec = await pickVideoCodec(request.container, request.width, request.height);
  if (!codec) throw new EncodeUnsupportedError(`no encodable ${request.container} video codec on this device`);
  const step = 1 / request.fps;
  const video = new VideoSampleSource({ codec, bitrate: request.videoBitrate ?? bitrateFor(request.width, request.height) });
  const output = new Output({
    format: request.container === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  output.addVideoTrack(video, { frameRate: request.fps });
  let audioSource: AudioBufferSource | null = null;
  if (request.audio?.length) {
    audioSource = new AudioBufferSource({ codec: request.container === 'webm' ? 'opus' : 'aac', bitrate: 192_000 });
    output.addAudioTrack(audioSource);
  }
  await output.start();
  let frameIndex = 0;
  let state: 'open' | 'finalizing' | 'settled' = 'open';
  return {
    codec,
    async add(image) {
      if (state !== 'open') throw new Error('the encoder session is already settled');
      /* VideoSample takes seconds (VideoFrame takes microseconds): keep the frozen
         `(i + 0.5) / fps` grid in the units this high-level API specifies. */
      const sample = new VideoSample(image, { timestamp: (frameIndex + 0.5) * step, duration: step });
      try { await video.add(sample); } finally { sample.close(); }
      frameIndex += 1;
    },
    async finalize() {
      if (state !== 'open') throw new Error('the encoder session is already settled');
      state = 'finalizing';
      try {
        await video.close();
        if (audioSource) {
          for (const track of request.audio!) await audioSource.add(track.buffer);
          await audioSource.close();
        }
        await output.finalize();
        const buffer = (output.target as BufferTarget).buffer;
        if (!buffer) throw new EncodeUnsupportedError('the muxer produced nothing');
        const mime = await Promise.resolve(output.getMimeType());
        state = 'settled';
        return { blob: new Blob([buffer], { type: mime }), codec, container: request.container };
      } catch (error) {
        /* `finalize` can fail after VideoEncoder/AudioEncoder have opened resources. A failed
           finalization still has to settle the muxer; otherwise the next long export inherits
           encoder memory until the page itself is torn down. */
        await output.cancel().catch(() => {});
        state = 'settled';
        throw error;
      }
    },
    async cancel() {
      if (state === 'settled') return;
      state = 'settled';
      await output.cancel();
    },
  };
}

/** The frames + audio encoded into one Blob. The convenience form uses the same streaming
    session as the export pump; callers with a live source should add each frame directly. */
export async function encodeVideo(request: EncodeVideoRequest): Promise<EncodedVideo> {
  const session = await createVideoEncodeSession(request);
  try {
    for (const frame of request.frames) await session.add(frame.image);
    return await session.finalize();
  } catch (error) {
    await session.cancel().catch(() => {});
    throw error;
  }
}

/** The rate a frame of this size wants (the ladder mediabunny's QUALITY builds on). */
function bitrateFor(width: number, height: number): number {
  const px = width * height;
  if (px >= 3840 * 2160) return 35_000_000;
  if (px >= 1920 * 1080) return 12_000_000;
  if (px >= 1280 * 720) return 6_000_000;
  return 3_000_000;
}

export class EncodeUnsupportedError extends Error {
  readonly name = 'EncodeUnsupportedError';
}
