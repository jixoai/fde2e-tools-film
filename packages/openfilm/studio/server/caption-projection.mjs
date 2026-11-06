// Browser-safe caption projection shared by both stores.
import { alignTranslation, segmentLine, subtitleEnd } from './subtitle-segments.mjs';
/** @typedef {import('./film-subtitle.mjs').FilmSubtitleCue} FilmSubtitleCue */
/** @typedef {import('./transcript-format.mjs').SpokenLine} SpokenLine */
export const MIN_CAPTION_MS = 300;
/** A word counts as inside a trim within this much. */
const SLACK_MS = 60;
const EDGE_PUNCT = /^[\s，,、。．.；;：:！!？?…]+|[\s，,、；;：:]+$/g;
const LEAD_PUNCT = /^[\s，,、。．.；;：:！!？?…]+/;
/* standalone fillers (Chinese e, en, e; uh, um) are not printed; sentence particles that carry meaning are */
const FILLER = /(^|[\s\uff0c,\u3001\u3002.\uff01!\uff1f?])(?:\u5443|\u55ef|\u989d|uh|um|erm|mm+|hmm+|mhm)(?=$|[\s\uff0c,\u3001\u3002.\uff01!\uff1f?])[\uff0c,\u3001]?/giu;
/* a word broken off and said again ("a- and", "th- the"): the transcript marks it with a trailing hyphen */
const FALSE_START = /(^|\s)([\p{L}']{1,4})-\s+(?=(\p{L}+))/gu;
/* half-width punctuation after Chinese (common in text typed for TTS): Chinese subtitles set full-width */
const HALF_PUNCT = /(?<=[\u3400-\u9fff])\s*([,;:?!])(?=\s*(?:[\u3400-\u9fff\u201c\u2018\u300a\u300c]|$))/gu;
/** @type {Record<string, string>} */
const FULL_PUNCT = { ',': '\uff0c', ';': '\uff1b', ':': '\uff1a', '?': '\uff1f', '!': '\uff01' };

/**
 * A subtitle as it is printed: no fillers, no false starts, no punctuation it starts with, and its end set by the
 * convention of its script (subtitleEnd: Chinese drops a trailing ，。, Latin keeps its own); '' when nothing is left.
 * @param {string} t
 */
export function captionText(t) {
  const out = subtitleEnd(t.replace(FALSE_START, (all, lead, stub, next) => (String(next).toLowerCase().startsWith(String(stub).toLowerCase()) ? lead : all))
    .replace(HALF_PUNCT, (_all, mark) => FULL_PUNCT[mark] ?? mark)
    .replace(FILLER, '$1').replace(/\s+(?:\.{2,}|…+)\s*$/u, '').replace(/\s{2,}/g, ' ').replace(LEAD_PUNCT, '')).trim();
  return /[\p{L}\p{N}]/u.test(out) ? out : '';
}

/** The part of a line whose words start inside [fromMs, untilMs) (source ms). @param {SpokenLine} line @param {number} fromMs @param {number} untilMs */
export function trimToWindow(line, fromMs, untilMs) {
  const marks = line.marks;
  if (!marks?.length || (line.startMs >= fromMs - SLACK_MS && line.endMs <= untilMs + SLACK_MS)) return line.text;
  const first = marks.findIndex((m) => m.startMs >= fromMs - SLACK_MS);
  if (first < 0) return '';
  let last = marks.length - 1;
  while (last >= first && marks[last].startMs >= untilMs - SLACK_MS) last -= 1;
  if (last < first) return '';
  const begin = first === 0 ? 0 : marks[first].index;
  const end = last === marks.length - 1 ? line.text.length : marks[last + 1].index;
  return line.text.slice(begin, end).replace(EDGE_PUNCT, '');
}

/** Translations of a source's lines, by the line's start (source ms): language → text. @typedef {Map<number, Record<string, string>>} AltLines */

/** A line as one subtitle piece (segmentLine's shape). @param {SpokenLine} line */
export const wholeLine = (line) => ({
  text: line.text, startMs: line.startMs, endMs: line.endMs, ...(line.marks?.length ? { marks: [...line.marks] } : {}), part: 0, from: 0, to: line.text.length,
});

/**
 * One clip's subtitles. `span` is where it plays: source ms from `fromMs`, on the film from `startMs` for `durMs`, at
 * `speed` source ms per film ms. Each line is cut into subtitles first (segmentLine), its translations to follow
 * (alignTranslation); each cue says which piece of which line of which source it shows (`src`, `line`: the line's
 * start in the source, `part`: the piece, when the line has more than one), so the person's correction goes back into
 * that transcript.
 * @param {readonly SpokenLine[]} lines
 * @param {{ fromMs: number, startMs: number, durMs: number, speed: number }} span
 * `cut`: the transcript was cut by hand (transcripts.mjs CUT_NOTE): each line is one subtitle, as it is.
 * @param {{ alt?: AltLines, speaker?: string, clip?: string, src?: string, cut?: boolean }} [extra]
 * @returns {FilmSubtitleCue[]}
 */
export function clipCues(lines, span, extra = {}) {
  const speed = span.speed > 0 ? span.speed : 1;
  const until = span.fromMs + span.durMs * speed;
  const film = (/** @type {number} */ sourceMs) => Math.round(span.startMs + (sourceMs - span.fromMs) / speed);
  /** @type {FilmSubtitleCue[]} */
  const out = [];
  for (const line of lines) {
    const pieces = extra.cut ? [wholeLine(line)] : segmentLine(line);
    const alts = Object.entries(extra.alt?.get(line.startMs) ?? {}).map(([language, text]) => /** @type {const} */ ([language, alignTranslation(text, pieces)]));
    for (const piece of pieces) {
      const from = Math.max(piece.startMs, span.fromMs);
      const to = Math.min(piece.endMs, until);
      /* a piece belongs to this clip when one of its words starts inside the trim (its text is cut to those words: a
         piece across a cut shows its own half on each side); without word places, when its middle is inside */
      const mine = piece.marks?.length
        ? piece.marks.some((m) => m.startMs >= span.fromMs - SLACK_MS && m.startMs < until - SLACK_MS)
        : (piece.startMs + piece.endMs) / 2 >= span.fromMs && (piece.startMs + piece.endMs) / 2 < until;
      const said = captionText(trimToWindow(piece, span.fromMs, until));
      /* what a trim leaves of a piece can be a scrap; a piece itself is as long as segmentLine made it */
      const cut = from > piece.startMs || to < piece.endMs;
      if (!mine || !said || to <= from || (cut && (to - from) / speed < MIN_CAPTION_MS)) continue;
      /* the words shown, each from its mark to the next (the last to the piece's end), on the film; the last one ends as
         the subtitle does (no trailing comma in Chinese) */
      const shown = (piece.marks ?? []).filter((m) => m.startMs >= from - SLACK_MS && m.startMs < to);
      const words = shown.map((m, i) => {
        const next = shown[i + 1];
        const startMs = Math.max(from, m.startMs);
        const endMs = next ? next.startMs : to;
        const text = piece.text.slice(m.index, next ? next.index : undefined).trim();
        return { text: next ? text : subtitleEnd(text), startMs: film(startMs), durMs: Math.max(1, Math.round((endMs - startMs) / speed)) };
      }).filter((w) => w.text);
      const alt = Object.fromEntries(alts.map(([language, parts]) => [language, subtitleEnd(parts[piece.part].text)]).filter(([, text]) => text));
      out.push({
        startMs: film(from),
        durMs: Math.round((to - from) / speed),
        text: said,
        ...(words.length > 1 ? { words } : {}),
        ...(extra.speaker ? { speaker: extra.speaker } : {}),
        ...(Object.keys(alt).length ? { alt } : {}),
        ...(extra.clip ? { clip: extra.clip } : {}),
        ...(extra.src ? { src: extra.src, line: line.startMs, ...(pieces.length > 1 ? { part: piece.part } : {}) } : {}),
      });
    }
  }
  return out;
}
