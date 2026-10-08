import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const p = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.equal(p.openchamber.apiVersion, 1);
for (const dir of ['service','ui','scripts','tests']) {
  for (const file of await readdir(resolve(root, dir))) {
    if (/\.m?js$/.test(file)) execFileSync(process.execPath, ['--check', resolve(root, dir, file)]);
  }
}
for (const entry of [p.openchamber.contributes.panel.entry, p.openchamber.contributes.statusSection.entry]) {
  const path = resolve(root, entry);
  const html = await readFile(path, 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const asset = resolve(dirname(path), m[1]);
    assert.ok(asset.startsWith(root)); await readFile(asset);
  }
  assert.ok(!/type="module"/.test(html), 'extension pages use classic scripts');
  assert.ok(!/<form\b/i.test(html), 'sandboxed guest login must not depend on allow-forms');
  assert.match(html, /<button type="button" id="login">/);
}
assert.ok(!JSON.stringify(p).includes('ALLOW_UNAUTHENTICATED'));
console.log('Manifest, classic-script assets and JavaScript syntax: OK');
