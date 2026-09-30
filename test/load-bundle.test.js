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

test('isAllowedBundleFilename rejects an asset- name with a non-image extension', () => {
  // Same reasoning as evil.html above, via the `asset-` prefix instead: the
  // prefix alone used to be enough, so `asset-x.html` passed this gate and
  // was streamed as text/html by the static route, sandbox and CSP-free.
  // CONTRACT.md limits assets to PNG/JPEG/WebP.
  assert.equal(isAllowedBundleFilename('asset-x.html'), false);
  assert.equal(isAllowedBundleFilename('asset-x.svg'), false);
  assert.equal(isAllowedBundleFilename('asset-x'), false);
});

test('isAllowedBundleFilename accepts every image extension the contract allows for assets', () => {
  assert.equal(isAllowedBundleFilename('asset-logo.png'), true);
  assert.equal(isAllowedBundleFilename('asset-logo.jpg'), true);
  assert.equal(isAllowedBundleFilename('asset-logo.jpeg'), true);
  assert.equal(isAllowedBundleFilename('asset-logo.webp'), true);
});

test('isAllowedBundleFilename accepts an upper-case (or mixed-case) image extension', () => {
  // Production (@vtex/payment-templates-core's imageSafety rule) decides an
  // asset's type by its magic bytes, never by the extension in its name, and
  // CONTRACT.md doesn't require lower-case either — a case-sensitive match
  // here made the local preview reject a bundle production would accept.
  assert.equal(isAllowedBundleFilename('asset-logo.PNG'), true);
  assert.equal(isAllowedBundleFilename('asset-logo.JPG'), true);
  assert.equal(isAllowedBundleFilename('asset-logo.WebP'), true);
});

test('isAllowedBundleFilename rejects a name smuggling a subdirectory, even one shaped like an allowed name', () => {
  // The bundle contract (CONTRACT.md) is a flat folder — nothing here is
  // legitimately nested. The preview middleware's static route now passes
  // this function the full relative request path, not just its basename, so
  // this guards the exact bypass a basename-only check would have missed:
  // `old/index.html` reads as the allowed name `index.html` under
  // path.basename, but must be rejected as a whole string.
  assert.equal(isAllowedBundleFilename('old/index.html'), false);
  assert.equal(isAllowedBundleFilename('sub/asset-logo.png'), false);
  assert.equal(isAllowedBundleFilename('asset-sub/logo.png'), false);
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

test('loadBundle rejects index.html being a directory instead of crashing with EISDIR', () => {
  const dir = makeBundleDir({
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  fs.mkdirSync(path.join(dir, 'index.html'));

  assert.throws(() => loadBundle(dir), /expects index\.html to be a regular file/);
});

test('loadBundle rejects style.css being a directory instead of crashing with EISDIR', () => {
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  fs.mkdirSync(path.join(dir, 'style.css'));

  assert.throws(() => loadBundle(dir), /expects style\.css to be a regular file/);
});

test('loadBundle rejects index.html being a symlink, even to a legitimate file outside the bundle', () => {
  // Every other bundle file is rejected as a symlink via dirent.isFile() in
  // the readdirSync loop below; index.html/style.css are read separately
  // (they're required, not optional), so they need the same rejection
  // applied by hand via lstatSync — otherwise these two alone could point
  // anywhere on disk while every other file in the same bundle could not.
  const dir = makeBundleDir({
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  const outsideFile = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-template-outside-'));
  const realIndex = path.join(outsideFile, 'index.html');
  fs.writeFileSync(realIndex, '<p data-i18n="pay.title"></p>');
  fs.symlinkSync(realIndex, path.join(dir, 'index.html'));

  assert.throws(() => loadBundle(dir), /expects index\.html to be a regular file, not a directory or symlink/);
});

test('loadBundle reports a missing index.html with a clear message instead of a raw ENOENT', () => {
  const dir = makeBundleDir({
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });

  assert.throws(() => loadBundle(dir), /is missing required file index\.html/);
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

// Every file loadBundle reads was previously read in full, unconditionally,
// before validate()'s own maxFileSize rule ever got a chance to reject it —
// an oversized file (or a bundle full of them) fully buffered and
// UTF-8-decoded every request, on the preview server's single synchronous
// event loop. These pin the fix: a cheap fs.statSync-based size check runs
// before fs.readFileSync, using the same per-file caps template/CONTRACT.md
// documents.
test('loadBundle rejects an index.html over CONTRACT.md\'s 128 KB limit', () => {
  const dir = makeBundleDir({
    'index.html': 'a'.repeat(128 * 1024 + 1),
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  assert.throws(() => loadBundle(dir), /index\.html at \d+ bytes, over the \d+-byte limit for each HTML file/);
});

test('loadBundle rejects a style.css over CONTRACT.md\'s 128 KB limit', () => {
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p{}'.repeat(50 * 1024),
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  assert.throws(() => loadBundle(dir), /style\.css at \d+ bytes, over the \d+-byte limit for each CSS file/);
});

test('loadBundle rejects an i18n file over CONTRACT.md\'s 64 KB limit', () => {
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":' + JSON.stringify('a'.repeat(64 * 1024)) + '}',
  });
  assert.throws(() => loadBundle(dir), /i18n-pt-BR\.json at \d+ bytes, over the \d+-byte limit for each i18n file/);
});

test('loadBundle rejects an asset over CONTRACT.md\'s 256 KB limit', () => {
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
    'asset-logo.png': Buffer.alloc(256 * 1024 + 1),
  });
  assert.throws(() => loadBundle(dir), /asset-logo\.png at \d+ bytes, over the \d+-byte limit for each asset/);
});

test('loadBundle accepts a file exactly at its byte cap', () => {
  const dir = makeBundleDir({
    'index.html': 'a'.repeat(128 * 1024),
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  assert.doesNotThrow(() => loadBundle(dir));
});

// The tests above only check the thrown message — they'd still pass even if
// the size check ran AFTER fs.readFileSync (e.g. checked against the
// returned buffer's length instead of a prior fs.statSync), which is not
// what "rejected before being read into memory" actually claims. Proving the
// order without a mocking library (node:test's own `mock` needs a newer
// Node than this repo's README commits to; nothing else in this suite pulls
// one in either): chmod the oversized file unreadable but still statable.
// If the size check ever moved after the read, fs.readFileSync would throw
// EACCES instead of ever reaching the size-limit message below.
const canTestUnreadableFile = typeof process.getuid === 'function' && process.getuid() !== 0;

test(
  'loadBundle rejects an oversized asset via fs.statSync, proven by never calling fs.readFileSync on it',
  { skip: !canTestUnreadableFile && 'requires a non-root POSIX user to make chmod 0o000 actually deny reads' },
  () => {
    const dir = makeBundleDir({
      'index.html': '<p data-i18n="pay.title"></p>',
      'style.css': 'p { color: red; }',
      'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
    });
    const assetPath = path.join(dir, 'asset-huge.png');
    fs.writeFileSync(assetPath, Buffer.alloc(256 * 1024 + 1));
    fs.chmodSync(assetPath, 0o000);
    try {
      assert.throws(() => loadBundle(dir), /asset-huge\.png at \d+ bytes, over the \d+-byte limit for each asset/);
    } finally {
      fs.chmodSync(assetPath, 0o644);
    }
  }
);
