/**
 * The web face's file server: answers `/wf/<id>/…` from OPFS, so the film's pages (film.html and
 * its own pages), media and covers load through plain URLs the way Studio's server served them.
 * Registered by the web entry (src/web/main-web.tsx); the store keeps writing OPFS, the browser
 * keeps fetching URLs. Plain JS: a Service Worker module outside the app bundle (no React, no
 * imports) — it reads OPFS directly, seeing the same files the page's store writes.
 */
const ROOT = 'projects';
const PREFIX = 'wf';

const kindOf = (name) => {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'text/html; charset=utf-8';
  if (ext === 'js' || ext === 'mjs') return 'text/javascript; charset=utf-8';
  if (ext === 'css') return 'text/css; charset=utf-8';
  if (ext === 'json') return 'application/json; charset=utf-8';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(ext)) return `image/${ext}`;
  if (ext === 'svg') return 'image/svg+xml';
  if (['mp4', 'webm', 'm4v'].includes(ext)) return `video/${ext}`;
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'mp3') return 'audio/mpeg';
  if (['wav', 'm4a', 'aac', 'ogg', 'opus', 'flac'].includes(ext)) return `audio/${ext}`;
  if (['woff', 'woff2', 'ttf', 'otf'].includes(ext)) return `font/${ext}`;
  return 'application/octet-stream';
};

async function readBytes(id, parts) {
  const base = await navigator.storage.getDirectory();
  let at;
  try { at = await base.getDirectoryHandle(ROOT, { create: false }); } catch { return null; }
  try { at = await at.getDirectoryHandle(id, { create: false }); } catch { return null; }
  for (let i = 0; i < parts.length - 1; i++) {
    try { at = await at.getDirectoryHandle(parts[i], { create: false }); } catch { return null; }
  }
  try {
    const f = await at.getFileHandle(parts[parts.length - 1], { create: false });
    return await (await f.getFile()).arrayBuffer();
  } catch { return null; }
}

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

/* The film page's runtime: the host flag and the timeline loader, injected before any page script
   (src/host.mjs does this on the server face). The bridge and stage scripts — the editor's
   in-page editing protocol — come with the editor batches that need them; until then the preview
   draws the film and the picture-area editing waits. `__film/*` (the timeline itself) is served
   from the static build (public/__film/, emitted by studio/ui/scripts/emit-film-runtime.mjs). */
const HOST_FLAG = `window.filmHost={version:'0.1',name:'film'};`;
const FILM_START = (stage) => `<style>html,body{margin:0;overflow:hidden}:where(body){background:#000}`
  + `body>section{display:contents}body>section>:is(iframe,video,img,audio){position:absolute;left:0;top:0;margin:0;visibility:hidden}`
  + `body>section>iframe{border:0;width:${stage.w}px;height:${stage.h}px}:where(body>section>:is(video,img)){object-fit:contain}</style>`
  + `<script type="module" src="__film/timeline.mjs"></script>`;

/* the stage as the film's <head> says it (the same meta viewport the server face reads) */
const stageOf = (html) => {
  const m = /<meta\s+name="viewport"\s+content="width=(\d+),\s*height=(\d+)"/i.exec(html);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1920, h: 1080 };
};

/* put `fragment` (whole tags) right after <head> (src/host.mjs injectFirst): head scripts run
   before any page script; a page with no head gets it after the doctype */
const injectFirst = (html, fragment) => {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + fragment + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + fragment + html.slice(doctype[0].length) : fragment + html;
};

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const segs = url.pathname.split('/').filter(Boolean);
  const at = segs.indexOf(PREFIX);
  if (at === -1) return;
  const [id, ...parts] = segs.slice(at + 1);
  if (!id || !parts.length) return;
  event.respondWith((async () => {
    /* the film's runtime is a static file of the site (public/__film/), not project data: pass it
       through without the /wf/<id>/ prefix */
    if (parts[0] === '__film') {
      return fetch(new URL('/' + parts.join('/'), url.origin));
    }
    const name = parts[parts.length - 1];
    const isFilm = name === 'film.html';
    /* only a preview frame (`?load=`, Preview.tsx) gets the runtime injected: the editor reads the
       film's own text through api.film — an injected copy would pollute the format's reader */
    const inject = isFilm && url.searchParams.has('load') && url.searchParams.get('film-host') !== '0';
    if (inject) {
      const bytes = await readBytes(id, parts);
      if (bytes === null) return new Response('Not found in this project', { status: 404 });
      const html = new TextDecoder().decode(bytes);
      const stage = stageOf(html);
      const injected = injectFirst(injectFirst(html, FILM_START(stage)), `<script>${HOST_FLAG}</script>`);
      return new Response(injected, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const bytes = await readBytes(id, parts);
    if (bytes === null) return new Response('Not found in this project', { status: 404 });
    return new Response(bytes, {
      headers: { 'content-type': kindOf(name), 'cache-control': 'no-store' },
    });
  })());
});
