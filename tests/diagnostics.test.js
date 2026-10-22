import test from 'node:test';
import assert from 'node:assert/strict';
import { createService, parseCredential } from '../server/domain.js';
import { memoryStore } from '../server/memory-store.js';
import { runDailyCheck } from '../server/cron.js';
import { createStore, DIAGNOSTIC_SCRIPT, READ_DIAGNOSTIC_SCRIPT } from '../server/store.js';
import { RETENTION_MS } from '../server/diagnostics.js';

const sub = (name) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: {
  p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: Buffer.alloc(16, 8).toString('base64url') } });
async function fixture() {
  let date = new Date('2026-10-22T07:00:00Z');
  const store = memoryStore(), sent = [], now = () => date;
  const notify = async (event) => { sent.push(event); return { sent: event.subscriptions.length, failed: 0 }; };
  const service = createService({ store, notify, now });
  const owner = await service.create('menstrual');
  const viewer = await service.join((await service.invite(owner.token)).invitation);
  const id = parseCredential(owner.token).id;
  return { store, service, owner, viewer, id, sent, now, notify, advance(days) { date = new Date(+date + days * 86400000); },
    enable() { return service.automation(owner.token, { version: 1, enabled: true, reminders: true,
      days: { menstrual: 2, follicular: 8, ovulatory: 3, luteal: 12 }, startDate: '2026-10-22', timeZone: 'Europe/Copenhagen' }); },
    run() { return runDailyCheck({ store, notify, now }); } };
}
test('linked partner test targets only owner subscriptions and changes neither phase nor reminder claim', async () => {
  const f = await fixture(); await f.enable();
  await f.service.subscribe(f.owner.token, sub('her-phone'));
  await f.service.subscribe(f.viewer.token, sub('his-phone'));
  const before = (await f.store.read(f.id)).raw;
  const result = await f.service.testReminder(f.viewer.token);
  assert.equal(result.notification.sent, 1);
  assert.equal(f.sent[0].type, 'test-reminder');
  assert.deepEqual(f.sent[0].subscriptions, [sub('her-phone')]);
  assert.equal((await f.store.read(f.id)).raw, before);
  const history = await f.service.diagnostics(f.viewer.token);
  assert.equal(history.ownerDevices, 1); assert.equal(history.events[0].status, 'accepted');
  for (const secret of [f.owner.token, f.viewer.token, sub('her-phone').endpoint, sub('his-phone').keys.auth]) {
    assert.equal(JSON.stringify(history).includes(secret), false);
  }
  f.advance(1); await f.run(); // A test does not consume the real day-before reminder.
  assert.equal(f.sent[1].type, 'reminder');
});
test('test works for owner too; missing subscriptions are explicit and no notification is sent', async () => {
  const f = await fixture();
  const missing = await f.service.testReminder(f.viewer.token);
  assert.equal(missing.ownerDevices, 0); assert.equal(f.sent.length, 0);
  assert.equal((await f.service.diagnostics(f.owner.token)).events[0].status, 'no-subscription');
  await f.service.subscribe(f.owner.token, sub('her-phone'));
  assert.equal((await f.service.testReminder(f.owner.token)).notification.sent, 1);
});
test('unlinked and unrelated credentials cannot inspect or trigger another cycle; test sends share a rate limit', async () => {
  const f = await fixture(), other = await f.service.create('luteal');
  assert.equal((await f.service.diagnostics(other.token)).events.length, 0);
  await f.service.testReminder(f.viewer.token);
  await f.service.testReminder(f.owner.token);
  await f.service.testReminder(f.viewer.token);
  await assert.rejects(f.service.testReminder(f.owner.token), { status: 429 });
  await f.service.disconnect(f.owner.token);
  await assert.rejects(f.service.testReminder(f.viewer.token), { status: 401 });
  await assert.rejects(f.service.diagnostics(f.viewer.token), { status: 401 });
  await assert.rejects(f.service.testReminder('invalid'), { status: 401 });
});
test('history distinguishes daily runs, due reminders without subscriptions, disabled reminders, and non-due checks', async () => {
  const f = await fixture(); await f.enable(); await f.run();
  let history = await f.service.diagnostics(f.owner.token);
  assert.equal(history.events[0].kind, 'check-result'); assert.equal(history.events[0].reminderDue, false);
  assert.deepEqual(history.cron.map((event) => event.kind), ['cron-completed', 'cron-started']);
  f.advance(1); await f.run();
  history = await f.service.diagnostics(f.owner.token);
  assert.equal(history.events[0].reminderDue, true); assert.equal(history.events[0].ownerDevices, 0);
  await f.run();
  assert.equal((await f.service.diagnostics(f.owner.token)).events[0].alreadyAttempted, true);
  await f.service.automation(f.owner.token, { version: 2, enabled: true, reminders: false,
    days: { menstrual: 2, follicular: 8, ovulatory: 3, luteal: 12 }, startDate: '2026-10-22', timeZone: 'Europe/Copenhagen' });
  await f.run();
  assert.equal((await f.service.diagnostics(f.owner.token)).events[0].remindersEnabled, false);
});
test('failed push and expired owner endpoint are diagnosed without touching partner devices', async () => {
  const f = await fixture(); await f.service.subscribe(f.owner.token, sub('her-phone'));
  await f.service.subscribe(f.viewer.token, sub('his-phone'));
  const service = createService({ store: f.store, now: f.now, notify: async () => ({ sent: 0, failed: 1,
    reason: 'A notification subscription expired.', expired: [sub('her-phone').endpoint] }) });
  await service.testReminder(f.viewer.token);
  const history = await service.diagnostics(f.owner.token);
  assert.equal(history.events[0].status, 'failed'); assert.equal(history.events[0].failed, 1);
  assert.equal(history.ownerDevices, 0); assert.equal((await service.state(f.viewer.token)).subscribed, true);
});
test('diagnostics expire after seven days, are bounded, and deletion removes cycle history', async () => {
  const f = await fixture(); await f.service.testReminder(f.viewer.token); await f.run();
  f.advance(8);
  assert.equal((await f.service.diagnostics(f.owner.token)).events.length, 0);
  assert.equal((await f.service.diagnostics(f.owner.token)).cron.length, 0);
  for (let i = 0; i < 210; i++) await f.store.appendDiagnostic(f.id, { at: f.now().toISOString(), kind: 'test-started', index: i });
  assert.equal((await f.service.diagnostics(f.owner.token)).events.length, 200);
  await f.service.remove(f.owner.token);
  assert.deepEqual(await f.store.readDiagnostics(f.id, 0), []);
  await f.store.appendDiagnostic(f.id, { at: f.now().toISOString(), kind: 'test-result' });
  assert.deepEqual(await f.store.readDiagnostics(f.id, 0), []);
});
test('diagnostic write failure does not block reminders; scan failures leave a failed run marker', async () => {
  const f = await fixture(); await f.enable(); await f.service.subscribe(f.owner.token, sub('her-phone')); f.advance(1);
  const broken = { ...f.store, appendDiagnostic: async () => { throw new Error('unavailable'); } };
  const warn = console.warn; console.warn = () => {};
  try { assert.equal((await runDailyCheck({ store: broken, now: f.now, notify: f.notify })).reminders, 1); }
  finally { console.warn = warn; }
  const scanFailure = { ...f.store, async *scheduled() { throw new Error('scan failed'); } };
  await assert.rejects(runDailyCheck({ store: scanFailure, now: f.now }), /scan failed/);
  assert.equal((await f.service.diagnostics(f.owner.token)).cron[0].kind, 'cron-errors');
});
test('production history uses TTL, age filtering, bounded atomic writes and cycle-deletion cleanup', async () => {
  const calls = [], id = 'a'.repeat(32), event = { at: '2026-10-22T07:00:00Z', kind: 'test-result' };
  const store = createStore({ eval: async (...args) => { calls.push(args); return args[0] === READ_DIAGNOSTIC_SCRIPT ? [JSON.stringify(event)] : 1; } });
  await store.appendDiagnostic(id, event);
  assert.equal(calls[0][0], DIAGNOSTIC_SCRIPT);
  assert.deepEqual(calls[0][1], [`khc:diagnostics:${id}`, `khc:cycle:${id}`]);
  assert.equal(calls[0][2][2], Date.parse(event.at) - RETENTION_MS);
  assert.equal(calls[0][2][3], 'cycle');
  assert.match(DIAGNOSTIC_SCRIPT, /EXPIRE.*604800/); assert.match(DIAGNOSTIC_SCRIPT, /ZREMRANGEBYRANK.*-201/);
  assert.deepEqual(await store.readDiagnostics(id, 123), [event]);
  assert.deepEqual(calls[1][2], [123]);
  await store.remove(id, 'before'); assert.equal(calls[2][1][2], `khc:diagnostics:${id}`);
});
