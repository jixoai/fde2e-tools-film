/**
 * The film a new project starts with: the format's own writer makes it (`filmHtml(EMPTY_FILM)`,
 * src/film-doc.mjs) — the same first film a fresh server project would get, imported here as it is
 * (a browser-safe module). Kept as one function so the store and any future seeder cannot drift.
 */
import { filmHtml } from '../../../../../src/film-doc.mjs';

/** The empty film the format starts from (studio/server/film.mjs EMPTY_FILM, mirrored here for the web). */
export const EMPTY_FILM = { stage: { w: 1920, h: 1080 }, tracks: [] } as const;

export const emptyFilmHtml = (): string => filmHtml(structuredClone(EMPTY_FILM) as Parameters<typeof filmHtml>[0]);
