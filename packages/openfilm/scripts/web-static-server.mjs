#!/usr/bin/env node
/**
 * Production-shaped local server for the pure static Web face.
 *
 * It proves the two deployment rules a generic SPA preview usually gets wrong: extension-less
 * project files such as LICENSE are served before the route fallback, and byte ranges work for
 * video/audio seeking. The real deployment uses the same ordering in OpenResty.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

const flags = new Map(process.argv.slice(2).flatMap((arg, index, all) => arg.startsWith('--') ? [[arg, all[index + 1]]] : []));
const inside = (root, file) => file === root || file.startsWith(`${root}${sep}`);
const existsFile = async (file) => { try { return (await stat(file)).isFile(); } catch { return false; } };

export async function createFilmStaticServer({
  dir = join(ROOT, 'studio', 'ui', 'dist'),
  host = '127.0.0.1',
  port = 0,
} = {}) {
  const staticRoot = resolve(dir);
  const fallback = join(staticRoot, 'index-web.html');
  if (!await existsFile(fallback)) throw new Error(`missing Web build: ${fallback}`);

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' }); response.end(); return;
      }
      const requestPath = decodeURIComponent(new URL(request.url ?? '/', 'http://film.local').pathname);
      let file = resolve(staticRoot, `.${requestPath === '/' ? '/index-web.html' : requestPath}`);
      if (!inside(staticRoot, file)) { response.writeHead(403); response.end('forbidden'); return; }
      if (!await existsFile(file)) {
        if (extname(requestPath)) { response.writeHead(404); response.end('not found'); return; }
        file = fallback;
      }
      const info = await stat(file);
      const range = request.headers.range;
      let start = 0;
      let end = info.size - 1;
      let status = 200;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) { response.writeHead(416, { 'content-range': `bytes */${info.size}` }); response.end(); return; }
        if (!match[1] && match[2]) {
          const length = Math.min(Number(match[2]), info.size);
          start = info.size - length;
        } else {
          start = Number(match[1] || 0);
          end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) {
          response.writeHead(416, { 'content-range': `bytes */${info.size}` }); response.end(); return;
        }
        status = 206;
      }
      const headers = {
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        'content-type': MIME[extname(file).toLowerCase()] ?? (basename(file).includes('LICENSE') ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
        'cache-control': requestPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}),
      };
      response.writeHead(status, headers);
      if (request.method === 'HEAD') { response.end(); return; }
      createReadStream(file, { start, end }).on('error', (error) => response.destroy(error)).pipe(response);
    } catch (error) {
      response.writeHead(400); response.end(error instanceof Error ? error.message : 'bad request');
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createFilmStaticServer({
    dir: flags.get('--dir') || join(ROOT, 'studio', 'ui', 'dist'),
    host: flags.get('--host') || '127.0.0.1',
    port: Number(flags.get('--port') || process.env.PORT || 13690),
  });
  const address = server.address();
  console.log(`FDE2E Film static: http://${address.address}:${address.port}/index-web.html`);
  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
