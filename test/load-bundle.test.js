'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validate } = require('@vtex/payment-templates-core');
const { loadBundle, isAllowedBundleFilename, toValidationBundle } = require('../lib/load-bundle');

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

// Every file loadBundle reads used to be read in full, unconditionally, before
// validate()'s own maxFileSize rule ever got a chance to report it; a later
// fix rejected an oversized file via a cheap fs.statSync first, but by
// throwing — which took the whole preview down over one oversized file (500
// on the wrapped index, a lone `load` finding in place of validate()'s full
// list, an empty locale switcher). These pin the current behavior: stat
// first, read at most the file's cap, keep the REAL size on the entry, and
// let validate() report it.
const KB = 1024;
const HTML_CAP = 128 * KB;
const CSS_CAP = 128 * KB;
const I18N_CAP = 64 * KB;
const ASSET_CAP = 256 * KB;
// A real PNG signature, so the truncated prefix still passes validate()'s
// magic-bytes type check and the only asset finding left is the size one.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function withTrailingBytes(head, totalSize) {
  return Buffer.concat([head, Buffer.alloc(totalSize - head.byteLength)]);
}

function assertTruncatedEntry(entry, realSize, cap) {
  assert.equal(entry.truncated, true, 'an entry over its cap must be marked truncated');
  assert.equal(entry.size, realSize, 'size must be the real, stat\'d size, not the bytes actually read');
  assert.equal(entry.buffer.byteLength, cap, 'at most the cap may be read into the entry');
}

test('loadBundle does not throw for an index.html over CONTRACT.md\'s 128 KB limit — it keeps the real size and reads only the cap', () => {
  const dir = makeBundleDir({
    'index.html': 'a'.repeat(HTML_CAP + 1),
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  const bundle = loadBundle(dir);
  assertTruncatedEntry(bundle.html, HTML_CAP + 1, HTML_CAP);
  assert.equal(bundle.html.text, 'a'.repeat(HTML_CAP), 'the wrapped preview renders the prefix that was read');
});

test('loadBundle does not throw for a style.css over CONTRACT.md\'s 128 KB limit', () => {
  const css = 'p{}'.repeat(50 * KB);
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': css,
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  assertTruncatedEntry(loadBundle(dir).css, Buffer.byteLength(css), CSS_CAP);
});

test('loadBundle does not throw for an i18n file over CONTRACT.md\'s 64 KB limit, and still lists its locale', () => {
  const json = '{"pay":' + JSON.stringify('a'.repeat(I18N_CAP)) + '}';
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': json,
  });
  const bundle = loadBundle(dir);
  assert.deepEqual(Object.keys(bundle.i18n), ['pt-BR']);
  assertTruncatedEntry(bundle.i18n['pt-BR'], Buffer.byteLength(json), I18N_CAP);
});

test('loadBundle does not throw for an asset over CONTRACT.md\'s 256 KB limit', () => {
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
    'asset-logo.png': Buffer.alloc(ASSET_CAP + 1),
  });
  assertTruncatedEntry(loadBundle(dir).assets[0], ASSET_CAP + 1, ASSET_CAP);
});

test('loadBundle reads a file exactly at its byte cap in full, not as truncated', () => {
  const dir = makeBundleDir({
    'index.html': 'a'.repeat(HTML_CAP),
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  const bundle = loadBundle(dir);
  assert.equal(bundle.html.truncated, undefined);
  assert.equal(bundle.html.size, HTML_CAP);
  assert.equal(bundle.html.buffer.byteLength, HTML_CAP);
});

test('toValidationBundle hands validate() the real size of every oversized file, so its own maxFileSize rule reports each one', async () => {
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>' + ' '.repeat(HTML_CAP),
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
    'asset-logo.png': withTrailingBytes(PNG_SIGNATURE, ASSET_CAP + 1),
  });
  const template = toValidationBundle(loadBundle(dir), 'pt-BR');
  // validate() throws a TypeError unless these agree — the reason a truncated
  // entry is padded back out rather than passed through.
  for (const entry of [template.html, template.css, template.i18n['pt-BR'], template.assets[0]]) {
    assert.equal(entry.size, entry.buffer.byteLength, entry.name + ': size must equal buffer.byteLength');
  }
  const result = await validate({ template });
  const sizeFindings = result.errors.filter((finding) => finding.rule === 'maxFileSize');
  assert.deepEqual(
    sizeFindings.map((finding) => finding.ref && finding.ref.file).sort(),
    ['asset-logo.png', 'index.html']
  );
  assert.ok(sizeFindings.some((finding) => /index\.html is \d+ bytes, over the 131072-byte limit/.test(finding.message)));
});

test('toValidationBundle lets validate() report the 1 MB whole-bundle cap, which a per-file check alone never could', async () => {
  // Five assets, each exactly AT its own 256 KB cap (so none is truncated or
  // individually over), add up past CONTRACT.md's 1 MB total — reported by
  // validate() only because every real size now reaches it.
  const files = {
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  };
  for (let i = 0; i < 5; i++) files['asset-' + i + '.png'] = withTrailingBytes(PNG_SIGNATURE, ASSET_CAP);
  const result = await validate({ template: toValidationBundle(loadBundle(makeBundleDir(files)), 'pt-BR') });
  assert.ok(
    result.errors.some((finding) => finding.rule === 'maxFileSize' && /for the whole bundle/.test(finding.message)),
    'validate() must report the whole-bundle total'
  );
});

test('a truncated text file cut mid-UTF-8-sequence gets no spurious encoding finding, and its preview text ends cleanly', async () => {
  // 'é' is two bytes (0xC3 0xA9); a leading 'a' makes the cap fall exactly
  // between them, so a naive prefix would end on a lone 0xC3 — decoded as
  // U+FFFD for the preview, and rejected outright by validate()'s strict
  // UTF-8 decode as a second, misleading finding on top of the size one.
  const html = 'a' + 'é'.repeat(HTML_CAP);
  const dir = makeBundleDir({
    'index.html': html,
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  const bundle = loadBundle(dir);
  assert.equal(bundle.html.buffer[HTML_CAP - 1], 0xc3, 'fixture must actually split a sequence at the cap');
  assert.ok(!bundle.html.text.includes('�'), 'the preview text must not end on a replacement character');
  const result = await validate({ template: toValidationBundle(bundle, 'pt-BR') });
  assert.ok(
    !result.errors.some((finding) => /as UTF-8/.test(finding.message)),
    'no encoding finding may come from the truncation itself'
  );
  assert.ok(result.errors.some((finding) => finding.rule === 'maxFileSize' && finding.ref.file === 'index.html'));
});

test('a truncated i18n file is reported as oversized, plus — accepted, documented — a JSON parse finding for the cut', async () => {
  // Cut-off JSON can't parse; see toValidationFileEntry's docblock for why
  // that second finding is accepted rather than filtered out. Pinned so a
  // change to it is a conscious one.
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":' + JSON.stringify('a'.repeat(I18N_CAP)) + '}}',
  });
  const result = await validate({ template: toValidationBundle(loadBundle(dir), 'pt-BR') });
  const forFile = result.errors.filter((finding) => finding.ref && finding.ref.file === 'i18n-pt-BR.json');
  assert.deepEqual(forFile.map((finding) => finding.rule).sort(), ['i18nKeyConsistency', 'maxFileSize']);
});

test('toValidationBundle refuses to pad a file past the 4 MB ceiling, with its own clear message — loadBundle itself still succeeds', () => {
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
    'asset-huge.png': withTrailingBytes(PNG_SIGNATURE, 4 * 1024 * KB + 1),
  });
  const bundle = loadBundle(dir);
  assertTruncatedEntry(bundle.assets[0], 4 * 1024 * KB + 1, ASSET_CAP);
  assert.throws(() => toValidationBundle(bundle, 'pt-BR'), /asset-huge\.png is \d+ bytes, far over the size limit for each asset and over the \d+-byte ceiling/);
});

// The size assertions above would still pass if loadBundle read the whole
// file and only kept the first `cap` bytes of it — which is not what "an
// oversized file is never read in full" claims. Proving that without a mocking
// library (node:test's own `mock` needs a newer Node than this repo's README
// commits to): swap fs.readFileSync/openSync/readSync/closeSync on the shared
// `fs` module object by hand for the duration of one call, restored in
// `finally`.
// lib/load-bundle.js calls both through that same object, so the swap is what
// it sees.
test('loadBundle never calls fs.readFileSync on an oversized file, and asks fs.readSync for at most its cap from it', () => {
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  const assetPath = path.join(dir, 'asset-huge.png');
  fs.writeFileSync(assetPath, Buffer.alloc(ASSET_CAP * 4));

  const realReadFileSync = fs.readFileSync;
  const realOpenSync = fs.openSync;
  const realReadSync = fs.readSync;
  const realCloseSync = fs.closeSync;
  // Only reads against the oversized file's own descriptor count, and only
  // while it's open: Node's own fs.readFileSync is itself built on
  // fs.readSync for the (in-cap) files read alongside it, and the OS hands
  // the same fd number straight back out to the next file opened once this
  // one is closed.
  let assetFd = null;
  let assetFdOpen = false;
  let bytesRequested = 0;
  fs.readFileSync = function (filePath) {
    if (String(filePath) === assetPath) throw new Error('fs.readFileSync must never be called on the oversized file');
    return realReadFileSync.apply(fs, arguments);
  };
  fs.openSync = function (filePath) {
    const fd = realOpenSync.apply(fs, arguments);
    if (String(filePath) === assetPath) {
      assetFd = fd;
      assetFdOpen = true;
    }
    return fd;
  };
  fs.readSync = function (fd, buffer, offset, length) {
    if (assetFdOpen && fd === assetFd) bytesRequested += length;
    return realReadSync.apply(fs, arguments);
  };
  fs.closeSync = function (fd) {
    if (fd === assetFd) assetFdOpen = false;
    return realCloseSync.apply(fs, arguments);
  };
  let bundle;
  try {
    bundle = loadBundle(dir);
  } finally {
    fs.readFileSync = realReadFileSync;
    fs.openSync = realOpenSync;
    fs.readSync = realReadSync;
    fs.closeSync = realCloseSync;
  }
  assert.equal(assetFdOpen, false, 'the prefix read must close its descriptor');
  assert.notEqual(assetFd, null, 'the oversized file must have been opened for its prefix read');
  assertTruncatedEntry(bundle.assets[0], ASSET_CAP * 4, ASSET_CAP);
  assert.ok(bytesRequested <= ASSET_CAP, 'requested ' + bytesRequested + ' bytes, more than the ' + ASSET_CAP + '-byte cap');
});

// Unreadable-but-statable, the case the old size-before-read proof used
// (chmod 0o000). Reading the prefix means the file IS opened now, so this no
// longer proves ordering (the test above does); it pins the decision instead:
// an oversized file that can't be read at all fails loadBundle with the OS's
// own error — exactly as the same file under its cap would via
// fs.readFileSync — rather than being reported as a merely oversized, empty
// file, which would describe a file nobody could ever actually read.
const canTestUnreadableFile = typeof process.getuid === 'function' && process.getuid() !== 0;

test(
  'loadBundle fails with EACCES on an unreadable oversized asset, the same as it does for an unreadable in-cap one',
  { skip: !canTestUnreadableFile && 'requires a non-root POSIX user to make chmod 0o000 actually deny reads' },
  () => {
    const dir = makeBundleDir({
      'index.html': '<p data-i18n="pay.title"></p>',
      'style.css': 'p { color: red; }',
      'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
    });
    const oversizePath = path.join(dir, 'asset-huge.png');
    fs.writeFileSync(oversizePath, Buffer.alloc(ASSET_CAP + 1));
    fs.chmodSync(oversizePath, 0o000);
    try {
      assert.throws(() => loadBundle(dir), { code: 'EACCES' });
      fs.chmodSync(oversizePath, 0o644);
      fs.writeFileSync(oversizePath, Buffer.alloc(16));
      fs.chmodSync(oversizePath, 0o000);
      assert.throws(() => loadBundle(dir), { code: 'EACCES' });
    } finally {
      fs.chmodSync(oversizePath, 0o644);
    }
  }
);
