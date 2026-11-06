import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToString } from 'react-dom/server';
import ts from 'typescript';
import { Player, type Sound } from '../editor/player.ts';

const require = createRequire(import.meta.url);
// Render the real private player component without importing the full editor or a browser.
// Only Preview's boundary is replaced, so its actual onInfo callback drives the real Player.
const source = readFileSync(new URL('./VersionVideoPreview.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(`${source}\nexport { SnapshotPlayer };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;

test('history ready callbacks load current and saved-version sounds without interrupting the first seek', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const audioNode = () => ({ connect() {}, gain: { value: 1 } });
  class AudioContextStub {
    destination = {};
    state = 'suspended';
    createGain = audioNode;
    createChannelSplitter = audioNode;
    createAnalyser = audioNode;
    addEventListener() {}
    close() { return Promise.resolve(); }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: AudioContextStub });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'AudioContext', previous);
    else delete (globalThis as { AudioContext?: unknown }).AudioContext;
  });
  const fetcher = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  const page = 'https://film.example/projects/p-current';
  for (const folder of ['/wf/p-current/', '/wf/p-current/versions/vsaved/', 'https://film-origin.example/saved/version/']) {
    let onInfo: ((info: { width: number; height: number; duration: number; sounds: Sound[] }) => void) | undefined;
    const exports: { SnapshotPlayer?: React.ComponentType<{ snapshot: unknown }> } = {};
    runInNewContext(compiled, {
      exports, URL, window: { location: { href: page } },
      require: (id: string) => {
        if (id === '@/editor/Preview') return { Preview: (props: { onInfo: typeof onInfo }) => { onInfo = props.onInfo; return null; } };
        if (id === '@/editor/player') return { Player };
        if (id === '@/i18n') return { useT: () => (key: string) => key };
        if (id === '@/api') return { api: {} };
        if (id === '@/lib/project-history') return { historyApi: {} };
        return require(id);
      },
    });
    renderToString(React.createElement(exports.SnapshotPlayer!, { snapshot: { folder, doc: { stage: { w: 1920, h: 1080 } }, missing: [] } }));
    assert.equal(typeof onInfo, 'function');
    const expected = new URL('assets/music.wav', new URL(folder, page));
    // The timeline reports pathname sounds, including the saved version's own directory.
    const sound = { src: expected.pathname, at: 0, from: 0, to: 60, volume: 1, speed: 1 };
    assert.doesNotThrow(() => onInfo!({ width: 1920, height: 1080, duration: 60, sounds: [sound] }), folder);
    await new Promise((resolve) => setImmediate(resolve));
    expected.searchParams.set('film-sound', '1');
    assert.equal(fetcher.mock.calls.at(-1)?.arguments[0], expected.href);
  }
  assert.equal(fetcher.mock.callCount(), 3);
});
