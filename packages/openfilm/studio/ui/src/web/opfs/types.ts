/**
 * The OPFS project store's types (the web editor's file face, design D2):
 * the shape a backend answers, so api.ts can sit on a store instead of Studio's server.
 *
 * Layout (design D2):
 *
 *   projects/
 *   ├─ <project-id>/
 *   │  ├─ film.html            the film protocol's text, rewritten on every edit
 *   │  ├─ assets/…             media, kept under its own names
 *   │  └─ .film/               project state: id, settings, versions/, history.json
 *   └─ .examples/…             example projects, copied into a real project when loaded
 */

/** A project as the store lists it (api.ts `Project` without the server-only fields). */
export type StoreProject = {
  id: string;
  name: string;
  /** when the project was last opened (the list's `recent` order) */
  openedAt: number;
  /** epoch ms when the project folder was created (the list's `newest`) */
  createdAt: number;
  /** the folder is there but film.html is not (a write halfway, or it lost) */
  missing: boolean;
  missingReason?: 'folder' | 'film';
  /** set when the person picks a cover of their own */
  cover?: number;
};

/** A file of a project's assets/ (and its pages). */
export type StoreFile = {
  path: string;
  kind: 'video' | 'image' | 'audio' | 'page' | 'other';
  size: number;
  mtime: number;
};

/** What a project holds, as api.ts `Listing` says it. */
export type StoreListing = { files: StoreFile[]; folders: string[]; pages: { path: string; size: number; mtime: number }[] };

/** The events a store tells (api.ts `FolderEvent`'s web subset): the UI hears these instead of a WebSocket. */
export type StoreEvent = { type: 'film'; rev: string } | { type: 'files'; paths?: string[] } | { type: 'history' } | { type: 'project' } | { type: 'gone' } | { type: 'film-missing' };

export type StoreListener = (event: StoreEvent) => void;
