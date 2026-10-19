import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PHASES, phaseById } from '../public/phases.js';

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const hash = (value) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const fail = (status, message) => { throw new AppError(status, message); };
export function parseCredential(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'Your access key is not valid.');
  return { id: token.split('.')[0], digest: hash(token) };
}
function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length
    && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function roleOf(record, digest) {
  if (equal(record.owner, digest)) return 'owner';
  if (equal(record.viewer, digest)) return 'viewer';
  fail(401, 'This device is no longer linked.');
}
const requireOwner = (role) => { if (role !== 'owner') fail(403, 'Only the person tracking can change this.'); };
const requireViewer = (role) => { if (role !== 'viewer') fail(403, 'Notifications are available in the partner view.'); };
function publicState(record, role) {
  return { phase: record.phase, since: record.since, updatedAt: record.updatedAt, version: record.version,
    role, linked: Boolean(record.viewer), canUndo: role === 'owner' && Boolean(record.previous),
    subscribed: role === 'viewer' && Object.keys(record.subscriptions).length > 0 };
}
const ALLOWED_PUSH_HOSTS = [
  'fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com',
  'web.push.apple.com', 'push.apple.com', 'notify.windows.com'
];
export function validateSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 2048) fail(400, 'Invalid push subscription.');
  let url;
  try { url = new URL(sub.endpoint); } catch { fail(400, 'Invalid push subscription.'); }
  const hostAllowed = ALLOWED_PUSH_HOSTS.some((host) => url.hostname === host
    || (['push.apple.com', 'notify.windows.com'].includes(host) && url.hostname.endsWith(`.${host}`)));
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !hostAllowed) fail(400, 'Unsupported push service.');
  const key = sub.keys?.p256dh, auth = sub.keys?.auth;
  if (typeof key !== 'string' || !/^[\w-]+={0,2}$/.test(key) || Buffer.from(key, 'base64url').length !== 65
    || Buffer.from(key, 'base64url')[0] !== 4 || typeof auth !== 'string'
    || !/^[\w-]+={0,2}$/.test(auth) || Buffer.from(auth, 'base64url').length !== 16) fail(400, 'Invalid push subscription keys.');
  return { endpoint: url.href, keys: { p256dh: key, auth } };
}

// All read-modify-write operations use a compare-and-swap. A stale request cannot
// overwrite a join, disconnection, subscription change, or newer phase update.
export function createService({ store, notify = async () => ({ sent: 0, failed: 0 }), now = () => new Date() }) {
  async function update(token, mutate) {
    const { id, digest } = parseCredential(token);
    for (let attempt = 0; attempt < 6; attempt++) {
      const snapshot = await store.read(id);
      if (!snapshot) fail(401, 'This cycle is no longer available.');
      const record = structuredClone(snapshot.value);
      const role = roleOf(record, digest);
      const result = mutate(record, role);
      if (await store.compare(id, snapshot.raw, record)) return { record, role, result, id };
    }
    fail(409, 'Something changed. Refresh and try again.');
  }
  async function state(token) {
    const { id, digest } = parseCredential(token);
    const snapshot = await store.read(id);
    if (!snapshot) fail(401, 'This cycle is no longer available.');
    const role = roleOf(snapshot.value, digest);
    return publicState(snapshot.value, role);
  }
  async function delivery(id, changed) {
    try {
      // Recheck membership after saving; never broadcast across cycles.
      const current = (await store.read(id))?.value;
      if (!current || current.version !== changed.version || current.viewer !== changed.viewer) return { sent: 0, failed: 0 };
      const result = await notify({ id, version: changed.version, subscriptions: Object.values(current.subscriptions) });
      if (result.expired?.length) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const snapshot = await store.read(id);
          if (!snapshot || snapshot.value.viewer !== current.viewer) break;
          const clean = structuredClone(snapshot.value);
          for (const endpoint of result.expired) delete clean.subscriptions[hash(endpoint)];
          if (await store.compare(id, snapshot.raw, clean)) break;
        }
      }
      return { sent: result.sent, failed: result.failed };
    } catch { return { sent: 0, failed: 1 }; }
  }
  return {
    state,
    async create(phase) {
      if (!phaseById(phase)) fail(400, 'Choose a current phase.');
      const id = randomBytes(16).toString('hex'), token = `${id}.${random()}`;
      const date = now().toISOString();
      const record = { owner: hash(token), viewer: null, phase, since: date, updatedAt: date,
        version: 1, previous: null, invite: null, subscriptions: {} };
      await store.create(id, record);
      return { token, state: publicState(record, 'owner') };
    },
    async invite(token) {
      const { id } = parseCredential(token), invitation = `${id}.${random()}`;
      const expiresAt = new Date(now().getTime() + 10 * 60 * 1000).toISOString();
      await update(token, (record, role) => {
        requireOwner(role);
        if (record.viewer) fail(409, 'Disconnect your current partner before inviting another.');
        record.invite = { digest: hash(invitation), expiresAt };
      });
      return { invitation, expiresAt };
    },
    async join(invitation) {
      let parsed;
      try { parsed = parseCredential(invitation); } catch { fail(400, 'This invitation is not valid.'); }
      for (let attempt = 0; attempt < 6; attempt++) {
        const snapshot = await store.read(parsed.id);
        const record = snapshot && structuredClone(snapshot.value);
        if (!record || !record.invite || record.viewer || !equal(record.invite.digest, parsed.digest)
          || Date.parse(record.invite.expiresAt) <= now().getTime()) fail(410, 'This invitation expired or has already been used.');
        const token = `${parsed.id}.${random()}`;
        record.viewer = hash(token);
        record.invite = null;
        record.subscriptions = {};
        if (await store.compare(parsed.id, snapshot.raw, record)) return { token, state: publicState(record, 'viewer') };
      }
      fail(409, 'Please try joining again.');
    },
    async phase(token, { phase, version, undo = false }) {
      if (!Number.isSafeInteger(version) || version < 1) fail(400, 'Refresh the current phase first.');
      if (typeof undo !== 'boolean' || (!undo && !phaseById(phase))) fail(400, 'Choose a valid phase.');
      const changed = await update(token, (record, role) => {
        requireOwner(role);
        if (record.version !== version) fail(409, 'The phase changed on another device. Refresh and try again.');
        if (undo) {
          if (!record.previous) fail(409, 'There is no change to undo.');
          record.phase = record.previous.phase;
          record.since = record.previous.since;
          record.previous = null;
        } else {
          if (phase === record.phase) fail(409, 'That is already the current phase.');
          record.previous = { phase: record.phase, since: record.since };
          record.phase = phase;
          record.since = now().toISOString();
        }
        record.updatedAt = now().toISOString();
        record.version++;
      });
      const notification = await delivery(changed.id, changed.record);
      return { state: publicState(changed.record, changed.role), notification };
    },
    async disconnect(token) {
      const changed = await update(token, (record) => {
        record.viewer = null; record.invite = null; record.subscriptions = {};
      });
      return { state: publicState(changed.record, changed.role) };
    },
    async subscribe(token, subscription) {
      const clean = validateSubscription(subscription), key = hash(clean.endpoint);
      const changed = await update(token, (record, role) => {
        requireViewer(role);
        if (!record.subscriptions[key] && Object.keys(record.subscriptions).length >= 5) fail(409, 'Up to five notification devices can be linked.');
        record.subscriptions[key] = clean;
      });
      return { state: publicState(changed.record, changed.role) };
    },
    async unsubscribe(token, endpoint) {
      if (typeof endpoint !== 'string' || endpoint.length > 2048) fail(400, 'Invalid subscription.');
      const changed = await update(token, (record, role) => { requireViewer(role); delete record.subscriptions[hash(endpoint)]; });
      return { state: publicState(changed.record, changed.role) };
    },
    async remove(token) {
      const { id, digest } = parseCredential(token);
      for (let attempt = 0; attempt < 6; attempt++) {
        const snapshot = await store.read(id);
        if (!snapshot) fail(401, 'This cycle is no longer available.');
        requireOwner(roleOf(snapshot.value, digest));
        if (await store.remove(id, snapshot.raw)) return { ok: true };
      }
      fail(409, 'Something changed. Please try again.');
    }
  };
}

export { PHASES };
