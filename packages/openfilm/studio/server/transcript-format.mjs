// Browser-safe subtitle format shared by OPFS and server stores.
/** @typedef {{text:string,startMs:number,endMs:number,marks?:{index:number,startMs:number}[]}} SpokenLine */
/** @typedef {{lines:SpokenLine[],speaker?:string,cut?:boolean}} Transcript */
/** The note at the top of a transcript whose lines are each one subtitle, as the person cut them. */
export const CUT_NOTE = 'NOTE Each cue is one subtitle, as cut by hand in OpenFilm Studio.';
const CUT_NOTE_RE = /^NOTE Each cue is one subtitle\b/;

/** `00:01.250` or `00:00:01.250` → milliseconds. @param {string} stamp */
export function msOf(stamp) {
  const parts = stamp.trim().split(':').map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return NaN;
  return Math.round(parts.reduce((acc, n) => acc * 60 + n, 0) * 1000);
}

/** milliseconds → `00:00:01.250`. @param {number} ms */
export function stampOf(ms) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000), m = Math.floor(t / 60_000) % 60, s = Math.floor(t / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(t % 1000).padStart(3, '0')}`;
}

export const unescape = (/** @type {string} */ s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
export const escape = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A WebVTT's lines. Tags other than timestamps and voices (`<b>`, `<c.x>`, `<lang>`) are dropped; a cue's own lines
 * are one subtitle line.
 * @param {string} body @returns {Transcript}
 */
export function parseVtt(body) {
  /** @type {SpokenLine[]} */
  const lines = [];
  /** @type {string | undefined} */
  let speaker;
  let cut = false;
  for (const block of body.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n{2,}/)) {
    const rows = block.split('\n');
    if (CUT_NOTE_RE.test(rows[0] ?? '')) cut = true;
    const timing = rows.findIndex((r) => r.includes('-->'));
    if (timing < 0 || /^(NOTE|STYLE|REGION)\b/.test(rows[0] ?? '')) continue;
    const [a, b] = rows[timing].split('-->');
    const startMs = msOf(a), endMs = msOf(b.trim().split(/\s+/)[0] ?? '');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    let raw = '';
    /** @type {{ index: number, startMs: number }[]} */
    const timed = [];
    let pending = /** @type {number | null} */ (null);
    for (const [, tag, chunk] of rows.slice(timing + 1).join(' ').matchAll(/<([^>]*)>|([^<]+)/g)) {
      if (tag !== undefined) {
        const at = msOf(tag);
        if (Number.isFinite(at)) pending = at;
        else if (/^v[\s.]/.test(tag)) speaker ??= tag.replace(/^v(\.\S*)?\s+/, '').trim() || undefined;
        continue;
      }
      const piece = unescape(chunk);
      if (pending !== null && piece.trim()) { timed.push({ index: raw.length + piece.length - piece.trimStart().length, startMs: pending }); pending = null; }
      raw += piece;
    }
    const said = raw.replace(/\s+/g, ' ').trim();
    if (!said) continue;
    const marks = remapMarks(raw, said, timed);
    /* a line whose words are timed: its first word starts with the cue */
    const all = marks.length && marks[0].index > 0 ? [{ index: 0, startMs }, ...marks] : marks;
    lines.push({ text: said, startMs, endMs: Math.max(endMs, startMs + 1), ...(all.length ? { marks: all } : {}) });
  }
  return { lines, ...(speaker ? { speaker } : {}), ...(cut ? { cut: true } : {}) };
}

/**
 * Marks found in the raw cue text, moved to the same characters once runs of spaces are one and the ends trimmed.
 * @param {string} raw @param {string} said @param {{ index: number, startMs: number }[]} marks
 */
function remapMarks(raw, said, marks) {
  /* the position in `said` of each raw position: spaces collapse, leading ones go */
  const at = new Array(raw.length + 1).fill(0);
  let j = 0, prevSpace = true;
  for (let i = 0; i < raw.length; i += 1) {
    at[i] = j;
    const space = /\s/.test(raw[i]);
    if (space && prevSpace) continue;
    j += 1;
    prevSpace = space;
  }
  at[raw.length] = j;
  return marks.map((m) => ({ index: Math.min(said.length, at[m.index] ?? said.length), startMs: m.startMs }))
    .filter((m, i, list) => m.index < said.length && (i === 0 || m.index > list[i - 1].index));
}

/**
 * A WebVTT of `lines`, the words timed where their marks are; `cut`: with CUT_NOTE.
 * @param {readonly SpokenLine[]} lines @param {{ speaker?: string, cut?: boolean }} [options]
 */
export function vttOf(lines, { speaker, cut } = {}) {
  const cues = lines.map((line) => {
    const marks = (line.marks ?? []).filter((m) => m.index > 0 && m.index < line.text.length);
    let payload = '', from = 0;
    for (const m of marks) {
      payload += `${escape(line.text.slice(from, m.index))}<${stampOf(m.startMs)}>`;
      from = m.index;
    }
    payload += escape(line.text.slice(from));
    return `${stampOf(line.startMs)} --> ${stampOf(line.endMs)}\n${speaker ? `<v ${speaker}>` : ''}${payload}`;
  });
  return `WEBVTT\n\n${cut ? `${CUT_NOTE}\n\n` : ''}${cues.join('\n\n')}\n`;
}

/** @param {string} path */
