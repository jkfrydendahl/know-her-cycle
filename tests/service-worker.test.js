import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
function worker() {
  const handlers = {}, notifications = [], messages = [], cacheWrites = [];
  const context = {
    URL, Response,
    self: { location: { origin: 'https://cycle.example' }, addEventListener: (type, handler) => { handlers[type] = handler; },
      registration: { showNotification: async (...args) => notifications.push(args) },
      clients: { matchAll: async () => [{ url: 'https://cycle.example/', postMessage: (message) => messages.push(message), focus: async () => true }], claim: async () => true }
    },
    caches: { open: async () => ({ put: async (...args) => cacheWrites.push(args) }), match: async () => undefined },
    fetch: async () => new Response('asset')
  };
  vm.runInNewContext(source, context);
  return { handlers, notifications, messages, cacheWrites };
}
test('service worker never intercepts private API requests or cross-origin content', () => {
  const w = worker();
  for (const [url, method] of [['https://cycle.example/api/state', 'GET'], ['https://cycle.example/api/phase', 'POST'], ['https://evil.example/app.js', 'GET']]) {
    w.handlers.fetch({ request: { url, method }, respondWith() { assert.fail('Private/cross-origin request was intercepted'); } });
  }
});
test('push displays discreet fixed text and refreshes open clients, ignoring payload URLs', async () => {
  const w = worker(); let task;
  w.handlers.push({ data: { json: () => ({ body: 'Ovulation details', url: 'https://evil.example' }) }, waitUntil(promise) { task = promise; } });
  await task;
  assert.equal(w.notifications.length, 1);
  assert.equal(w.notifications[0][0], 'Cycle updated');
  assert.equal(w.notifications[0][1].body, 'Open the app to see the latest phase.');
  assert.equal(w.notifications[0][1].data.url, '/');
  assert.equal(w.messages[0].type, 'phase-updated');
});

test('reminders use an allowlisted message with no supplied phase details or external URL', async () => {
  const w = worker(); let task;
  w.handlers.push({ data: { json: () => ({ type: 'reminder', body: 'private details', url: 'https://evil.example' }) }, waitUntil(promise) { task = promise; } });
  await task;
  assert.equal(w.notifications[0][0], 'Cycle reminder');
  assert.equal(w.notifications[0][1].body, 'Your next phase is scheduled for tomorrow. Open the app to review it.');
  assert.equal(w.notifications[0][1].data.url, '/');
  assert.equal(w.notifications[0][1].tag, 'khc-phase-reminder');
});

test('test reminders are clearly labelled and ignore supplied content', async () => {
  const w = worker(); let task;
  w.handlers.push({ data: { json: () => ({ type: 'test-reminder', title: 'spoofed', body: 'private', url: 'https://evil.example' }) }, waitUntil(promise) { task = promise; } });
  await task;
  assert.equal(w.notifications[0][0], 'Test reminder');
  assert.equal(w.notifications[0][1].body, 'This is a test reminder. No phase change is scheduled by this message.');
  assert.equal(w.notifications[0][1].data.url, '/');
  assert.equal(w.notifications[0][1].tag, 'khc-test-reminder');
});
