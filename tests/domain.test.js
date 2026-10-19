import test from 'node:test';
import assert from 'node:assert/strict';
import { createService, parseCredential, hash, validateSubscription } from '../server/domain.js';
import { memoryStore } from '../server/memory-store.js';

const pushSubscription = (suffix = 'one') => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`,
  keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: Buffer.alloc(16, 8).toString('base64url') } });
async function fixture() {
  let time = new Date('2026-10-19T12:00:00Z');
  const store = memoryStore(), deliveries = [];
  const service = createService({ store, now: () => time, notify: async (event) => { deliveries.push(event); return { sent: event.subscriptions.length, failed: 0 }; } });
  const owner = await service.create('menstrual');
  return { service, owner, store, deliveries, advance: (ms) => { time = new Date(+time + ms); } };
}
async function partner(f) { return f.service.join((await f.service.invite(f.owner.token)).invitation); }

test('public state never returns credentials, invitation secrets, or push endpoints', async () => {
  const f = await fixture(), viewer = await partner(f);
  await f.service.subscribe(viewer.token, pushSubscription());
  const state = await f.service.state(f.owner.token);
  assert.equal(state.role, 'owner'); assert.equal(state.linked, true);
  for (const key of ['owner', 'viewer', 'invite', 'subscriptions', 'token']) assert.equal(key in state, false);
  const record = (await f.store.read(parseCredential(f.owner.token).id)).value;
  assert.equal(record.owner, hash(f.owner.token)); assert.ok(!JSON.stringify(record).includes(f.owner.token));
});
test('invitation expires, is replaced by a newer invitation, and works once', async () => {
  const f = await fixture();
  const first = await f.service.invite(f.owner.token), second = await f.service.invite(f.owner.token);
  await assert.rejects(f.service.join(first.invitation), { status: 410 });
  f.advance(10 * 60 * 1000);
  await assert.rejects(f.service.join(second.invitation), { status: 410 });
  const third = await f.service.invite(f.owner.token);
  await f.service.join(third.invitation);
  await assert.rejects(f.service.join(third.invitation), { status: 410 });
  await assert.rejects(f.service.invite(f.owner.token), { status: 409 });
});
test('simultaneous invitation redemption has exactly one winner', async () => {
  const f = await fixture(), invite = await f.service.invite(f.owner.token);
  const results = await Promise.allSettled([f.service.join(invite.invitation), f.service.join(invite.invitation)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.status === 410).length, 1);
});
test('viewer cannot change phase, issue invites, or delete the cycle; owner cannot subscribe', async () => {
  const f = await fixture(), viewer = await partner(f);
  for (const operation of [() => f.service.phase(viewer.token, { phase: 'follicular', version: 1 }),
    () => f.service.invite(viewer.token), () => f.service.remove(viewer.token), () => f.service.subscribe(f.owner.token, pushSubscription())]) {
    await assert.rejects(operation(), { status: 403 });
  }
  assert.equal((await f.service.state(f.owner.token)).phase, 'menstrual');
});
test('only the linked partner is notified; double taps and stale writes do not send twice', async () => {
  const f = await fixture(), viewer = await partner(f);
  await f.service.subscribe(viewer.token, pushSubscription());
  const other = await f.service.create('luteal'), otherViewer = await f.service.join((await f.service.invite(other.token)).invitation);
  await f.service.subscribe(otherViewer.token, pushSubscription('other'));
  const writes = await Promise.allSettled([
    f.service.phase(f.owner.token, { phase: 'follicular', version: 1 }),
    f.service.phase(f.owner.token, { phase: 'ovulatory', version: 1 })
  ]);
  assert.equal(writes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(writes.filter((r) => r.status === 'rejected' && r.reason.status === 409).length, 1);
  assert.equal(f.deliveries.length, 1);
  assert.deepEqual(f.deliveries[0].subscriptions, [pushSubscription()]);
  assert.equal((await f.service.state(other.token)).phase, 'luteal');
});
test('manual correction and undo restore the original start date without automatic phase changes', async () => {
  const f = await fixture(), initial = f.owner.state.since;
  f.advance(20 * 86400_000);
  assert.equal((await f.service.state(f.owner.token)).phase, 'menstrual');
  const corrected = await f.service.phase(f.owner.token, { phase: 'luteal', version: 1 });
  assert.notEqual(corrected.state.since, initial);
  const undone = await f.service.phase(f.owner.token, { undo: true, version: 2 });
  assert.equal(undone.state.phase, 'menstrual'); assert.equal(undone.state.since, initial); assert.equal(undone.state.canUndo, false);
  await assert.rejects(f.service.phase(f.owner.token, { undo: true, version: 3 }), { status: 409 });
});
test('disconnect revokes old viewer keys, subscriptions, and any invitation', async () => {
  const f = await fixture(), viewer = await partner(f);
  await f.service.subscribe(viewer.token, pushSubscription());
  await f.service.disconnect(f.owner.token);
  await assert.rejects(f.service.state(viewer.token), { status: 401 });
  await assert.rejects(f.service.subscribe(viewer.token, pushSubscription()), { status: 401 });
  const newViewer = await partner(f);
  assert.notEqual(newViewer.token, viewer.token);
  await f.service.phase(f.owner.token, { phase: 'follicular', version: 1 });
  assert.deepEqual(f.deliveries[0].subscriptions, []);
});
test('partner can leave; deleting a cycle revokes all access', async () => {
  const f = await fixture(), viewer = await partner(f);
  await f.service.disconnect(viewer.token);
  assert.equal((await f.service.state(f.owner.token)).linked, false);
  const second = await partner(f);
  await f.service.remove(f.owner.token);
  await assert.rejects(f.service.state(f.owner.token), { status: 401 });
  await assert.rejects(f.service.state(second.token), { status: 401 });
});
test('push failures do not roll back saved phase; expired subscriptions are removed', async () => {
  const f = await fixture(), viewer = await partner(f);
  await f.service.subscribe(viewer.token, pushSubscription());
  const service = createService({ store: f.store, notify: async () => ({ sent: 0, failed: 1, expired: [pushSubscription().endpoint] }) });
  const result = await service.phase(f.owner.token, { phase: 'follicular', version: 1 });
  assert.equal(result.notification.failed, 1); assert.equal(result.state.phase, 'follicular');
  assert.equal((await service.state(viewer.token)).subscribed, false);
  const throwing = createService({ store: f.store, notify: async () => { throw new Error('Network'); } });
  const next = await throwing.phase(f.owner.token, { phase: 'ovulatory', version: 2 });
  assert.equal(next.state.phase, 'ovulatory'); assert.equal(next.notification.failed, 1);
});
test('push endpoints cannot point at arbitrary hosts or internal addresses', () => {
  for (const endpoint of ['http://fcm.googleapis.com/a', 'https://127.0.0.1/a', 'https://example.com/a',
    'https://fcm.googleapis.com.evil.example/a', 'https://fcm.googleapis.com:444/a', 'https://user:pass@fcm.googleapis.com/a']) {
    assert.throws(() => validateSubscription({ ...pushSubscription(), endpoint }), { status: 400 });
  }
  for (const endpoint of ['https://updates.push.services.mozilla.com/wpush/abc', 'https://web.push.apple.com/abc', 'https://wns2.notify.windows.com/abc']) {
    assert.equal(validateSubscription({ ...pushSubscription(), endpoint }).endpoint, endpoint);
  }
  assert.throws(() => validateSubscription({ ...pushSubscription(), keys: { p256dh: 'bad', auth: 'bad' } }), { status: 400 });
});
test('unsubscribing one device preserves other partner devices', async () => {
  const f = await fixture(), viewer = await partner(f);
  await f.service.subscribe(viewer.token, pushSubscription('phone'));
  await f.service.subscribe(viewer.token, pushSubscription('tablet'));
  await f.service.unsubscribe(viewer.token, pushSubscription('phone').endpoint);
  await f.service.phase(f.owner.token, { phase: 'follicular', version: 1 });
  assert.deepEqual(f.deliveries[0].subscriptions, [pushSubscription('tablet')]);
});

export { pushSubscription };
