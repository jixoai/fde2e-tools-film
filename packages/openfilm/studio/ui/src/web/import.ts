/**
 * The web face's ways in (design D3): a film's text arrives by drag, paste, a URL, or an inject
 * event from the browser bridge — all four land in one place, `importFilmText`, which makes the
 * project through the store's atomic project importer and answers it, ready to open. The
 * caller says what to do next; here only "a project now holds this film".
 */
import { createProjectFromFiles } from './opfs/index.ts';
import type { StoreProject } from './opfs';

export type FilmShape = 'film' | 'page' | 'other';

/** What a dropped/pasted text is: a film (the format's edit file: body of sections, no script),
    a page (a `window.film` page clip, wrapped into a film on import), or something else. */
export function filmShapeOf(text: string): FilmShape {
  if (!/<html|<!doctype|<body/i.test(text)) return 'other';
  if (/<section[\s>]/i.test(text)) return 'film';
  if (/window\.film\s*=/.test(text)) return 'page';
  return 'other';
}

/** Whether a text can come in as a project (a film itself, or a page the import wraps). */
export function looksLikeFilmHtml(text: string): boolean {
  return filmShapeOf(text) !== 'other';
}

/** A file's name (a dropped `title.html`, a pasted document) read as a project name. */
export function nameFromFile(file: { name?: string } | null | undefined): string | undefined {
  const base = file?.name?.replace(/\.html?$/i, '').trim();
  return base || undefined;
}

/** The film.html that wraps an imported page clip: the page plays alone, full stage. */
const filmForPage = (stageW: number, stageH: number): string =>
  `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=${stageW}, height=${stageH}">\n</head>\n<body>\n<section>\n<iframe src="imported.html"></iframe>\n</section>\n</body>\n</html>\n`;

const stageOfPage = (text: string): { w: number; h: number } => {
  const m = /<meta\s+name="viewport"\s+content="width=(\d+),\s*height=(\d+)"/i.exec(text);
  const film = /window\.film\s*=\s*\{[^}]*width\s*:\s*(\d+)[^}]*height\s*:\s*(\d+)/i.exec(text);
  return { w: Number(m?.[1] ?? film?.[1] ?? 1920), h: Number(m?.[2] ?? film?.[2] ?? 1080) };
};

/** Make a project from a film's text (a film lands as its film.html; a page is wrapped into one —
    its text kept as `imported.html`, the film plays it full stage). Answers the project. */
export async function importFilmText(text: string, name?: string): Promise<StoreProject> {
  const shape = filmShapeOf(text);
  const filmText = shape === 'page' ? filmForPage(stageOfPage(text).w, stageOfPage(text).h) : text;
  return createProjectFromFiles(name, [
    { path: 'film.html', data: filmText },
    ...(shape === 'page' ? [{ path: 'imported.html', data: text }] : []),
  ]);
}

/** A film fetched from an address (fail-open: CORS or the network refusing is the answer, said by
    the caller; nothing is proxied, nothing silently retried). */
export async function fetchFilmFromUrl(url: string): Promise<string> {
  const res = await fetch(url, { mode: 'cors', redirect: 'follow' });
  if (!res.ok) throw new UrlFilmError(`the address answered ${res.status}`, 'status');
  const text = await res.text();
  if (filmShapeOf(text) === 'other') throw new UrlFilmError('that address is not a film or a film page', 'not-film');
  return text;
}

/** Why a URL film could not come in: 'cors' (the browser refused, nothing reached), 'status',
    'network' (the request itself failed) or 'not-film'. */
export class UrlFilmError extends Error {
  readonly kind: 'cors' | 'status' | 'network' | 'not-film';
  constructor(message: string, kind: UrlFilmError['kind']) {
    super(message);
    this.kind = kind;
  }
}

/** Fetch with the failure kinds sorted (a thrown TypeError mid-fetch is the browser's CORS-or-network wall). */
export async function fetchFilmKinded(url: string): Promise<string> {
  try {
    return await fetchFilmFromUrl(url);
  } catch (e) {
    if (e instanceof UrlFilmError) throw e;
    throw new UrlFilmError('the browser refused the cross-site read (no CORS answer from the address)', 'cors');
  }
}
