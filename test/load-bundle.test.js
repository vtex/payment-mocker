'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../lib/load-bundle');

function makeBundleDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-template-bundle-'));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

test('loadBundle accepts a bundle with only contract-shaped file names', () => {
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
    'asset-logo.png': 'not-really-a-png',
  });

  const bundle = loadBundle(dir);
  assert.deepEqual(Object.keys(bundle.i18n), ['pt-BR']);
  assert.equal(bundle.assets.length, 1);
  assert.equal(bundle.assets[0].name, 'asset-logo.png');
});

test('loadBundle rejects file names outside the contract instead of silently dropping them', () => {
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
    // Missing the `i18n-` prefix / locale-tag shape, and no `asset-` prefix —
    // both would previously be swallowed by loadBundle and never reach the
    // validator.
    'i18n-pt.json': '{"pay":{"title":"Pague"}}',
    'logo.png': 'not-really-a-png',
  });

  assert.throws(() => loadBundle(dir), /outside the template contract/);
});

test('loadBundle rejects a directory whose name matches the asset pattern instead of crashing with EISDIR', () => {
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  // A subfolder named like an asset entry — before the fix, the loop treated
  // every readdirSync entry as a file and called fs.readFileSync on it,
  // which throws a raw `EISDIR: illegal operation on a directory, read`
  // instead of the friendly contract-violation message.
  fs.mkdirSync(path.join(dir, 'asset-icons'));

  assert.throws(() => loadBundle(dir), /outside the template contract/);
  assert.throws(() => loadBundle(dir), /asset-icons/);
});
