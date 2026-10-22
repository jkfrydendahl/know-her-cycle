import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../server/http.js';
import { memoryStore } from '../server/memory-store.js';

const env = { APP_ORIGIN: 'https://cycle.example' };
function fixture(overrides = {}) {
  const handler = createHandler({ store: memoryStore(), env: { ...env, ...overrides } });
  return async (action, { method = 'POST', body = {}, token, origin = env.APP_ORIGIN, headers = {} } = {}) => {
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
    await handler({ query: { action }, method, body, headers: { origin, 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, socket: { remoteAddress: 'test' } }, response);
    return response;
  };
}
test('API enforces method, origin, JSON, authentication, and no-store', async () => {
  const call = fixture();
  assert.equal((await call('create', { origin: 'https://evil.example', body: { phase: 'menstrual' } })).code, 403);
  assert.equal((await call('create', { method: 'GET' })).code, 405);
  assert.equal((await call('phase')).code, 401);
  assert.equal((await call('create', { headers: { 'content-type': 'text/plain' } })).code, 415);
  assert.equal((await call('create', { body: { phase: 'no' } })).code, 400);
  assert.equal((await call('create', { headers: { 'content-length': '20000' } })).code, 413);
  const created = await call('create', { body: { phase: 'menstrual' } });
  assert.equal(created.code, 201); assert.equal(created.headers['Cache-Control'], 'no-store');
  const state = await call('state', { method: 'GET', token: created.data.token });
  assert.equal(state.code, 200); assert.equal(state.data.state.phase, 'menstrual');
});
test('configuration exposes only public push key and readiness flags', async () => {
  const call = fixture(), result = await call('config', { method: 'GET' });
  assert.deepEqual(result.data, { vapidPublicKey: null, storageReady: true });
});
test('pairing attempts are rate limited and unconfigured push does not accept subscriptions', async () => {
  const call = fixture();
  for (let i = 0; i < 15; i++) assert.notEqual((await call('join', { body: { invitation: 'bad' } })).code, 429);
  assert.equal((await call('join', { body: { invitation: 'bad' } })).code, 429);
  const owner = await call('create', { body: { phase: 'menstrual' } });
  assert.equal((await call('subscribe', { token: owner.data.token, body: { subscription: {} } })).code, 503);
});

test('cron authentication and scheduling configuration are enforced separately from user access', async () => {
  const secret = 's'.repeat(32), call = fixture({ CRON_SECRET: secret });
  assert.equal((await call('cron', { method: 'GET' })).code, 401);
  assert.equal((await call('cron', { method: 'GET', token: 'wrong' })).code, 401);
  assert.equal((await call('cron', { token: secret })).code, 405);
  const result = await call('cron', { method: 'GET', token: secret });
  assert.equal(result.code, 200); assert.equal(result.data.checked, 0);
  const unconfigured = fixture();
  const owner = await unconfigured('create', { body: { phase: 'menstrual' } });
  assert.equal((await unconfigured('automation', { token: owner.data.token, body: { enabled: true } })).code, 503);
  assert.equal((await unconfigured('automation', { token: owner.data.token, body: { enabled: false, version: 1 } })).code, 200);
});

test('reminder diagnostics endpoints require authenticated same-origin access and correct methods', async () => {
  const call = fixture();
  assert.equal((await call('diagnostics', { method: 'GET' })).code, 401);
  assert.equal((await call('test-reminder')).code, 401);
  assert.equal((await call('test-reminder', { method: 'GET' })).code, 405);
  const owner = await call('create', { body: { phase: 'menstrual' } });
  assert.equal((await call('test-reminder', { token: owner.data.token, origin: 'https://evil.example' })).code, 403);
  const result = await call('test-reminder', { token: owner.data.token });
  assert.equal(result.code, 200); assert.equal(result.data.ownerDevices, 0);
  const history = await call('diagnostics', { method: 'GET', token: owner.data.token });
  assert.equal(history.code, 200); assert.equal(history.data.events[0].status, 'no-subscription');
  assert.equal(history.headers['Cache-Control'], 'no-store');
});
