'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validate } = require('@vtex/payment-templates-core');
const { loadBundle, isAllowedBundleFilename, toValidationBundle, toValidationFileEntry } = require('../lib/load-bundle');

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
// list, an empty locale switcher). After that, every oversized file was read
// only up to its cap and padded back out for validate(), which made validate()
// report a class, an asset or a closing tag used only after the cut in a text
// file as missing. These pin the current behavior: stat first and keep the
// REAL size on the entry; read a text file (index.html, style.css, i18n)
// whole up to 4 MB, and an image over its cap only up to that cap; and let
// validate() report it.
const KB = 1024;
const HTML_CAP = 128 * KB;
const CSS_CAP = 128 * KB;
const I18N_CAP = 64 * KB;
const ASSET_CAP = 256 * KB;
const VALIDATION_CEILING = 4 * 1024 * KB;
// A real PNG signature, so the truncated prefix still passes validate()'s
// magic-bytes type check and the only asset finding left is the size one.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REFERENCE_DIR = path.join(__dirname, '..', 'template', 'reference');

function withTrailingBytes(head, totalSize) {
  return Buffer.concat([head, Buffer.alloc(totalSize - head.byteLength)]);
}

function assertTruncatedEntry(entry, realSize, cap) {
  assert.equal(entry.truncated, true, 'an entry read only up to its cap must be marked truncated');
  assert.equal(entry.size, realSize, 'size must be the real, stat\'d size, not the bytes actually read');
  assert.equal(entry.buffer.byteLength, cap, 'at most the cap may be read into the entry');
}

function assertWholeEntry(entry, contents) {
  const bytes = Buffer.from(contents);
  assert.equal(entry.truncated, undefined, 'a text file within 4 MB must not be truncated');
  assert.equal(entry.size, bytes.byteLength, 'size must be the real size');
  assert.ok(Buffer.from(entry.buffer).equals(bytes), 'the whole file must have been read');
  assert.equal(entry.text, bytes.toString('utf8'), 'the preview must get the whole file too');
}

/**
 * A copy of the real reference bundle in a temp directory, with `index.html`
 * replaced by `makeHtml(original)`. Only contract-shaped names are copied: a
 * scratch file another test file writes into the real template/reference
 * meanwhile (test/preview-middleware.test.js's notes.txt) would otherwise make
 * loadBundle reject the copy.
 */
function referenceBundleWithHtml(makeHtml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-template-reference-'));
  for (const name of fs.readdirSync(REFERENCE_DIR)) {
    if (isAllowedBundleFilename(name)) fs.copyFileSync(path.join(REFERENCE_DIR, name), path.join(dir, name));
  }
  const original = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.html'), makeHtml(original));
  return dir;
}

test('loadBundle reads an index.html over CONTRACT.md\'s 128 KB limit whole (it is under 4 MB), keeping its real size', () => {
  const html = '<p data-i18n="pay.title"></p>' + 'a'.repeat(HTML_CAP);
  const dir = makeBundleDir({
    'index.html': html,
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  assertWholeEntry(loadBundle(dir).html, html);
});

test('loadBundle reads a style.css over CONTRACT.md\'s 128 KB limit whole', () => {
  const css = 'p{}'.repeat(50 * KB);
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': css,
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  assertWholeEntry(loadBundle(dir).css, css);
});

test('loadBundle reads an i18n file over CONTRACT.md\'s 64 KB limit whole, and still lists its locale', () => {
  const json = '{"pay":' + JSON.stringify('a'.repeat(I18N_CAP)) + '}';
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': json,
  });
  const bundle = loadBundle(dir);
  assert.deepEqual(Object.keys(bundle.i18n), ['pt-BR']);
  assertWholeEntry(bundle.i18n['pt-BR'], json);
});

test('loadBundle reads an asset over CONTRACT.md\'s 256 KB limit only up to that cap — images are never read whole past it', () => {
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
    'asset-logo.png': withTrailingBytes(PNG_SIGNATURE, ASSET_CAP),
  });
  const bundle = loadBundle(dir);
  assert.equal(bundle.html.truncated, undefined);
  assert.equal(bundle.html.size, HTML_CAP);
  assert.equal(bundle.html.buffer.byteLength, HTML_CAP);
  assert.equal(bundle.assets[0].truncated, undefined);
  assert.equal(bundle.assets[0].buffer.byteLength, ASSET_CAP);
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
  // asset is padded back out rather than passed through.
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

test('toValidationBundle hands validate() the REAL size of a truncated asset, which alone pushes the bundle past the 1 MB total', async () => {
  // One ~1.1 MB asset, of which loadBundle reads only its 256 KB cap, beside
  // a few hundred bytes of everything else. The total is over 1 MB only if
  // that asset counts with its real size: counted with the 256 KB actually
  // read, the bundle would total about 256 KB and the whole-bundle finding
  // would not appear. (Checked by hand-editing toValidationFileEntry to hand
  // validate() the prefix size instead: this test then fails.)
  const files = {
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
    'asset-big.png': withTrailingBytes(PNG_SIGNATURE, 1100 * KB),
  };
  const bundle = loadBundle(makeBundleDir(files));
  assertTruncatedEntry(bundle.assets[0], 1100 * KB, ASSET_CAP);
  const realTotal = Object.values(files).reduce((sum, contents) => sum + Buffer.byteLength(contents), 0);
  const result = await validate({ template: toValidationBundle(bundle, 'pt-BR') });
  assert.ok(
    result.errors.some(
      (finding) =>
        finding.rule === 'maxFileSize' &&
        finding.message === `The submission totals ${realTotal} bytes, over the 1048576-byte limit for the whole bundle.`
    ),
    'validate() must report the whole-bundle total of the REAL sizes: ' + JSON.stringify(result.errors)
  );
});

// The reproduction behind reading text files whole: a ~144 KB index.html (the
// reference bundle's own markup behind a 140 KB comment), so its <img
// src="asset-logo.png"> and every class style.css styles appear only AFTER the
// 128 KB mark. Read up to the cap and padded with spaces, validate() saw an
// unclosed comment and nothing after it: one false htmlSafety finding, one
// assetUsage "never referenced ... Remove it from the bundle", and a
// cssClassUsage "defined ... but never used ... Remove the unused selector"
// for each class — advice that, followed, deletes what the template uses.
test('an index.html over 128 KB whose classes and <img src> appear only after the 128 KB mark gets maxFileSize only — no false usage findings', async () => {
  const dir = referenceBundleWithHtml((original) => '<!--' + 'x'.repeat(140 * KB) + '-->\n' + original);
  const html = fs.readFileSync(path.join(dir, 'index.html'));
  assert.ok(html.indexOf('asset-logo.png') > HTML_CAP, 'fixture: the asset reference must lie past the cap');
  assert.ok(html.indexOf('class=') > HTML_CAP, 'fixture: every class attribute must lie past the cap');

  const result = await validate({ template: toValidationBundle(loadBundle(dir), 'pt-BR') });
  assert.deepEqual(
    result.errors.map((finding) => finding.rule + ': ' + finding.message),
    ['maxFileSize: index.html is ' + html.byteLength + ' bytes, over the 131072-byte limit for each HTML file.']
  );
});

test('an i18n file and a style.css between their cap and 4 MB are validated whole: valid JSON and CSS get maxFileSize only, no parse finding', async () => {
  // Content past each cap that the old read-to-the-cap-and-pad approach cut
  // off: the i18n file's real JSON starts after 70 KB of leading whitespace
  // (its prefix was all blanks: "Could not parse ... as JSON", and its keys
  // were never compared), and style.css's only rule for `.late`, used by
  // index.html, comes after 130 KB of other rules (cut mid-rule: "Could not
  // parse style.css as CSS", or the class reported unused).
  const i18n = ' '.repeat(70 * KB) + '{"pay":{"title":"Pague"}}';
  const css = 'p { color: red; }\n'.repeat(Math.ceil((130 * KB) / 18)) + '.late { color: blue; }\n';
  const dir = makeBundleDir({
    'index.html': '<p class="late" data-i18n="pay.title"></p>',
    'style.css': css,
    'i18n-pt-BR.json': i18n,
    'i18n-en-US.json': '{"pay":{"title":"Pay"}}',
  });
  const bundle = loadBundle(dir);
  assertWholeEntry(bundle.i18n['pt-BR'], i18n);
  assertWholeEntry(bundle.css, css);
  const result = await validate({ template: toValidationBundle(bundle, 'pt-BR') });
  assert.deepEqual(
    result.errors.map((finding) => finding.rule + ' ' + (finding.ref && finding.ref.file)).sort(),
    ['maxFileSize i18n-pt-BR.json', 'maxFileSize style.css']
  );
});

test('toValidationBundle refuses an asset past the 4 MB ceiling, with its own clear message — loadBundle itself still succeeds', () => {
  const dir = makeBundleDir({
    'index.html': '<p data-i18n="pay.title"></p>',
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
    'asset-huge.png': withTrailingBytes(PNG_SIGNATURE, VALIDATION_CEILING + 1),
  });
  const bundle = loadBundle(dir);
  assertTruncatedEntry(bundle.assets[0], VALIDATION_CEILING + 1, ASSET_CAP);
  assert.throws(() => toValidationBundle(bundle, 'pt-BR'), /asset-huge\.png is \d+ bytes, far over the size limit for each asset and over the \d+-byte ceiling/);
});

test('a text file just over 4 MB is read only up to its cap and refused by toValidationBundle with one clear message naming it and its size', () => {
  // 'é' is two bytes (0xC3 0xA9); a leading 'a' makes the cap fall exactly
  // between them, so a naive prefix would end on a lone 0xC3 — decoded as
  // U+FFFD at the end of what the wrapped preview inlines.
  const html = 'a' + 'é'.repeat(VALIDATION_CEILING / 2);
  const dir = makeBundleDir({
    'index.html': html,
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  const bundle = loadBundle(dir);
  const realSize = Buffer.byteLength(html);
  assert.ok(realSize > VALIDATION_CEILING);
  assertTruncatedEntry(bundle.html, realSize, HTML_CAP);
  assert.equal(bundle.html.buffer[HTML_CAP - 1], 0xc3, 'fixture must actually split a sequence at the cap');
  assert.ok(!bundle.html.text.includes('�'), 'the preview text must not end on a replacement character');
  assert.throws(
    () => toValidationBundle(bundle, 'pt-BR'),
    { message: new RegExp('^index\\.html is ' + realSize + ' bytes, far over the size limit for each HTML file and over the 4194304-byte ceiling') }
  );
});

test('toValidationFileEntry refuses to pad a partly-read text entry instead of recreating the false findings', () => {
  const partial = { name: 'index.html', size: HTML_CAP + 1, buffer: new Uint8Array(HTML_CAP), truncated: true };
  assert.throws(() => toValidationFileEntry(partial, true, 'HTML file'), /only partly read; a text file must reach the validator whole/);
});

/**
 * Runs `fn` with fs.readFileSync/openSync/readSync/closeSync swapped on the
 * shared `fs` module object, counting, for each path in `trackedPaths`, the
 * fs.readFileSync calls on it and the bytes fs.readSync was asked for from
 * its descriptor. Without a mocking library: node:test's own `mock` needs a
 * newer Node than this repo's README commits to. lib/load-bundle.js calls
 * all four through that same object, so the swap is what it sees; restored in
 * `finally`.
 *
 * Only reads against a tracked file's own descriptor count, and only while
 * it's open: depending on the Node version, fs.readFileSync is itself built
 * on fs.openSync/fs.readSync for the (in-cap) files read alongside, and the
 * OS hands the same fd number straight back out to the next file opened once
 * one is closed. For the same reason `opened`/`bytesRequested` are only
 * meaningful for a tracked file that readFileSync never touched.
 */
function traceReads(trackedPaths, fn) {
  const stats = new Map(trackedPaths.map((p) => [p, { readFileSync: 0, opened: 0, bytesRequested: 0 }]));
  const openFds = new Map();
  const realReadFileSync = fs.readFileSync;
  const realOpenSync = fs.openSync;
  const realReadSync = fs.readSync;
  const realCloseSync = fs.closeSync;
  fs.readFileSync = function (filePath) {
    const tracked = stats.get(String(filePath));
    if (tracked) tracked.readFileSync += 1;
    return realReadFileSync.apply(fs, arguments);
  };
  fs.openSync = function (filePath) {
    const fd = realOpenSync.apply(fs, arguments);
    const tracked = stats.get(String(filePath));
    if (tracked) {
      tracked.opened += 1;
      openFds.set(fd, tracked);
    }
    return fd;
  };
  fs.readSync = function (fd, buffer, offset, length) {
    const tracked = openFds.get(fd);
    if (tracked) tracked.bytesRequested += length;
    return realReadSync.apply(fs, arguments);
  };
  fs.closeSync = function (fd) {
    openFds.delete(fd);
    return realCloseSync.apply(fs, arguments);
  };
  let value;
  try {
    value = fn();
  } finally {
    fs.readFileSync = realReadFileSync;
    fs.openSync = realOpenSync;
    fs.readSync = realReadSync;
    fs.closeSync = realCloseSync;
  }
  assert.equal(openFds.size, 0, 'every prefix read must close its descriptor');
  return { value, stats };
}

// The size assertions above would still pass if loadBundle read the whole
// file and only kept the first `cap` bytes of it — which is not what "a file
// past what loadBundle reads whole is never read in full" claims. This proves
// it from the fs calls themselves, for both kinds of file that are still read
// only up to their cap: an image over its cap, and a text file past 4 MB. And
// the other side: a text file between its cap and 4 MB IS read whole.
test('loadBundle never fully reads an oversized asset or a text file past 4 MB, and does fully read a text file between its cap and 4 MB', () => {
  const dir = makeBundleDir({
    'style.css': 'p { color: red; }',
    'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
  });
  const assetPath = path.join(dir, 'asset-huge.png');
  const htmlPath = path.join(dir, 'index.html');
  const i18nPath = path.join(dir, 'i18n-en-US.json');
  fs.writeFileSync(assetPath, Buffer.alloc(ASSET_CAP * 4));
  fs.writeFileSync(htmlPath, ' '.repeat(VALIDATION_CEILING + 1));
  const i18n = '{"pay":{"title":' + JSON.stringify('a'.repeat(I18N_CAP)) + '}}';
  fs.writeFileSync(i18nPath, i18n);

  const { value: bundle, stats } = traceReads([assetPath, htmlPath, i18nPath], () => loadBundle(dir));

  for (const [filePath, cap] of [[assetPath, ASSET_CAP], [htmlPath, HTML_CAP]]) {
    const name = path.basename(filePath);
    const tracked = stats.get(filePath);
    assert.equal(tracked.readFileSync, 0, name + ': fs.readFileSync must never be called on it');
    assert.equal(tracked.opened, 1, name + ': must have been opened once, for its prefix read');
    assert.ok(tracked.bytesRequested <= cap, name + ': requested ' + tracked.bytesRequested + ' bytes, more than its ' + cap + '-byte cap');
  }
  assertTruncatedEntry(bundle.assets[0], ASSET_CAP * 4, ASSET_CAP);
  assertTruncatedEntry(bundle.html, VALIDATION_CEILING + 1, HTML_CAP);

  assert.equal(stats.get(i18nPath).readFileSync, 1, 'an over-cap i18n file within 4 MB must be read whole');
  assertWholeEntry(bundle.i18n['en-US'], i18n);
});

// Unreadable-but-statable (chmod 0o000). This used to be the proof that the
// size check ran before any read; reading a prefix (or now, for a text file
// within 4 MB, the whole file) means the file IS opened, so this no longer
// proves ordering (the fs-call trace above does); it pins the decision
// instead: an oversized file that can't be read at all fails loadBundle with
// the OS's own error — exactly as the same file under its cap would via
// fs.readFileSync — rather than being reported as a merely oversized, empty
// file, which would describe a file nobody could ever actually read. Checked
// for both read paths: an asset (prefix read) and an i18n file (whole read).
const canTestUnreadableFile = typeof process.getuid === 'function' && process.getuid() !== 0;

test(
  'loadBundle fails with EACCES on an unreadable oversized asset or i18n file, the same as it does for an unreadable in-cap one',
  { skip: !canTestUnreadableFile && 'requires a non-root POSIX user to make chmod 0o000 actually deny reads' },
  () => {
    for (const [name, cap] of [['asset-huge.png', ASSET_CAP], ['i18n-en-US.json', I18N_CAP]]) {
      const dir = makeBundleDir({
        'index.html': '<p data-i18n="pay.title"></p>',
        'style.css': 'p { color: red; }',
        'i18n-pt-BR.json': '{"pay":{"title":"Pague"}}',
      });
      const oversizePath = path.join(dir, name);
      fs.writeFileSync(oversizePath, Buffer.alloc(cap + 1, 0x20));
      fs.chmodSync(oversizePath, 0o000);
      try {
        assert.throws(() => loadBundle(dir), { code: 'EACCES' }, name + ' over its cap');
        fs.chmodSync(oversizePath, 0o644);
        fs.writeFileSync(oversizePath, Buffer.alloc(16, 0x20));
        fs.chmodSync(oversizePath, 0o000);
        assert.throws(() => loadBundle(dir), { code: 'EACCES' }, name + ' within its cap');
      } finally {
        fs.chmodSync(oversizePath, 0o644);
      }
    }
  }
);
