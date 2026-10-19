import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { createHandler } from '../server/http.js';
import { memoryStore } from '../server/memory-store.js';

const port = Number(process.env.PORT || 3000);
const env = { ...process.env, APP_ORIGIN: `http://localhost:${port}` };
const persistent = Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
const handler = createHandler({ env, ...(persistent ? {} : { store: memoryStore() }) });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const root = resolve('public');
createServer(async (req, res) => {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => res.end(JSON.stringify(data));
  try {
    const url = new URL(req.url, env.APP_ORIGIN);
    if (url.pathname.startsWith('/api/')) {
      req.query = { action: url.pathname.slice(5) };
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 12_288) return res.status(413).json({ error: 'Request too large.' });
      }
      if (body) { try { req.body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON.' }); } }
      return handler(req, res);
    }
    const path = resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!path.startsWith(`${root}/`)) return res.status(404).end();
    const file = await readFile(path);
    res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(file);
  } catch { res.status(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => {
  console.log(`Know Her Cycle: ${env.APP_ORIGIN}`);
  console.log(persistent ? 'Using configured Upstash storage.' : 'Development storage is in memory; it resets on restart. Push is disabled unless VAPID is configured.');
});
