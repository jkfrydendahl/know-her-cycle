import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import webpush from 'web-push';
import { createNotifier, vapidConfiguration, pushReady } from '../server/push.js';
import { createHandler } from '../server/http.js';
import { memoryStore } from '../server/memory-store.js';

const keys = webpush.generateVAPIDKeys();
const env = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_CONTACT: 'mailto:user@example.com' };
const clientKey = createECDH('prime256v1'); clientKey.generateKeys();
const subscription = { endpoint: 'https://web.push.apple.com/private-subscription',
  keys: { p256dh: clientKey.getPublicKey('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') } };
const event = { version: 2, subscriptions: [subscription] };

test('normalizes surrounding whitespace and bare contact email without changing the key pair', () => {
  const config = vapidConfiguration({ VAPID_PUBLIC_KEY: ` ${keys.publicKey}\n`, VAPID_PRIVATE_KEY: ` ${keys.privateKey}\n`, VAPID_CONTACT: ' user@example.com ' });
  assert.deepEqual(config.details, { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:user@example.com' });
  assert.equal(config.error, null);
});
test('rejects mismatched or malformed VAPID keys before sending and never exposes key values', async () => {
  const other = webpush.generateVAPIDKeys(); let sends = 0;
  const bad = { ...env, VAPID_PRIVATE_KEY: other.privateKey };
  const config = vapidConfiguration(bad);
  assert.equal(pushReady(bad), false); assert.match(config.error, /do not match/);
  const result = await createNotifier(bad, async () => { sends++; })(event);
  assert.equal(sends, 0); assert.equal(result.failed, 1); assert.match(result.reason, /do not match/);
  assert.ok(!JSON.stringify(result).includes(other.privateKey));
  assert.match(vapidConfiguration({ ...env, VAPID_PUBLIC_KEY: 'broken' }).error, /invalid/);
});
test('rejects unsupported contact values and partial setup with useful configuration errors', () => {
  for (const contact of ['not an address', 'http://example.com', 'https://localhost', 'mailto:no-address']) {
    assert.match(vapidConfiguration({ ...env, VAPID_CONTACT: contact }).error, /VAPID_CONTACT/);
  }
  assert.match(vapidConfiguration({ VAPID_PUBLIC_KEY: keys.publicKey }).error, /Set VAPID_PUBLIC_KEY/);
  assert.deepEqual(vapidConfiguration({}), { details: null, error: null });
});
test('real web-push encryption and JWT signature use the matching configured key pair', async () => {
  let details;
  const result = await createNotifier(env, async (sub, payload, options) => {
    details = webpush.generateRequestDetails(sub, payload, options);
  })(event);
  assert.equal(result.sent, 1);
  const authorization = details.headers.Authorization;
  const jwt = authorization.match(/t=([^, ]+)/)[1];
  const [header, payload, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).sub, 'mailto:user@example.com');
  const publicBytes = Buffer.from(keys.publicKey, 'base64url');
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: publicBytes.subarray(1, 33).toString('base64url'), y: publicBytes.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
  assert.ok(details.body.length > 0);
});
test('provider authentication rejection reaches the UI safely and logs no subscription or secrets', async () => {
  const logs = [];
  const result = await createNotifier(env, async () => { throw Object.assign(new Error('sensitive error'), {
    statusCode: 403, body: JSON.stringify({ reason: 'BadJwtToken', secret: keys.privateKey }), headers: { authorization: 'secret' }
  }); }, (...args) => logs.push(args))(event);
  assert.equal(result.failed, 1); assert.match(result.reason, /403 BadJwtToken/);
  const serialized = JSON.stringify({ result, logs });
  for (const secret of [keys.privateKey, subscription.endpoint, 'sensitive error', 'authorization']) assert.ok(!serialized.includes(secret));
});
test('unknown provider bodies are suppressed and expired endpoints remain available only for internal cleanup', async () => {
  const result = await createNotifier(env, async () => { throw Object.assign(new Error(), { statusCode: 410, body: JSON.stringify({ reason: keys.privateKey }) }); }, () => {})(event);
  assert.deepEqual(result.expired, [subscription.endpoint]);
  assert.match(result.reason, /off and on/);
  assert.ok(!result.reason.includes(keys.privateKey));
});
test('missing config and network failures retain saved-change-friendly delivery results', async () => {
  const missing = await createNotifier({})(event);
  assert.equal(missing.failed, 1); assert.match(missing.reason, /not configured/);
  const network = await createNotifier(env, async () => { throw new Error('Socket timeout'); }, () => {})(event);
  assert.equal(network.failed, 1); assert.match(network.reason, /could not reach/);
});
test('public config reports key-pair problems without returning private keys', async () => {
  const privateKey = webpush.generateVAPIDKeys().privateKey;
  const handler = createHandler({ env: { ...env, VAPID_PRIVATE_KEY: privateKey, APP_ORIGIN: 'https://cycle.example' }, store: memoryStore() });
  const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await handler({ query: { action: 'config' }, method: 'GET', headers: {} }, response);
  assert.equal(response.code, 200); assert.equal(response.body.vapidPublicKey, null);
  assert.match(response.body.pushConfigurationError, /do not match/);
  assert.ok(!JSON.stringify(response.body).includes(privateKey));
});
