import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import webpush from 'web-push';
import { createHandler } from '../server/http.js';
import { memoryStore } from '../server/memory-store.js';
import { createService } from '../server/domain.js';
import { PHASES, phaseById } from '../public/phases.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/, '');
const vapid = webpush.generateVAPIDKeys();
const env = { CRON_SECRET: 's'.repeat(32), APP_ORIGIN: 'https://cycle.example', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_CONTACT: 'mailto:example@example.com' };
const keyBytes = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/ui-phone', keys: { p256dh: keyBytes, auth: Buffer.alloc(16, 8).toString('base64url') } };

async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 3)); }
  throw new Error('UI did not reach the expected state.');
}
async function device(handler, fragment = '', saved = null, { reducedMotion = false, oldApplicationServerKey = null } = {}) {
  const dom = new JSDOM(html, { url: `${env.APP_ORIGIN}/${fragment}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  if (saved) w.localStorage.setItem('khc-access-v1', JSON.stringify(saved));
  let subscription = null;
  if (oldApplicationServerKey) subscription = { ...sub, options: { applicationServerKey: oldApplicationServerKey },
    toJSON: () => sub, unsubscribe: async () => { subscription = null; return true; } };
  const registration = { pushManager: {
    getSubscription: async () => subscription,
    subscribe: async (options) => {
      subscription = { ...sub, options: { applicationServerKey: options.applicationServerKey }, toJSON: () => sub, unsubscribe: async (options) => { subscription = null; return true; } };
      return subscription;
    }
  } };
  Object.defineProperty(w.navigator, 'serviceWorker', { value: { register: async () => registration, ready: Promise.resolve(registration), addEventListener() {} } });
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async () => {} } });
  w.PushManager = class {};
  w.Notification = { permission: oldApplicationServerKey ? 'granted' : 'default', requestPermission: async () => { w.Notification.permission = 'granted'; return 'granted'; } };
  w.matchMedia = (query) => ({ matches: reducedMotion && query === '(prefers-reduced-motion: reduce)' }); w.confirm = () => true;
  const animations = [];
  w.Element.prototype.animate = function (frames, options) { animations.push({ target: this, frames, options }); return { cancel() {} }; };
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
  return { dom, w, $: byId, animations, online(value) { online = value; } };
}

test('two-device UI: setup, invitation, partner push, phase update, correction, undo, offline, recovery and revocation', async (t) => {
  const deliveries = [];
  const handler = createHandler({ store: memoryStore(), env, notify: async (event) => { deliveries.push(event); return { sent: event.subscriptions.length, failed: 0 }; } });
  const owner = await device(handler); t.after(() => owner.dom.window.close());
  owner.$('start-owner').click();
  assert.equal(owner.$('phase-dialog').open, true);
  owner.$('phase-options').querySelector('[data-phase="menstrual"]').click();
  await until(() => !owner.$('tracker').hidden && !owner.$('next-phase').disabled);
  assert.equal(owner.$('phase-name').textContent, 'Menstrual 😭');
  assert.equal(owner.animations.length, 0);
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
  assert.equal(viewer.$('phase-name').textContent, 'Menstrual 😭');
  viewer.$('enable-push').click();
  await until(() => viewer.$('enable-push').textContent.includes('enabled'));
  owner.$('settings-dialog').close(); owner.$('next-phase').click();
  await until(() => owner.$('phase-name').textContent === 'Follicular 🤗' && !owner.$('next-phase').disabled);
  assert.equal(owner.animations.length, 1);
  assert.equal(owner.animations[0].target.className, 'cycle-art');
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].subscriptions.length, 1);
  viewer.$('refresh').click();
  await until(() => viewer.$('phase-name').textContent === 'Follicular 🤗' && !viewer.$('refresh').disabled);
  owner.$('correct-phase').click(); owner.$('phase-options').querySelector('[data-phase="luteal"]').click();
  await until(() => owner.$('phase-name').textContent === 'Luteal 🤬' && !owner.$('undo').disabled);
  owner.$('undo').click();
  await until(() => owner.$('phase-name').textContent === 'Follicular 🤗' && !owner.$('next-phase').disabled);
  assert.equal(owner.$('undo').disabled, true);
  owner.online(false); owner.w.dispatchEvent(new owner.w.Event('offline'));
  assert.equal(owner.$('next-phase').disabled, true);
  assert.match(owner.$('sync-label').textContent, /offline/);
  owner.online(true); owner.$('refresh').click();
  await until(() => !owner.$('next-phase').disabled);
  const accessKey = JSON.parse(owner.w.localStorage.getItem('khc-access-v1'));
  const recovered = await device(handler, '', accessKey); t.after(() => recovered.dom.window.close());
  await until(() => recovered.$('phase-name').textContent === 'Follicular 🤗');
  assert.equal(recovered.animations.length, 0);
  const reduced = await device(handler, '', accessKey, { reducedMotion: true }); t.after(() => reduced.dom.window.close());
  owner.$('next-phase').click();
  await until(() => owner.$('phase-name').textContent === 'Ovulating 😽' && !owner.$('next-phase').disabled);
  reduced.$('refresh').click();
  await until(() => reduced.$('phase-name').textContent === 'Ovulating 😽' && !reduced.$('refresh').disabled);
  assert.equal(reduced.animations.length, 0);
  owner.$('settings-open').click(); owner.$('disconnect').click();
  await until(() => owner.$('sharing-label').textContent.startsWith('Only you'));
  viewer.$('refresh').click();
  await until(() => !viewer.$('welcome').hidden);
  assert.equal(viewer.w.localStorage.getItem('khc-access-v1'), null);
});

test('restored partner clears a subscription tied to an old VAPID key and can enable a fresh one', async (t) => {
  const handler = createHandler({ store: memoryStore(), env, notify: async () => ({ sent: 1, failed: 0 }) });
  async function api(action, body, token) {
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.value = value; } };
    await handler({ method: 'POST', query: { action }, body, headers: { origin: env.APP_ORIGIN,
      'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res);
    assert.ok(res.code < 400); return res.value;
  }
  const owner = await api('create', { phase: 'menstrual' });
  const invitation = await api('invite', {}, owner.token);
  const viewer = await api('join', { invitation: invitation.invitation });
  await api('subscribe', { subscription: sub }, viewer.token);
  const restored = await device(handler, '', viewer.token, { oldApplicationServerKey: new Uint8Array(65).buffer });
  t.after(() => restored.dom.window.close());
  await until(() => restored.$('toast').textContent.includes('Notification keys changed'));
  assert.equal(restored.$('enable-push').disabled, false);
  restored.$('enable-push').click();
  await until(() => restored.$('enable-push').textContent.includes('enabled'));
});

test('all HTML IDs are unique and all application element references exist', () => {
  const dom = new JSDOM(html);
  const ids = [...dom.window.document.querySelectorAll('[id]')].map((element) => element.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of source.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(id), `Missing #${id}`);
  dom.window.close();
});


test('owner can save an optional schedule, enable reminders and pause without losing durations', async (t) => {
  const handler = createHandler({ store: memoryStore(), env, notify: async () => ({ sent: 1, failed: 0 }) });
  const owner = await device(handler); t.after(() => owner.dom.window.close());
  owner.$('start-owner').click(); owner.$('phase-options').querySelector('[data-phase="menstrual"]').click();
  await until(() => !owner.$('tracker').hidden && !owner.$('next-phase').disabled);
  owner.$('settings-open').click();
  assert.equal(owner.$('automation-settings').hidden, false);
  assert.equal(owner.$('auto-fields').disabled, true);
  owner.$('auto-enabled').click();
  for (const [phase, days] of Object.entries({ menstrual: 5, follicular: 8, ovulatory: 3, luteal: 12 })) owner.$(`auto-${phase}`).value = days;
  owner.$('auto-timezone').value = 'Europe/Copenhagen'; owner.$('auto-reminders').click();
  owner.$('automation-form').dispatchEvent(new owner.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => owner.$('toast').textContent === 'Schedule saved.' && !owner.$('auto-save').disabled);
  assert.match(owner.$('since-label').textContent, /Next/);
  owner.$('owner-enable-push').click();
  await until(() => owner.$('owner-enable-push').textContent.includes('allowed'));
  owner.$('auto-enabled').click();
  owner.$('automation-form').dispatchEvent(new owner.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => owner.$('toast').textContent.includes('paused') && !owner.$('auto-save').disabled);
  assert.equal(owner.$('auto-menstrual').value, '5');
  assert.equal(owner.$('owner-enable-push').hidden, true);
  assert.doesNotMatch(owner.$('since-label').textContent, /Next/);
});


test('partner can send an owner test reminder and inspect results without changing the schedule', async (t) => {
  const store = memoryStore(), deliveries = [], now = () => new Date('2026-10-22T07:00:00Z');
  const notify = async (event) => { deliveries.push(event); return { sent: event.subscriptions.length, failed: 0 }; };
  const service = createService({ store, now, notify });
  const owner = await service.create('menstrual');
  await service.automation(owner.token, { version: 1, enabled: true, reminders: true,
    days: { menstrual: 5, follicular: 8, ovulatory: 3, luteal: 12 }, startDate: '2026-10-22', timeZone: 'Europe/Copenhagen' });
  const viewer = await service.join((await service.invite(owner.token)).invitation);
  await service.subscribe(owner.token, sub);
  const handler = createHandler({ store, env, now, notify });
  const partner = await device(handler, '', viewer.token); t.after(() => partner.dom.window.close());
  await until(() => !partner.$('refresh').disabled);
  partner.$('settings-open').click();
  assert.equal(partner.$('test-reminder').textContent, 'Send her a test reminder');
  const before = await service.state(owner.token);
  partner.$('test-reminder').click();
  await until(() => partner.$('toast').textContent.includes('accepted by the push service') && !partner.$('test-reminder').disabled);
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].type, 'test-reminder');
  assert.deepEqual(deliveries[0].subscriptions, [sub]);
  assert.deepEqual(await service.state(owner.token), before);
  partner.$('notification-diagnostics').open = true;
  await until(() => partner.$('diagnostic-events').textContent.includes('Test: 1 accepted'));
  assert.match(partner.$('diagnostic-status').textContent, /1 tracking device/);
  partner.online(false); partner.w.dispatchEvent(new partner.w.Event('offline'));
  assert.equal(partner.$('test-reminder').disabled, true);
});
