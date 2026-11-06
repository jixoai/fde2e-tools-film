/** @typedef {import('./caption-projection.mjs').AltLines} AltLines */
// @ts-check
/**
 * A film's subtitles: what is said in it, line by line, at the film's own times, made from film.html and the
 * transcripts of its media (a WebVTT beside each file, transcripts.mjs). An agent places voices and footage, the person
 * styles the lines (`.film/subtitles.json`) and corrects their words, and Studio draws them over the picture and into
 * exports.
 *
 * Which clips speak: sound and video clips that have a transcript, when they can be heard (not on a muted track,
 * volume above 0). A clip says the part of its source it plays: a line belongs to a clip when one of its words starts
 * inside the clip's trim, a line cut by the trim keeps only the words inside it, and everything is moved to where the
 * clip sits on the film and scaled by its speed. So subtitles follow every cut, trim, move and speed change with
 * nothing to keep in sync. Speech with no transcript yet is listed as `untranscribed`: Studio transcribes it on the
 * person's word (POST subtitles/transcribe).
 *
 * A transcript keeps whole spoken lines; each is cut into subtitles here, as it becomes cues (subtitle-segments.mjs: one
 * clause per subtitle, one line each, on screen long enough to read). A cue says which piece of which line it is
 * (`line`, `part`), so a correction goes back into those words of that line, and keeps its piece's timed words.
 *
 * Translations: `name.<language>.vtt` beside the transcript, the same lines at the same times; each line carries them
 * (`alt`), cut to follow the original's pieces, and the person's style picks one.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { clipKind, clipSpan, kindOf, soundRole } from '../../src/film-doc.mjs';
import { probe } from './derived.mjs';
import { readProjectFilm } from './film.mjs';
import { HttpError, json, readJson } from './http.mjs';
import { TOOL_DIR } from './projects.mjs';
import { filmSubtitleLanguageOf, filmSubtitleLanguagesIn, isFilmSubtitleLanguage, parseFilmSubtitleStyle, sameFilmSubtitleLanguage } from './film-subtitle.mjs';
import { writeAtomic } from './atomic.mjs';
import { inProject } from './files.mjs';
import { readTranscript, setLine, transcriptIsCurrent, translationsOf, writeTranscript } from './transcripts.mjs';
import { subtitleEditRoutes } from './subtitle-edits.mjs';

export { spokenLines, stripAudioTags } from './transcripts.mjs';
export { SUBTITLE_SEGMENT_RULES } from './subtitle-segments.mjs';

/** @typedef {import('./film-subtitle.mjs').FilmSubtitleCue} FilmSubtitleCue @typedef {import('./film-subtitle.mjs').FilmSubtitleStyle} FilmSubtitleStyle */
/** @typedef {{ token: string, startSec: number, endSec?: number }} Word */
/** @typedef {import('./transcripts.mjs').SpokenLine} SpokenLine */

export const SUBTITLE_STYLE_FILE = `${TOOL_DIR}/subtitles.json`;

export class CaptionError extends Error {
  /** @param {string} message @param {number} status @param {string} [code] */
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** @param {string} path @returns {Promise<Record<string, unknown> | null>} */
async function jsonObject(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return isRecord(value) ? value : null;
  } catch { return null; }
}

/* ── lines → the film's subtitles ────────────────────────────────────────── */

/** Shorter than this is the scrap of a line cut by a trim, not speech. */
export { MIN_CAPTION_MS, captionText, trimToWindow, wholeLine, clipCues } from './caption-projection.mjs';
import { clipCues } from './caption-projection.mjs';

/**
 * The clips that can be heard (not on a muted or hidden track, volume above 0), with sound or a video's: those that
 * could speak. Only files inside the project: a film from elsewhere can name `../` sources, whose transcripts are
 * neither read nor written.
 * @param {string} root @param {import('../../src/film-doc.d.mts').FilmDoc} doc
 */
function heardClips(root, doc) {
  return doc.tracks.flatMap((track) => (track.muted || track.hidden ? [] : track.clips.filter((clip) => {
    const kind = kindOf(clip);
    return (kind === 'sound' || kind === 'video') && !(clip.volume !== undefined && clip.volume <= 0) && inProject(root, clip.src) !== null;
  })));
}

/**
 * Whether a clip with no transcript is speech that wants one: a voice (not music or an effect, by its folder or
 * name), or a video with sound.
 * @param {string} root @param {string} src
 */
async function wantsTranscript(root, src) {
  if (clipKind(src) === 'sound') return soundRole(src) === 'voice';
  return (await probe(root, src).catch(() => null))?.audio === true;
}

/** How far past its file's end a transcript's last line may run (rounding, a codec's padding) before it is not the file's. */
const OUTLAST_MS = 1000;

/**
 * Whether a transcript runs on past the end of its file (`seconds`; unknown: it cannot tell, so no): then it was made
 * from another version of the file.
 * @param {readonly { endMs: number }[]} lines @param {number | undefined} seconds
 */
export function transcriptOutlasts(lines, seconds) {
  if (!(typeof seconds === 'number' && seconds > 0)) return false;
  const end = lines.reduce((m, line) => Math.max(m, line.endMs), 0);
  return end > seconds * 1000 + OUTLAST_MS;
}

/**
 * The film's subtitles as film.html is now.
 *   cues           every line, sorted by start (film ms), with `alt` translations, the `clip` id it comes from and the
 *                  `src` and `line` it shows
 *   sourceLanguage the voices' language as far as the script tells (null for Latin scripts: "Original")
 *   languages      the languages any line has a translation in
 *   untranscribed  the speech heard in the film that has no transcript yet
 * A film.html that cannot be read has no subtitles (its problems are shown elsewhere).
 * @param {string} root
 * @param {{ duration?: (src: string) => Promise<number | undefined> }} [options] the length of a source in seconds
 *   when the clip's trim does not say it (ffprobe by default)
 */
export async function filmCaptions(root, options = {}) {
  const film = await readProjectFilm(root);
  const empty = { cues: /** @type {FilmSubtitleCue[]} */ ([]), sourceLanguage: null, languages: /** @type {string[]} */ ([]), untranscribed: /** @type {string[]} */ ([]) };
  const doc = /** @type {import('../../src/film-doc.d.mts').FilmDoc | null} */ (film.doc);
  if (!doc) return empty;
  const duration = options.duration ?? ((/** @type {string} */ src) => probe(root, src).then((p) => p.duration, () => undefined));
  /** @type {Map<string, { lines: SpokenLine[], speaker?: string, alt: AltLines, cut?: boolean } | null>} */
  const known = new Map();
  const transcriptOf = async (/** @type {string} */ src) => {
    if (known.has(src)) return known.get(src) ?? null;
    const read = await readTranscript(root, src);
    /** @type {AltLines} */
    const alt = new Map();
    if (read) {
      for (const language of await translationsOf(root, src)) {
        for (const line of (await readTranscript(root, src, language))?.lines ?? []) alt.set(line.startMs, { ...alt.get(line.startMs), [language]: line.text });
      }
    }
    const one = read ? { lines: read.lines, ...(read.speaker ? { speaker: read.speaker } : {}), alt, ...(read.cut ? { cut: true } : {}) } : null;
    known.set(src, one);
    return one;
  };
  /** @type {Map<string, Promise<number | undefined>>} */
  const lengths = new Map();
  const lengthOf = (/** @type {string} */ src) => {
    if (!lengths.has(src)) lengths.set(src, duration(src));
    return /** @type {Promise<number | undefined>} */ (lengths.get(src));
  };
  /** @type {FilmSubtitleCue[]} */
  const cues = [];
  const untranscribed = new Set();
  for (const clip of heardClips(root, doc)) {
    const said = await transcriptOf(clip.src);
    if (!said) { if (await wantsTranscript(root, clip.src)) untranscribed.add(clip.src); continue; }
    /* a transcript that runs on past the end of its file is not this file's any more (it was made again faster, or
       the transcript's times were moved): its lines would drift later and later and the last ones fall off. It is
       still shown, and made again with the rest (the CC button) */
    if (await transcriptOutlasts(said.lines, await lengthOf(clip.src))) untranscribed.add(clip.src);
    const native = clip.time?.length === 2 ? undefined : await lengthOf(clip.src) ?? (said.lines.at(-1)?.endMs ?? 0) / 1000;
    let span;
    try { span = clipSpan(clip, native ?? NaN); } catch { continue; }
    cues.push(...clipCues(said.lines, {
      fromMs: span.from * 1000, startMs: (clip.at ?? 0) * 1000, durMs: span.length * 1000, speed: span.speed,
    }, { alt: said.alt, ...(said.speaker ? { speaker: said.speaker } : {}), clip: clip.id, src: clip.src, ...(said.cut ? { cut: true } : {}) }));
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  /* a speaker's name tells voices apart; with one voice in the film it tells nothing, and would open every line */
  if (new Set(cues.map((c) => c.speaker).filter(Boolean)).size <= 1) for (const c of cues) delete c.speaker;
  return {
    cues,
    sourceLanguage: filmSubtitleLanguageOf(cues.map((c) => c.text).join(' ')),
    languages: filmSubtitleLanguagesIn(cues),
    untranscribed: [...untranscribed],
  };
}

/** Whether `src`'s transcript outlasts the file as it is now (see transcriptOutlasts). @param {string} root @param {string} src */
async function outlastsItsFile(root, src) {
  const read = await readTranscript(root, src);
  if (!read) return false;
  return transcriptOutlasts(read.lines, await probe(root, src).then((p) => p.duration, () => undefined));
}

/* ── the person's style ──────────────────────────────────────────────────── */

/**
 * The project's subtitle style (`.film/subtitles.json`), or null when the person never changed it (the editor then
 * starts from the look they used last, or the default). It is the person's look of this project: beside film.html,
 * not in it, so an agent rewriting the film never resets it; each version in the history keeps it (closure.mjs).
 * @param {string} root @returns {Promise<FilmSubtitleStyle | null>}
 */
export async function readSubtitleStyle(root) {
  const raw = await jsonObject(join(root, SUBTITLE_STYLE_FILE));
  return raw ? parseFilmSubtitleStyle(raw) : null;
}

/** Keep a style (checked field by field), written whole. @param {string} root @param {unknown} style */
export async function writeSubtitleStyle(root, style) {
  const parsed = parseFilmSubtitleStyle(style);
  await writeWhole(join(root, SUBTITLE_STYLE_FILE), `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

/** @param {string} path @param {string} body */
async function writeWhole(path, body) {
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, body, 'utf8');
}

/* ── translation ─────────────────────────────────────────────────────────── */

/**
 * Translates one voice's lines: one string per line, in order. Given each line's times in the source (`times`), and
 * for context the voice's whole text, its words' times (from the transcript's timed words, else one per line) and
 * its length. Throws an Error with `code: 'not-connected'` (or `status: 401`) when there is no provider to do it with.
 * @typedef {(job: { src: string, language: string, lines: string[], times: { startSec: number, endSec: number }[], text: string, words: Word[], dur: number, signal?: AbortSignal }) => Promise<string[]>} TranslateLines
 */

/** A transcript's lines as words with their times: a timed word per mark, else the line as one. @param {readonly SpokenLine[]} lines @returns {Word[]} */
function wordsOfLines(lines) {
  return lines.flatMap((line) => {
    const marks = line.marks?.length ? line.marks : [{ index: 0, startMs: line.startMs }];
    return marks.map((m, i) => {
      const next = marks[i + 1];
      return { token: line.text.slice(m.index, next ? next.index : undefined).trim(), startSec: m.startMs / 1000, endSec: (next ? next.startMs : line.endMs) / 1000 };
    }).filter((w) => w.token);
  });
}

export const CONNECT_TRANSLATOR = 'Connect a service that translates in Studio: Settings (the OpenFilm logo at the top left) → Providers.';

/**
 * Translate the film's voices into `language` (one of FILM_SUBTITLE_LANGUAGES): each source heard in the film that has
 * a transcript, is not in that language already and has no translation into it yet, line by line, each translated
 * line at its original's time, kept as `name.<language>.vtt` beside the transcript.
 * `translated`: sources done now; `already`: had one; `same`: already in that language; `failed`: per source.
 * @param {string} root @param {string} language
 * @param {{ translate: TranslateLines | null, signal?: AbortSignal }} options
 */
export async function translateFilmSubtitles(root, language, options) {
  if (!isFilmSubtitleLanguage(language)) throw new CaptionError(`Subtitles cannot be translated into "${language}".`, 400);
  const film = await readProjectFilm(root);
  const doc = /** @type {import('../../src/film-doc.d.mts').FilmDoc | null} */ (film.doc);
  /** @type {{ language: string, translated: string[], already: number, same: number, failed: { src: string, error: string }[] }} */
  const out = { language, translated: [], already: 0, same: 0, failed: [] };
  /** @type {{ src: string, transcript: import('./transcripts.mjs').Transcript }[]} */
  const todo = [];
  for (const src of new Set((doc ? heardClips(root, doc) : []).map((c) => c.src))) {
    const transcript = await readTranscript(root, src);
    if (!transcript) continue;
    const text = transcript.lines.map((l) => l.text).join(' ');
    if (sameFilmSubtitleLanguage(filmSubtitleLanguageOf(text), language)) out.same += 1;
    else if ((await translationsOf(root, src)).includes(language)) out.already += 1;
    else todo.push({ src, transcript });
  }
  if (!todo.length) return out;
  if (!options.translate) throw new CaptionError(CONNECT_TRANSLATOR, 409, 'no-translator');
  for (const { src, transcript } of todo) {
    options.signal?.throwIfAborted();
    const lines = transcript.lines;
    try {
      const got = await options.translate({ src, language, lines: lines.map((l) => l.text), times: lines.map((l) => ({ startSec: l.startMs / 1000, endSec: l.endMs / 1000 })),
        text: lines.map((l) => l.text).join(' '), words: wordsOfLines(lines), dur: (lines.at(-1)?.endMs ?? 0) / 1000, ...(options.signal ? { signal: options.signal } : {}) });
      if (!Array.isArray(got) || got.length !== lines.length || got.some((x) => typeof x !== 'string')) throw new Error('The translation came back with the wrong number of lines; nothing was kept. Try again.');
      const translated = lines.map((line, i) => ({ text: got[i].trim(), startMs: line.startMs, endMs: line.endMs })).filter((l) => l.text);
      await writeTranscript(root, src, { lines: translated }, language);
      out.translated.push(src);
    } catch (e) {
      if (e instanceof CaptionError) throw e;
      const err = /** @type {{ code?: unknown, status?: unknown, message?: unknown }} */ (e);
      if (err?.code === 'not-connected' || err?.status === 401) throw new CaptionError(CONNECT_TRANSLATOR, 409, 'no-translator');
      if (options.signal?.aborted) throw e;
      out.failed.push({ src, error: String(err?.message ?? e) });
    }
  }
  return out;
}

/* ── routes ──────────────────────────────────────────────────────────────── */

/**
 * Transcribes one source of the project (writing its transcript), or throws an Error saying why it could not (no
 * service for it: `code: 'not-connected'`).
 * @typedef {(root: string, src: string, signal: AbortSignal) => Promise<void>} Transcribe
 */

export const CONNECT_TRANSCRIBER = 'Connect a service that transcribes in Studio: Settings (the OpenFilm logo at the top left) → Providers.';

/**
 * The subtitle routes under /api/projects/:id/ (`rest` is the part after it). Returns whether it answered.
 *   GET  captions              → filmCaptions(root)
 *   PUT  captions/line         { src, line, part?, text, language? } → { ok } (the line of `src`'s transcript starting at
 *                              `line` ms reads `text`, or its translation into `language` does; with `part`, only that
 *                              subtitle of the line (a cue's `part`); empty text takes it out)
 *   GET  subtitles             → { style: FilmSubtitleStyle | null } (null: never changed)
 *   PUT  subtitles             { style } → { style } (as kept)
 *   POST subtitles/transcribe  → { transcribed, failed } for the speech heard with no transcript yet; 409 { error, code:
 *                              'no-transcriber' } when no service can
 *   POST subtitles/translate   { language } → translateFilmSubtitles' result (502 when every voice failed);
 *                              409 { error, code: 'no-translator' } when no provider can translate
 *   GET  captions/source, PUT captions/source, PUT captions/files: the subtitle row's edits (subtitle-edits.mjs)
 * @param {import('./http.mjs').Req} req @param {import('./http.mjs').Res} res @param {string} root @param {string} rest
 * @param {{ translate?: (root: string) => Promise<TranslateLines | null>, transcribe?: Transcribe }} [options] where
 *   translation and transcription come from (none: nowhere)
 */
export async function captionRoutes(req, res, root, rest, { translate = async () => null, transcribe } = {}) {
  /* the subtitle row's edits of one source (subtitle-edits.mjs) */
  if (await subtitleEditRoutes(req, res, root, rest)) return true;
  if (rest === 'captions' && req.method === 'GET') {
    json(res, 200, await filmCaptions(root));
    return true;
  }
  if (rest === 'captions/line' && req.method === 'PUT') {
    const { src, line, part, text, language } = /** @type {{ src?: unknown, line?: unknown, part?: unknown, text?: unknown, language?: unknown }} */ (await readJson(req));
    if (typeof src !== 'string' || typeof line !== 'number' || typeof text !== 'string') throw new HttpError(400, 'which line? { src, line, text }');
    if (part != null && !(typeof part === 'number' && Number.isInteger(part) && part >= 0)) throw new HttpError(400, `no such part of a line: ${String(part)}`);
    if (language != null && (typeof language !== 'string' || !isFilmSubtitleLanguage(language))) throw new HttpError(400, `no such subtitle language: ${String(language)}`);
    if (!inProject(root, src)) throw new HttpError(400, `${src} is not a file inside the project`);
    if (!(await setLine(root, src, line, text, language ?? undefined, part ?? undefined))) throw new HttpError(404, `${src} has no line starting at ${line} ms${part != null ? ` with a part ${part}` : ''}`);
    json(res, 200, { ok: true });
    return true;
  }
  if (rest === 'subtitles') {
    if (req.method === 'GET') { json(res, 200, { style: await readSubtitleStyle(root) }); return true; }
    if (req.method === 'PUT') {
      const body = /** @type {{ style?: unknown }} */ (await readJson(req));
      if (!isRecord(body.style)) throw new HttpError(400, 'which style? { style: { … } }');
      json(res, 200, { style: await writeSubtitleStyle(root, body.style) });
      return true;
    }
  }
  if (rest === 'subtitles/transcribe' && req.method === 'POST') {
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const { untranscribed } = await filmCaptions(root);
    /** @type {{ transcribed: string[], failed: { src: string, error: string }[] }} */
    const out = { transcribed: [], failed: [] };
    for (const src of untranscribed) {
      /* one made since the file changed is kept, unless it outlasts the file (filmCaptions): then it is not its own */
      if (await transcriptIsCurrent(root, src) && !(await outlastsItsFile(root, src))) continue;
      if (!transcribe) throw new HttpError(409, CONNECT_TRANSCRIBER, { code: 'no-transcriber' });
      try {
        await transcribe(root, src, controller.signal);
        out.transcribed.push(src);
      } catch (e) {
        if (/** @type {{ code?: unknown }} */ (e)?.code === 'not-connected') throw new HttpError(409, CONNECT_TRANSCRIBER, { code: 'no-transcriber' });
        if (controller.signal.aborted) throw e;
        out.failed.push({ src, error: String(/** @type {Error} */ (e)?.message ?? e) });
      }
    }
    json(res, out.failed.length && !out.transcribed.length ? 502 : 200, out);
    return true;
  }
  if (rest === 'subtitles/translate' && req.method === 'POST') {
    const { language } = /** @type {{ language?: unknown }} */ (await readJson(req));
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const result = await translateFilmSubtitles(root, String(language ?? ''), { translate: await translate(root), signal: controller.signal });
      json(res, result.failed.length && !result.translated.length && !result.already ? 502 : 200, result);
    } catch (e) {
      if (e instanceof CaptionError) throw new HttpError(e.status, e.message, e.code ? { code: e.code } : undefined);
      throw e;
    }
    return true;
  }
  return false;
}

/** For an export: the project's cues and style in one read (the style as the person left it, or the default). @param {string} root */
export async function subtitlesForExport(root) {
  const [{ cues }, style] = await Promise.all([filmCaptions(root), readSubtitleStyle(root)]);
  return { cues, style: style ?? parseFilmSubtitleStyle(null) };
}
