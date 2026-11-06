import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPluginRender } from './plugin-capture.ts';

type BridgeRequest = { protocol: string; id: string; action: string; handle?: string };

test('repeated render close shares its pending cleanup and blocks the next open', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const events = new EventTarget();
  const sent: BridgeRequest[] = [];
  const pending = new Map<string, BridgeRequest>();
  const origin = 'https://alpha-film-test.fde2e.com';
  let opens = 0;
  let firstClose: BridgeRequest | undefined;
  const reply = (request: BridgeRequest, result: Record<string, unknown>) => {
    pending.delete(request.id);
    const event = new Event('message');
    Object.assign(event, { source: fakeWindow, origin, data: { protocol: request.protocol, id: request.id, result } });
    events.dispatchEvent(event);
  };
  const fakeWindow = {
    setTimeout,
    addEventListener: events.addEventListener.bind(events),
    postMessage(request: BridgeRequest) {
      sent.push(request);
      pending.set(request.id, request);
      if (request.action === 'renderOpen') {
        const handle = `render-${++opens}`;
        queueMicrotask(() => reply(request, { ok: true, handle }));
      } else if (request.action === 'renderClose' && request.handle === 'render-1') {
        if (!firstClose) firstClose = request;
        // BU removes the handle before native window cleanup finishes. A duplicate
        // close can therefore fail quickly while the first close is still pending.
        else queueMicrotask(() => reply(request, { ok: false, error: 'render handle is no longer owned' }));
      } else {
        queueMicrotask(() => reply(request, { ok: true }));
      }
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });

  try {
    const first = await openPluginRender('p-close-race', { w: 1280, h: 720 });
    const closing = first.close();
    const repeated = first.close();
    let nextOpened = false;
    const opening = openPluginRender('p-close-race', { w: 1280, h: 720 }).then((render) => {
      nextOpened = true;
      return render;
    });

    // Let both the duplicate response and the next open run, without resolving
    // native cleanup. This is the window in which the previous code reopened.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(repeated, closing);
    assert.equal(sent.filter((request) => request.action === 'renderClose').length, 1);
    assert.equal(opens, 1, 'the next render must wait for the first window to close');
    assert.equal(nextOpened, false);
    assert(firstClose);

    reply(firstClose, { ok: true });
    await Promise.all([closing, repeated]);
    const second = await opening;
    assert.equal(opens, 2);
    assert.equal(nextOpened, true);
    await first.close();
    assert.equal(sent.filter((request) => request.handle === 'render-1').length, 1, 'settled close remains idempotent');
    await second.close();
  } finally {
    // Clear request timers even when an assertion exposes the regression.
    for (const request of [...pending.values()]) reply(request, { ok: true, handle: 'cleanup' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});
