import { readdir, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

async function syntax(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await syntax(path);
    else if (/\.(js|mjs)$/.test(path)) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    }
  }
}
for (const directory of ['api', 'server', 'public', 'scripts', 'tests']) await syntax(directory);
const manifest = JSON.parse(await readFile('public/manifest.webmanifest', 'utf8'));
for (const icon of manifest.icons) {
  const bytes = await readFile(`public${icon.src}`);
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes);
}
const sw = await readFile('public/sw.js', 'utf8');
for (const [, path] of sw.matchAll(/'(\/[^']+\.(?:html|css|js|svg|png|webmanifest))'/g)) await access(`public${path}`);
JSON.parse(await readFile('vercel.json', 'utf8'));
console.log('JavaScript syntax, Vercel configuration, service-worker assets and PWA icon dimensions passed.');
