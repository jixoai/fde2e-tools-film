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


const fileResponse = (request, bytes, type) => {
  const size = bytes.byteLength;
  const range = request.headers.get('range');
  let start = 0;
  let end = Math.max(0, size - 1);
  let status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || size === 0) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    if (!match[1] && match[2]) {
      const length = Math.min(Number(match[2]), size);
      start = size - length;
    } else {
      start = Number(match[1] || 0);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    }
    status = 206;
  }
  const body = request.method === 'HEAD' ? null : bytes.slice(start, end + 1);
  return new Response(body, {
    status,
    headers: {
      'accept-ranges': 'bytes',
      'content-length': String(end - start + 1),
      'content-type': type,
      'cache-control': 'no-store',
      ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    },
  });
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
const PAGE_SCALE = `(()=>{try{if(parent===window)return;const k=Number(new URL(parent.location.href).searchParams.get('film-dpr'));if(k>0)Object.defineProperty(window,'devicePixelRatio',{configurable:true,get:()=>k})}catch{}})();`;
const editorScripts = async (origin, withStage) => {
  /* Do not retain these across navigations: an already-active worker must pick up a newly deployed
     bridge/stage even when its own source did not change. */
  const read = (name) => fetch(new URL(`/__film/${name}`, origin), { cache: 'no-store' }).then((response) => {
    if (!response.ok) throw new Error(`missing Film runtime ${name}`);
    return response.text();
  });
  const [host, bridge, stage] = await Promise.all([read('host-flag.js'), read('bridge.js'), ...(withStage ? [read('stage.js')] : [])]);
  return {
    host,
    bridge: bridge.replaceAll('__EDITOR__', JSON.stringify(origin)),
    stage: stage?.replaceAll('__EDITOR__', JSON.stringify(origin)) ?? '',
  };
};
const script = (text) => `<script>${text}</script>`;
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
  let segs;
  try { segs = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part)); } catch { return; }
  if (segs.some((part) => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0'))) return;
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
    const isHtml = /\.html?$/i.test(name);
    const injectFilm = event.request.method === 'GET' && isFilm && url.searchParams.has('load') && url.searchParams.get('film-host') !== '0';
    const injectPage = event.request.method === 'GET' && isHtml && !isFilm && url.searchParams.get('film-host') !== '0';
    if (injectFilm || injectPage) {
      const bytes = await readBytes(id, parts);
      if (bytes === null) return new Response('Not found in this project', { status: 404 });
      const html = new TextDecoder().decode(bytes);
      const runtime = await editorScripts(url.origin, injectFilm);
      const prefix = injectFilm
        ? script(runtime.host) + script(runtime.bridge) + script(runtime.stage) + FILM_START(stageOf(html))
        : script(runtime.host + PAGE_SCALE) + script(runtime.bridge);
      const injected = injectFirst(html, prefix);
      const body = new TextEncoder().encode(injected).buffer;
      return fileResponse(event.request, body, 'text/html; charset=utf-8');
    }
    const bytes = await readBytes(id, parts);
    if (bytes === null) return new Response('Not found in this project', { status: 404 });
    return fileResponse(event.request, bytes, kindOf(name));
  })());
});
