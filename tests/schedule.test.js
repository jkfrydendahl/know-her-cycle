import test from 'node:test';
import assert from 'node:assert/strict';
import { createService, parseCredential } from '../server/domain.js';
import { memoryStore } from '../server/memory-store.js';
import { addDays, localDate, validDate, validTimeZone } from '../server/schedule.js';
import { checkCronAuthorization, runDailyCheck } from '../server/cron.js';
import { createStore, CAS_SCRIPT, REMOVE_SCRIPT } from '../server/store.js';

const days = { menstrual: 5, follicular: 8, ovulatory: 3, luteal: 12 };
const subscription = (who) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${who}`,
  keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: Buffer.alloc(16, 8).toString('base64url') } });
async function fixture() {
  let time = new Date('2026-10-19T07:00:00Z');
  const store = memoryStore(), deliveries = [];
  const notify = async (event) => { deliveries.push(event); return { sent: event.subscriptions.length, failed: 0 }; };
  const service = createService({ store, notify, now: () => time });
  const owner = await service.create('menstrual');
  const viewer = await service.join((await service.invite(owner.token)).invitation);
  await service.subscribe(owner.token, subscription('owner')); await service.subscribe(viewer.token, subscription('viewer'));
  return { service, store, owner, viewer, deliveries, id: parseCredential(owner.token).id,
    setDate(date) { time = new Date(`${date}T07:00:00Z`); },
    async save(overrides = {}) { return service.automation(owner.token, { version: (await service.state(owner.token)).version,
      enabled: true, reminders: true, days, timeZone: 'Europe/Copenhagen', startDate: '2026-10-19', ...overrides }); },
    check() { return runDailyCheck({ store, notify, now: () => time }); } };
}
test('calendar dates handle leap years, Copenhagen midnight and daylight saving changes', () => {
  assert.equal(addDays('2028-02-28', 2), '2028-03-01');
  assert.equal(addDays('2026-03-28', 2), '2026-03-30');
  assert.equal(addDays('2026-10-24', 2), '2026-10-26');
  assert.equal(localDate(new Date('2026-03-28T23:30:00Z'), 'Europe/Copenhagen'), '2026-03-29');
  assert.equal(localDate(new Date('2026-10-24T22:30:00Z'), 'Europe/Copenhagen'), '2026-10-25');
  for (const value of ['2026-02-29', '2026-13-01', '2026-10-19T00:00:00Z']) assert.equal(validDate(value), false);
  assert.equal(validTimeZone('not/a-zone'), false);
});
test('schedules are opt-in, owner-only and reject invalid inputs or stale saves', async () => {
  const f = await fixture();
  assert.equal((await f.service.state(f.owner.token)).automation, null);
  assert.equal((await f.check()).checked, 0);
  for (const input of [{ days: { ...days, luteal: 0 } }, { days: { ...days, follicular: 1.5 } },
    { startDate: '2026-10-20' }, { startDate: '2026-02-30' }, { timeZone: 'wrong' }]) {
    await assert.rejects(f.save(input), { status: 400 });
  }
  await assert.rejects(f.service.automation(f.viewer.token, { version: 1, enabled: false }), { status: 403 });
  await f.save(); await assert.rejects(f.save({ version: 1 }), { status: 409 });
  const viewer = await f.service.state(f.viewer.token);
  assert.equal('days' in viewer.automation, false); assert.equal('reminders' in viewer.automation, false);
});
test('owner gets one day-before reminder, partner gets the transition, repeated concurrent checks do not duplicate', async () => {
  const f = await fixture(); await f.save();
  assert.equal((await f.service.state(f.owner.token)).automation.nextDate, '2026-10-24');
  f.setDate('2026-10-22'); assert.equal((await f.check()).reminders, 0);
  f.setDate('2026-10-23');
  const checks = await Promise.all([f.check(), f.check(), f.check()]);
  assert.equal(checks.reduce((n, x) => n + x.reminders, 0), 1);
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].type, 'reminder');
  assert.deepEqual(f.deliveries[0].subscriptions, [subscription('owner')]);
  f.setDate('2026-10-24'); assert.equal((await f.check()).advanced, 1); await f.check();
  assert.equal(f.deliveries.length, 2); assert.deepEqual(f.deliveries[1].subscriptions, [subscription('viewer')]);
  const state = await f.service.state(f.owner.token);
  assert.equal(state.phase, 'follicular'); assert.equal(state.estimated, true);
  assert.equal(state.since, '2026-10-24'); assert.equal(state.automation.nextDate, '2026-11-01');
});
test('manual correction and undo restart from today while retaining saved durations', async () => {
  const f = await fixture(); await f.save(); f.setDate('2026-10-21');
  const change = await f.service.phase(f.owner.token, { phase: 'follicular', version: 2 });
  assert.equal(change.state.automation.nextDate, '2026-10-29'); assert.equal(change.state.estimated, false);
  assert.deepEqual(change.state.automation.days, days);
  f.setDate('2026-10-22');
  const undo = await f.service.phase(f.owner.token, { undo: true, version: 3 });
  assert.equal(undo.state.automation.startDate, '2026-10-22'); assert.equal(undo.state.automation.nextDate, '2026-10-27');
  f.setDate('2026-10-24'); assert.equal((await f.check()).advanced, 0);
});
test('missed runs catch up multiple cycles with one current-status notification and no stale reminders', async () => {
  const f = await fixture(); await f.save(); f.setDate('2026-12-23');
  const result = await f.check();
  assert.equal(result.advanced, 1); assert.equal(result.reminders, 0);
  const state = await f.service.state(f.owner.token);
  assert.equal(state.phase, 'follicular'); assert.equal(state.since, '2026-12-19');
  assert.equal(f.deliveries.length, 1);
  await f.save({ startDate: state.automation.startDate });
  assert.equal((await f.service.state(f.owner.token)).estimated, true);
});
test('saving a past start date catches up immediately and marks it estimated', async () => {
  const f = await fixture(); const result = await f.save({ startDate: '2026-10-01' });
  assert.equal(result.state.phase, 'luteal'); assert.equal(result.state.since, '2026-10-17');
  assert.equal(result.state.estimated, true); assert.equal(f.deliveries.length, 1);
});
test('pause and deletion remove daily processing; subscriptions remain role-specific', async () => {
  const f = await fixture(); await f.save();
  await f.service.unsubscribe(f.owner.token, subscription('owner').endpoint);
  assert.equal((await f.service.state(f.viewer.token)).subscribed, true);
  await f.save({ enabled: false }); assert.equal((await f.check()).checked, 0);
  await f.save(); await f.service.remove(f.owner.token); assert.equal((await f.check()).checked, 0);
});
test('failed reminders are recorded once while phase advancement continues', async () => {
  const f = await fixture(); await f.save(); f.setDate('2026-10-23');
  let calls = 0;
  const service = createService({ store: f.store, now: () => new Date('2026-10-23T07:00:00Z'),
    notify: async () => { calls++; throw new Error('offline'); } });
  assert.equal((await service.processScheduled(f.id)).failed, 1);
  await service.processScheduled(f.id); assert.equal(calls, 1);
  f.setDate('2026-10-24'); assert.equal((await f.check()).advanced, 1);
});
test('cron requires a strong exact Bearer secret', () => {
  const secret = 'c'.repeat(32);
  assert.equal(checkCronAuthorization(`Bearer ${secret}`, secret), true);
  for (const value of [undefined, secret, 'Bearer wrong', `Bearer ${secret} `]) assert.equal(checkCronAuthorization(value, secret), false);
  assert.equal(checkCronAuthorization('Bearer short', 'short'), false);
});
test('production store updates the scheduled index atomically and reads all scan pages', async () => {
  const calls = [], id = 'a'.repeat(32), other = 'b'.repeat(32);
  const store = createStore({ eval: async (...args) => { calls.push(args); return 1; },
    sscan: async (key, cursor) => { assert.equal(key, 'khc:scheduled'); return cursor === 0 ? ['3', [id, 'invalid']] : ['0', [other]]; } });
  await store.compare(id, 'before', { automation: { enabled: true } });
  assert.equal(calls[0][0], CAS_SCRIPT); assert.deepEqual(calls[0][1], [`khc:cycle:${id}`, 'khc:scheduled']);
  assert.deepEqual(calls[0][2], ['before', '{"automation":{"enabled":true}}', id]);
  await store.remove(id, 'before'); assert.equal(calls[1][0], REMOVE_SCRIPT);
  assert.deepEqual(calls[1][2], ['before', id]);
  const scanned = []; for await (const value of store.scheduled()) scanned.push(value);
  assert.deepEqual(scanned, [id, other]);
});
