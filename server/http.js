import { AppError, createService, hash } from './domain.js';
import { pushReady, createNotifier, vapidConfiguration } from './push.js';
import { productionStore } from './store.js';

const MUTATIONS = new Set(['create', 'invite', 'join', 'phase', 'disconnect', 'subscribe', 'unsubscribe', 'delete']);
export function createHandler({ store, notify, env = process.env, now } = {}) {
  let backingStore = store;
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Vary', 'Origin');
    try {
      const action = req.query?.action;
      if (!['config', 'state', ...MUTATIONS].includes(action)) throw new AppError(404, 'Not found.');
      const method = MUTATIONS.has(action) ? 'POST' : 'GET';
      if (req.method !== method) { res.setHeader('Allow', method); throw new AppError(405, 'Method not allowed.'); }
      if (!env.APP_ORIGIN || new URL(env.APP_ORIGIN).origin !== env.APP_ORIGIN) throw new AppError(503, 'Set APP_ORIGIN in the server configuration.');
      if (req.headers.origin && req.headers.origin !== env.APP_ORIGIN) throw new AppError(403, 'Origin not allowed.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'Cross-site request rejected.');
      if (action === 'config') {
        const push = vapidConfiguration(env);
        return res.status(200).json({
          vapidPublicKey: push.details?.publicKey || null,
          ...(push.error ? { pushConfigurationError: push.error } : {}),
          storageReady: Boolean(store || (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN))
        });
      }
      if (method === 'POST') {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError(415, 'Use application/json.');
        if (Number(req.headers['content-length'] || 0) > 12_288) throw new AppError(413, 'Request too large.');
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new AppError(400, 'Invalid request.');
        if (Buffer.byteLength(JSON.stringify(req.body)) > 12_288) throw new AppError(413, 'Request too large.');
      }
      backingStore ||= productionStore(env);
      // Vercel sets x-real-ip. Never retain or log raw client addresses.
      const address = req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
      if (['create', 'join'].includes(action)
        && await backingStore.limit(hash(`${action}:${address}`), 15, 900)) throw new AppError(429, 'Too many attempts. Try again in 15 minutes.');
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!['create', 'join'].includes(action)) {
        if (!token) throw new AppError(401, 'Restore access or link this device first.');
        if (await backingStore.limit(hash(`access:${token}`), 180, 60)) throw new AppError(429, 'Please wait a moment and try again.');
      }
      const service = createService({ store: backingStore, notify: notify || createNotifier(env), now });
      let result;
      switch (action) {
        case 'create': result = await service.create(req.body.phase); break;
        case 'state': result = { state: await service.state(token) }; break;
        case 'invite': result = await service.invite(token); break;
        case 'join': result = await service.join(req.body.invitation); break;
        case 'phase': result = await service.phase(token, req.body); break;
        case 'disconnect': result = await service.disconnect(token); break;
        case 'subscribe':
          if (!pushReady(env)) throw new AppError(503, vapidConfiguration(env).error || 'Notifications have not been configured yet.');
          result = await service.subscribe(token, req.body.subscription); break;
        case 'unsubscribe': result = await service.unsubscribe(token, req.body.endpoint); break;
        case 'delete': result = await service.remove(token); break;
      }
      return res.status(action === 'create' || action === 'join' ? 201 : 200).json(result);
    } catch (error) {
      const status = error instanceof AppError ? error.status : 503;
      // Never print tokens, push endpoints, request bodies, or cycle records.
      if (!(error instanceof AppError)) console.error('Cycle request failed:', error.name || 'Error');
      return res.status(status).json({ error: error instanceof AppError ? error.message : 'The service is unavailable. Please try again.' });
    }
  };
}
