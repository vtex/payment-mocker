'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle, isAllowedBundleFilename } = require('../lib/load-bundle');

function makeBundleDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-template-bundle-'));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

// isAllowedBundleFilename is the contract rule on its own, exported so the
// preview middleware's static-file route can reject a filename before it ever
// touches the disk without restating the rule. Tested directly here, at the
// one place that owns it.
test('isAllowedBundleFilename accepts every name the contract defines', () => {
  assert.equal(isAllowedBundleFilename('index.html'), true);
  assert.equal(isAllowedBundleFilename('style.css'), true);
  assert.equal(isAllowedBundleFilename('i18n-en-US.json'), true);
  assert.equal(isAllowedBundleFilename('asset-logo.png'), true);
});

test('isAllowedBundleFilename rejects names outside the contract', () => {
  // evil.html in particular: served raw by the static route, it would run as
  // a document at the preview server's own origin, outside the sandboxed
  // iframe the wrapped index.html is confined to.
  assert.equal(isAllowedBundleFilename('evil.html'), false);
  assert.equal(isAllowedBundleFilename('notes.txt'), false);
  // Not an `xx-XX` locale tag, so not an i18n file — the same name loadBundle
  // already rejects the whole bundle over.
  assert.equal(isAllowedBundleFilename('i18n-es.json'), false);
  assert.equal(isAllowedBundleFilename('readme.md'), false);
});

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
