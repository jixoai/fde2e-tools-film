/**
 * The capture lanes (design D5, T14's 终稿; spec web-film-capture): pixel capture is a REGISTRY of
 * lanes, each with its own device capability, and a clip type is supported where a lane says so.
 *
 *   plugin-cdp     the browser bridge's Page.captureScreenshot — iframe/DOM/cross-origin all
 *                  faithful, byte-reproducible (T14: identity frames 1020/0, cross-source OOPIF
 *                  pixel-correct). Present when the bridge is (4.4's seam: window.fde2eFilmBridge).
 *   in-page        the page's own canvas composition — image/video/webgl and the editor's own
 *                  drawing only; a page sandbox cannot read an iframe's pixels (T04's finding,
 *                  untouched by T14). Always available (it is how the preview draws).
 *   html-in-canvas the WICG proposal — real but unreleased; registered as future, same-origin
 *                  only, off unless the flag is on (Chrome 156: window.CanvasDrawElement probe).
 *
 * The registry answers two asks and nothing more: which lanes exist HERE, and may a clip of a
 * kind be captured on a lane. UI and agents never see a clip type whose only lanes are missing
 * (the spec's 车道探测 scenario); lane choice is capability-driven (`can()`-shaped, no identity
 * enumeration). Capture itself lands with 3.2/3.3 — this module is the contract layer.
 */

/** A capture lane's id (D5's three). */
export type CaptureLaneId = 'plugin-cdp' | 'in-page' | 'html-in-canvas';

/** A clip's kind, as film-doc.mjs `clipKind` says it. */
export type CaptureClipKind = 'page' | 'still' | 'video' | 'sound';

/** What a lane must answer about itself. `probe` runs once at detection. */
export interface CaptureLane {
  id: CaptureLaneId;
  /** One line for the UI (never shown while the lane is absent). */
  label: string;
  /** Clip kinds this lane can capture pixels of. */
  supports: readonly CaptureClipKind[];
  /** Whether the device can drive the lane right now. */
  probe: () => boolean;
}

/** The bridge seam (BU side's 4.4 will set it): anything callable the lane can drive. */
declare global {
  interface Window {
    fde2eFilmBridge?: { captureScreenshot?: unknown } | undefined;
  }
}

const LANES: readonly CaptureLane[] = [
  {
    id: 'plugin-cdp',
    label: 'Browser bridge (CDP)',
    supports: ['page', 'still', 'video'],
    probe: () => typeof window !== 'undefined' && typeof window.fde2eFilmBridge?.captureScreenshot === 'function',
  },
  {
    id: 'in-page',
    label: 'In-page composition',
    supports: ['still', 'video', 'sound'],
    probe: () => true, // the preview already composes the film in the page
  },
  {
    id: 'html-in-canvas',
    label: 'HTML-in-canvas (future)',
    supports: ['page', 'still', 'video'],
    probe: () => typeof window !== 'undefined' && 'CanvasDrawElement' in window, // flag-gated (Chrome 156+)
  },
];

/** The lanes registered, in preference order (best fidelity first). */
export const captureLanes = (): readonly CaptureLane[] => LANES;

/** The lanes the device can drive right now, preference order. */
export function availableLanes(): CaptureLane[] {
  return LANES.filter((lane) => lane.probe());
}

/** Whether a clip of `kind` has any lane that can capture it here — the UI's gate for offering
    the type at all (a page clip shows only when the bridge or the flag is in). */
export function canCapture(kind: CaptureClipKind): boolean {
  return availableLanes().some((lane) => lane.supports.includes(kind));
}

/** The lane to capture `kind` on (first available that supports it), or null when none. */
export function laneFor(kind: CaptureClipKind): CaptureLane | null {
  return availableLanes().find((lane) => lane.supports.includes(kind)) ?? null;
}

/** Whether a lane may capture a kind — the matrix ask, per lane id (unknown id: false). */
export function laneSupports(laneId: CaptureLaneId, kind: CaptureClipKind): boolean {
  const lane = LANES.find((l) => l.id === laneId);
  return lane ? lane.supports.includes(kind) : false;
}

/* ── the preview lane's session contract (3.2's wiring face) ─────────────
   Screencast frames arrive as { data(base64), metadata } per CDP; the controller only fixes the
   ORDER of operations the research found load-bearing: bringToFront BEFORE startScreencast (0
   frames otherwise), start when the picture shows, stop when it hides or the lane goes away. */

/** A frame from a lane's stream: PNG/JPEG/WebP bytes, as the lane made them. */
export interface LaneFrame { bytes: Uint8Array; at: number }

/** The bridge's screencast face (4.4's contract, mirrored here for the probe and the pump). */
export interface BridgeScreencast {
  /** The page must be the visible one: T14 — screencast on a background tab gives 0 frames. */
  bringToFront(): Promise<void>;
  startScreencast(opts: { maxWidth?: number; maxHeight?: number; format?: 'jpeg' | 'png' | 'webp' }, onFrame: (frame: { data: string }) => void): Promise<void>;
  stopScreencast(): Promise<void>;
}

/** A running frame session; `stop()` is idempotent. */
export interface LaneSession { stop(): Promise<void> }

/** Drive `screencast` as the preview's pixel source. Returns a session; the caller stops it when
    the picture unmounts or hides. Frames beyond `maxFrames` backlog are dropped (the preview only
    ever draws the newest — a screencast is not a recording; the export lane serialises instead). */
export async function runScreencast(screencast: BridgeScreencast, onFrame: (frame: LaneFrame) => void, opts: { maxWidth?: number; maxHeight?: number; format?: 'jpeg' | 'png' | 'webp' } = {}): Promise<LaneSession> {
  let stopped = false;
  await screencast.bringToFront(); // the 0-frames trap: without it the page streams nothing
  await screencast.startScreencast(opts, (frame) => {
    if (stopped) return; // frames after stop are the bridge's last word, not news
    const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0));
    onFrame({ bytes, at: Date.now() });
  });
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await screencast.stopScreencast();
    },
  };
}
