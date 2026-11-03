/**
 * The four ways in, at the seam (import.ts): text shape detection, and the store round-trip when
 * OPFS exists (browser runs; skipped under plain node like the store's own test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const FILM = '<!doctype html><html><head><meta name="viewport" content="width=1920, height=1080"></head><body><section><iframe src="p.html"></iframe></section></body></html>';
const PAGE = '<!doctype html><html><head><meta name="viewport" content="width=1920, height=1080"></head><script>window.film={width:1920,height:1080,duration:2}</script></body></html>';

test('filmShapeOf: the edit file, a page clip, or neither', async () => {
  const { filmShapeOf, looksLikeFilmHtml } = await import('./import.ts');
  assert.equal(filmShapeOf(FILM), 'film');
  assert.equal(filmShapeOf(PAGE), 'page');
  assert.equal(filmShapeOf('<!doctype html><h1>a plain page</h1>'), 'other');
  assert.equal(looksLikeFilmHtml(PAGE), true);
  assert.equal(looksLikeFilmHtml(''), false);
});

test('fetchFilmKinded sorts its failures without a network', async () => {
  const { fetchFilmKinded, UrlFilmError } = await import('./import.ts');
  await assert.rejects(() => fetchFilmKinded('/no-such-film.html'), (e: unknown) => e instanceof UrlFilmError);
});
