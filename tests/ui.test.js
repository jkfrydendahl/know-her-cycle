import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { createHandler } from '../server/http.js';
import { memoryStore } from '../server/memory-store.js';
import { PHASES, phaseById } from '../public/phases.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/, '');
const env = { APP_ORIGIN: 'https://cycle.example', VAPID_PUBLIC_KEY: 'public-key', VAPID_PRIVATE_KEY: 'private-key', VAPID_CONTACT: 'mailto:example@example.com' };
const keyBytes = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/ui-phone', keys: { p256dh: keyBytes, auth: Buffer.alloc(16, 8).toString('base64url') } };

async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 3)); }
  throw new Error('UI did not reach the expected state.');
}
async function device(handler, fragment = '', saved = null) {
  const dom = new JSDOM(html, { url: `${env.APP_ORIGIN}/${fragment}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  if (saved) w.localStorage.setItem('khc-access-v1', JSON.stringify(saved));
  let subscription = null;
  const registration = { pushManager: {
    getSubscription: async () => subscription,
    subscribe: async () => {
      subscription = { ...sub, toJSON: () => sub, unsubscribe: async () => { subscription = null; return true; } };
      return subscription;
    }
  } };
  Object.defineProperty(w.navigator, 'serviceWorker', { value: { register: async () => registration, ready: Promise.resolve(registration), addEventListener() {} } });
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async () => {} } });
  w.PushManager = class {};
  w.Notification = { permission: 'default', requestPermission: async () => { w.Notification.permission = 'granted'; return 'granted'; } };
  w.matchMedia = () => ({ matches: false }); w.confirm = () => true;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  w.AbortSignal = globalThis.AbortSignal;
  w.PHASES = PHASES; w.phaseById = phaseById;
  let online = true;
  w.fetch = async (url, options) => {
    if (!online) throw new TypeError('Network unavailable');
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
    await handler({ query: { action: url.split('/').at(-1) }, method: options.method, headers: {
      origin: env.APP_ORIGIN, 'content-type': options.headers['Content-Type'], authorization: options.headers.Authorization,
      'x-real-ip': 'ui-test'
    }, body: options.body ? JSON.parse(options.body) : undefined }, res);
    return { ok: res.code < 400, status: res.code, json: async () => res.data };
  };
  // Match module scope, so app helpers do not replace Window.open/close.
  vm.runInContext(`(() => { ${source}\n})();`, dom.getInternalVMContext());
  const byId = (id) => w.document.getElementById(id);
  try { await until(() => !byId('start-owner').disabled || !byId('tracker').hidden); }
  catch (error) { dom.window.close(); throw error; }
  return { dom, w, $: byId, online(value) { online = value; } };
}

test('two-device UI: setup, invitation, partner push, phase update, correction, undo, offline, recovery and revocation', async (t) => {
  const deliveries = [];
  const handler = createHandler({ store: memoryStore(), env, notify: async (event) => { deliveries.push(event); return { sent: event.subscriptions.length, failed: 0 }; } });
  const owner = await device(handler); t.after(() => owner.dom.window.close());
  owner.$('start-owner').click();
  assert.equal(owner.$('phase-dialog').open, true);
  owner.$('phase-options').querySelector('[data-phase="menstrual"]').click();
  await until(() => !owner.$('tracker').hidden && !owner.$('next-phase').disabled);
  assert.equal(owner.$('phase-name').textContent, 'Menstrual');
  assert.equal(owner.$('viewer-actions').hidden, true);
  owner.$('settings-open').click(); owner.$('invite').click();
  await until(() => !owner.$('invite-result').hidden);
  const invitation = new URL(owner.$('invite-link').value);
  const viewer = await device(handler, invitation.hash); t.after(() => viewer.dom.window.close());
  assert.equal(viewer.w.location.hash, '');
  assert.equal(viewer.$('join-dialog').open, true);
  viewer.$('join-form').dispatchEvent(new viewer.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !viewer.$('tracker').hidden && !viewer.$('enable-push').disabled);
  assert.equal(viewer.$('owner-actions').hidden, true);
  assert.equal(viewer.$('phase-name').textContent, 'Menstrual');
  viewer.$('enable-push').click();
  await until(() => viewer.$('enable-push').textContent.includes('enabled'));
  owner.$('settings-dialog').close(); owner.$('next-phase').click();
  await until(() => owner.$('phase-name').textContent === 'Follicular' && !owner.$('next-phase').disabled);
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].subscriptions.length, 1);
  viewer.$('refresh').click();
  await until(() => viewer.$('phase-name').textContent === 'Follicular' && !viewer.$('refresh').disabled);
  owner.$('correct-phase').click(); owner.$('phase-options').querySelector('[data-phase="luteal"]').click();
  await until(() => owner.$('phase-name').textContent === 'Luteal' && !owner.$('undo').disabled);
  owner.$('undo').click();
  await until(() => owner.$('phase-name').textContent === 'Follicular' && !owner.$('next-phase').disabled);
  assert.equal(owner.$('undo').disabled, true);
  owner.online(false); owner.w.dispatchEvent(new owner.w.Event('offline'));
  assert.equal(owner.$('next-phase').disabled, true);
  assert.match(owner.$('sync-label').textContent, /offline/);
  owner.online(true); owner.$('refresh').click();
  await until(() => !owner.$('next-phase').disabled);
  const accessKey = JSON.parse(owner.w.localStorage.getItem('khc-access-v1'));
  const recovered = await device(handler, '', accessKey); t.after(() => recovered.dom.window.close());
  await until(() => recovered.$('phase-name').textContent === 'Follicular');
  owner.$('settings-open').click(); owner.$('disconnect').click();
  await until(() => owner.$('sharing-label').textContent.startsWith('Only you'));
  viewer.$('refresh').click();
  await until(() => !viewer.$('welcome').hidden);
  assert.equal(viewer.w.localStorage.getItem('khc-access-v1'), null);
});

test('all HTML IDs are unique and all application element references exist', () => {
  const dom = new JSDOM(html);
  const ids = [...dom.window.document.querySelectorAll('[id]')].map((element) => element.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of source.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(id), `Missing #${id}`);
  dom.window.close();
});
