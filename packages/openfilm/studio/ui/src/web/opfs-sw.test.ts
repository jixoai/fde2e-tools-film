import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const worker = readFileSync(new URL('../../public/opfs-sw.js', import.meta.url), 'utf8');
const origin = 'https://film.example';
const film = '<!doctype html><html><head><meta name="viewport" content="width=1920, height=1080"></head><body><section><audio src="assets/music.wav"></audio></section></body></html>';

function fileServer() {
  const stored = new Map<string, string>([
    ['projects/p-film/film.html', film],
    ['projects/p-film/assets/music.wav', 'working audio'],
    ['projects/p-film/versions/vsaved/film.html', film],
    ['projects/p-film/versions/vsaved/assets/music.wav', 'saved audio'],
  ]);
  const directory = (path: string[] = []): unknown => ({
    getDirectoryHandle: async (name: string) => directory([...path, name]),
    getFileHandle: async (name: string) => {
      const value = stored.get([...path, name].join('/'));
      if (value === undefined) throw new DOMException('missing fixture', 'NotFoundError');
      return { getFile: async () => new Blob([value]) };
    },
  });
  let onFetch: (event: { request: Request; respondWith(response: Promise<Response>): void }) => void;
  const fetched: string[] = [];
  const network = async (url: URL | string) => {
    const address = new URL(url, origin);
    fetched.push(address.pathname);
    return new Response(`/* runtime: ${address.pathname} */`, { headers: { 'content-type': 'text/javascript' } });
  };
  runInNewContext(worker, {
    URL, Response, TextDecoder, TextEncoder,
    navigator: { storage: { getDirectory: async () => directory() } },
    self: { addEventListener: (type: string, listener: typeof onFetch) => { if (type === 'fetch') onFetch = listener; } },
    fetch: network,
  });
  return {
    fetched,
    async request(path: string) {
      const request = new Request(new URL(path, origin));
      let response: Promise<Response> | undefined;
      onFetch({ request, respondWith: (pending) => { response = pending; } });
      return response ?? network(request.url);
    },
  };
}

for (const folder of ['/wf/p-film/', '/wf/p-film/versions/vsaved/']) {
  test(`injected runtime and relative media resolve from ${folder}`, async () => {
    const server = fileServer();
    const address = `${folder}film.html?load=1`;
    const response = await server.request(address);
    assert.equal(response.status, 200);
    const html = await response.text();
    const module = /<script type="module" src="([^"]+)"/.exec(html)?.[1];
    assert.ok(module, 'the timeline runtime is injected');
    const moduleUrl = new URL(module, new URL(address, origin));
    const runtime = await server.request(moduleUrl.href);
    assert.equal(runtime.status, 200, moduleUrl.pathname);
    assert.match(runtime.headers.get('content-type') ?? '', /javascript/);
    // Its imports must use the same static runtime tree, never a version's OPFS directory.
    for (const dependency of ['./film-doc.mjs', './overrides.mjs']) {
      assert.equal((await server.request(new URL(dependency, moduleUrl).href)).status, 200);
    }
    assert.ok(server.fetched.includes('/__film/timeline.mjs'));
    const media = /<audio src="([^"]+)"/.exec(html)?.[1];
    assert.ok(media);
    const audio = await server.request(new URL(media, new URL(address, origin)).href);
    assert.equal(await audio.text(), folder.includes('/versions/') ? 'saved audio' : 'working audio');
    // The timeline's raw-source read must not receive another injected copy.
    const raw = await server.request(`${address}&film-host=0`);
    assert.equal(await raw.text(), film);
  });
}
