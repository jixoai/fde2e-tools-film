/**
 * The web store's public face: the one module api.ts (and anything else) imports. Everything else
 * in this folder is the store's guts. One store for the app; the server equivalent was
 * studio/server/{projects,files,history}.mjs.
 */
export { listProjects, getProject, createProject, deleteProject, renameProject, markOpened, setCover, readFilm, writeFilm, filmRev, listFiles, readFileText, readFileBytes, putFile, deleteFile, subscribe } from './store';
export type { StoreEvent, StoreFile, StoreListing, StoreListener, StoreProject } from './types';
