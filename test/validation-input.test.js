'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validate } = require('@vtex/payment-templates-core');
const {
  buildValidationInput,
  finishValidationResult,
  jpegDimensionsNeedUnreadBytes,
  withExtraFindings,
} = require('../lib/validation-input');

/**
 * lib/validation-input.js resolves `config.icon` against a `templateRoot`
 * (defaulting to the real template/ directory) via realpathSync plus an
 * isPathContained containment check (see resolveIconPath in that module's own
 * docblock). That containment check is the module's whole reason to exist per
 * its docblock ("a `../../` icon path can't read a file outside template/"),
 * yet had no test of its own.
 *
 * buildValidationInput returns `{ input, findings }`: every problem with the
 * icon itself is one of its own `rule: 'icon'` findings (with the icon left
 * out of `input`, so validate() still runs on the rest of the bundle), never
 * a throw — a throw used to become a single `load` finding that hid every
 * other finding in the bundle.
 *
 * Passes a disposable temp directory as `templateRoot` on every call, the
 * same way test/preview-middleware.test.js does, so this never touches the
 * real, git-tracked template/ directory.
 */
let tempContainer;
let templateRoot;

test.before(() => {
  tempContainer = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-mocker-validation-input-'));
  templateRoot = path.join(tempContainer, 'template');
  fs.mkdirSync(templateRoot, { recursive: true });
  // A real file that exists one level above templateRoot but outside it —
  // the escape target a `../` icon path should never be able to reach.
  fs.writeFileSync(path.join(tempContainer, 'secret.png'), 'not-really-a-png');
});

test.after(() => {
  fs.rmSync(tempContainer, { recursive: true, force: true });
});

const STUB_TEMPLATE = { html: { text: '' }, css: { text: '' }, assets: [], i18n: {} };

// A real PNG signature, so validate()'s magic-bytes type check accepts the
// bytes that are read and a size finding is the only icon finding left.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICON_CAP = 50 * 1024;

function withIconFile(name, contents, fn) {
  const iconPath = path.join(templateRoot, name);
  fs.writeFileSync(iconPath, contents);
  try {
    return fn(iconPath);
  } finally {
    fs.rmSync(iconPath, { force: true });
  }
}

/** Asserts `result` carries exactly one icon finding matching `pattern`, and no icon in `input`. */
function assertIconFinding(result, pattern) {
  assert.equal(result.input.icon, undefined, 'a rejected icon must be left out of the validation input');
  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.equal(finding.rule, 'icon');
  assert.equal(finding.severity, 'error');
  assert.match(finding.message, pattern);
}

test('buildValidationInput reports an icon path that escapes template/ via ../ as a finding, never reading it', () => {
  // Still a clear, specific message — and the escaping file is still never
  // read (the finding returns before any stat/read) — but no longer a throw
  // that takes every other finding down with it.
  assertIconFinding(
    buildValidationInput({ icon: '../secret.png' }, STUB_TEMPLATE, templateRoot),
    /icon must stay inside template\/: \.\.\/secret\.png/
  );
});

test('buildValidationInput reports a deeply nested ../ escape (e.g. equivalent to ../../etc/passwd) as a finding', () => {
  // However many `..` segments are used, resolving back out of templateRoot
  // must never succeed — whether that lands on a real file outside
  // template/ (containment finding) or on nothing at all (not-found
  // finding), it must be reported either way, never silently resolve.
  const result = buildValidationInput({ icon: '../../../../../../secret.png' }, STUB_TEMPLATE, templateRoot);
  assertIconFinding(result, /icon (must stay inside template\/|file not found)/);
});

test('buildValidationInput reports an icon path pointing at a file that does not exist as a finding', () => {
  assertIconFinding(
    buildValidationInput({ icon: 'does-not-exist.png' }, STUB_TEMPLATE, templateRoot),
    /icon file not found: does-not-exist\.png/
  );
});

test('buildValidationInput accepts an icon path that stays inside template/', () => {
  withIconFile('icon.png', 'not-really-a-png', () => {
    const { input, findings } = buildValidationInput({ icon: 'icon.png' }, STUB_TEMPLATE, templateRoot);
    assert.deepEqual(findings, []);
    assert.equal(input.icon.name, 'icon.png');
    assert.equal(input.icon.size, Buffer.byteLength('not-really-a-png'));
  });
});

// resolveIconPath used to check only containment, file type and size, while
// the icon route (lib/preview-middleware.js's serveTemplateIcon) also
// enforced CONTRACT.md's "raster file directly under template/" name shape —
// so the icons below passed validation and the banner while the preview
// itself 404'd on them. Each one exists on disk and stays inside template/,
// so only the name check can reject it.

test('buildValidationInput reports an icon in a subfolder of template/ as a finding', () => {
  const iconDir = path.join(templateRoot, 'img');
  fs.mkdirSync(iconDir, { recursive: true });
  fs.writeFileSync(path.join(iconDir, 'icon.png'), 'not-really-a-png');
  try {
    assertIconFinding(
      buildValidationInput({ icon: 'img/icon.png' }, STUB_TEMPLATE, templateRoot),
      /icon must be a \.png, \.jpg, \.jpeg or \.webp file placed directly under template\/: img\/icon\.png/
    );
  } finally {
    fs.rmSync(iconDir, { recursive: true, force: true });
  }
});

test('buildValidationInput reports an icon whose extension is not png/jpg/jpeg/webp as a finding', () => {
  withIconFile('icon.bin', 'not-really-a-png', () => {
    assertIconFinding(
      buildValidationInput({ icon: 'icon.bin' }, STUB_TEMPLATE, templateRoot),
      /icon must be a \.png, \.jpg, \.jpeg or \.webp file placed directly under template\/: icon\.bin/
    );
  });
});

test('buildValidationInput accepts an upper-case icon extension, as the icon route does', () => {
  withIconFile('ICON.PNG', 'not-really-a-png', () => {
    const { input, findings } = buildValidationInput({ icon: 'ICON.PNG' }, STUB_TEMPLATE, templateRoot);
    assert.deepEqual(findings, []);
    assert.equal(input.icon.name, 'ICON.PNG');
  });
});

test('buildValidationInput accepts a flat icon name the icon route also normalizes to one (./ prefix, .webp)', () => {
  // The route tests its normalizeIndexPath()'d `normalizedIcon`, not the raw
  // value — `./icon.webp` normalizes to `icon.webp` and is served there, so
  // it must not be rejected here either.
  withIconFile('icon.webp', 'not-really-a-webp', () => {
    const { input, findings } = buildValidationInput({ icon: './icon.webp' }, STUB_TEMPLATE, templateRoot);
    assert.deepEqual(findings, []);
    assert.equal(input.icon.size, Buffer.byteLength('not-really-a-webp'));
  });
});

test('buildValidationInput reports an icon path that resolves to a directory instead of a file as a finding', () => {
  // Containment alone doesn't rule this out — a directory can be "inside
  // template/" and still not be a thing to read. This is also the
  // general-purpose guard against any non-regular file (a FIFO/named pipe in
  // particular would make the read hang indefinitely waiting for a writer
  // that never arrives), just exercised here with a directory, which is
  // portable across platforms and doesn't need a special file created on
  // disk.
  fs.mkdirSync(path.join(templateRoot, 'icon-dir.png'));
  try {
    assertIconFinding(
      buildValidationInput({ icon: 'icon-dir.png' }, STUB_TEMPLATE, templateRoot),
      /icon must be a regular file: icon-dir\.png/
    );
  } finally {
    fs.rmSync(path.join(templateRoot, 'icon-dir.png'), { recursive: true, force: true });
  }
});

test('buildValidationInput hands an icon over CONTRACT.md\'s 50 KB limit to validate() with its real size, so the core reports it', async () => {
  // No finding of our own for this one: oversize is validate()'s own
  // maxFileSize rule to report (it knows the icon cap and folds the icon
  // into the whole-bundle total), so the icon goes into `input` — only its
  // first 50 KB read, zero-padded back to the real size validate() requires.
  const realSize = ICON_CAP + 1;
  const { input, findings } = withIconFile(
    'big-icon.png',
    Buffer.concat([PNG_SIGNATURE, Buffer.alloc(realSize - PNG_SIGNATURE.length)]),
    () => buildValidationInput({ icon: 'big-icon.png' }, STUB_TEMPLATE, templateRoot)
  );
  assert.deepEqual(findings, []);
  assert.equal(input.icon.size, realSize);
  assert.equal(input.icon.buffer.byteLength, realSize, 'validate() requires size === buffer.byteLength');
  const result = await validate({ icon: input.icon });
  assert.ok(
    result.errors.some(
      (finding) => finding.rule === 'maxFileSize' && /big-icon\.png is 51201 bytes, over the 51200-byte limit for each icon/.test(finding.message)
    ),
    'validate() must report the icon as oversized: ' + JSON.stringify(result.errors)
  );
});

// The test above would still pass if the whole icon were read and then cut
// down — not what "never read in full" claims. Proven without a mocking
// library (see test/load-bundle.test.js's copy of this reasoning): swap
// fs.readFileSync/openSync/readSync/closeSync on the shared `fs` module object
// by hand for the one call, restored in `finally`.
test('buildValidationInput never calls fs.readFileSync on an oversized icon, and asks fs.readSync for at most its 50 KB cap', () => {
  withIconFile('huge-icon.png', Buffer.alloc(ICON_CAP * 4), (iconPath) => {
    const real = { readFileSync: fs.readFileSync, openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync };
    let iconFd = null;
    let iconFdOpen = false;
    let bytesRequested = 0;
    fs.readFileSync = function (filePath) {
      if (String(filePath) === fs.realpathSync(iconPath)) throw new Error('fs.readFileSync must never be called on the oversized icon');
      return real.readFileSync.apply(fs, arguments);
    };
    fs.openSync = function (filePath) {
      const fd = real.openSync.apply(fs, arguments);
      if (String(filePath) === fs.realpathSync(iconPath)) {
        iconFd = fd;
        iconFdOpen = true;
      }
      return fd;
    };
    fs.readSync = function (fd, buffer, offset, length) {
      if (iconFdOpen && fd === iconFd) bytesRequested += length;
      return real.readSync.apply(fs, arguments);
    };
    fs.closeSync = function (fd) {
      if (fd === iconFd) iconFdOpen = false;
      return real.closeSync.apply(fs, arguments);
    };
    let result;
    try {
      result = buildValidationInput({ icon: 'huge-icon.png' }, STUB_TEMPLATE, templateRoot);
    } finally {
      Object.assign(fs, real);
    }
    assert.notEqual(iconFd, null, 'the oversized icon must have been opened for its prefix read');
    assert.equal(iconFdOpen, false, 'the prefix read must close its descriptor');
    assert.ok(bytesRequested <= ICON_CAP, 'requested ' + bytesRequested + ' bytes, more than the ' + ICON_CAP + '-byte cap');
    assert.equal(result.input.icon.size, ICON_CAP * 4);
  });
});

// Unreadable-but-statable (chmod 0o000), the case the old stat-before-read
// proof used. The oversized icon IS opened now (for its prefix), so this pins
// a decision rather than an ordering: an icon that can't be read at all is
// still an icon problem, reported as an `icon` finding like the others above,
// not a throw that would hide the rest of the bundle's findings.
const canTestUnreadableFile = typeof process.getuid === 'function' && process.getuid() !== 0;

test(
  'buildValidationInput reports an unreadable icon (oversized or not) as a finding instead of throwing',
  { skip: !canTestUnreadableFile && 'requires a non-root POSIX user to make chmod 0o000 actually deny reads' },
  () => {
    for (const size of [ICON_CAP + 1, 16]) {
      withIconFile('locked-icon.png', Buffer.alloc(size), (iconPath) => {
        fs.chmodSync(iconPath, 0o000);
        try {
          assertIconFinding(
            buildValidationInput({ icon: 'locked-icon.png' }, STUB_TEMPLATE, templateRoot),
            /icon could not be read: locked-icon\.png \(EACCES\)/
          );
        } finally {
          fs.chmodSync(iconPath, 0o644);
        }
      });
    }
  }
);

test('buildValidationInput accepts an icon exactly at the 50 KB byte cap', () => {
  withIconFile('exact-icon.png', Buffer.alloc(ICON_CAP), () => {
    const { input, findings } = buildValidationInput({ icon: 'exact-icon.png' }, STUB_TEMPLATE, templateRoot);
    assert.deepEqual(findings, []);
    assert.equal(input.icon.size, ICON_CAP);
  });
});

test('withExtraFindings appends icon findings after validate()\'s own and turns ok false for an error', () => {
  const own = { rule: 'assetUsage', severity: 'warning', message: 'w' };
  const icon = { rule: 'icon', severity: 'error', message: 'e' };
  assert.deepEqual(withExtraFindings({ ok: true, errors: [own] }, [icon]), { ok: false, errors: [own, icon] });
  const untouched = { ok: true, errors: [own] };
  assert.equal(withExtraFindings(untouched, []), untouched);
});

// A JPEG whose start-of-frame (SOF0, 100x100 px) sits behind one APP1
// (EXIF-shaped) segment of `payloadBytes` bytes — past the icon's 50 KB read
// cap once that is over ~51 KB. `sofBeforeScan: false` puts a start-of-scan
// marker BEFORE the SOF instead, a real defect the core must keep reporting.
function jpegWithLateSof(payloadBytes, options) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x64, 0x00, 0x64, 0x01, 0x01, 0x11, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1, ((payloadBytes + 2) >> 8) & 0xff, (payloadBytes + 2) & 0xff]),
    Buffer.alloc(payloadBytes, 0x41),
  ]);
  const early = options && options.scanBeforeSof ? [sos, Buffer.alloc(payloadBytes, 0x41)] : [app1];
  return Buffer.concat([Buffer.from([0xff, 0xd8])].concat(early, [sof, Buffer.from([0xff, 0xd9])]));
}

const UNREADABLE_DIMENSIONS = /Could not read the pixel dimensions of/;

async function validateIcon(name, contents) {
  return withIconFile(name, contents, async () => {
    const { input, findings } = buildValidationInput({ icon: name }, STUB_TEMPLATE, templateRoot);
    assert.deepEqual(findings, []);
    const raw = await validate({ icon: input.icon });
    return { raw, finished: finishValidationResult(raw, input, findings) };
  });
}

test('an oversized JPEG icon whose frame header lies past the read cap gets maxFileSize, not a false "could not read the pixel dimensions" finding', async () => {
  const { raw, finished } = await validateIcon('late-sof.jpg', jpegWithLateSof(60000));
  // The premise: validate() alone, on the zero-padded prefix, does report it.
  assert.ok(raw.errors.some((finding) => UNREADABLE_DIMENSIONS.test(finding.message)), JSON.stringify(raw.errors));
  assert.ok(
    finished.errors.some((finding) => finding.rule === 'maxFileSize' && /late-sof\.jpg is 60021 bytes, over the 51200-byte limit/.test(finding.message)),
    JSON.stringify(finished.errors)
  );
  assert.ok(!finished.errors.some((finding) => UNREADABLE_DIMENSIONS.test(finding.message)), JSON.stringify(finished.errors));
  assert.equal(finished.ok, false);
});

test('a truncated icon keeps its real imageSafety findings: not an image at all, or a JPEG whose own prefix ends the walk', async () => {
  const notAnImage = await validateIcon('big-text.png', Buffer.alloc(ICON_CAP + 100, 0x41));
  assert.ok(
    notAnImage.finished.errors.some((finding) => finding.rule === 'imageSafety' && /big-text\.png is not a PNG, JPEG or WebP image/.test(finding.message)),
    JSON.stringify(notAnImage.finished.errors)
  );
  assert.ok(notAnImage.finished.errors.some((finding) => finding.rule === 'maxFileSize'));

  // Start of scan before any SOF, inside the bytes that WERE read: a real
  // defect however big the file is, so its finding must stay.
  const scanFirst = await validateIcon('scan-first.jpg', jpegWithLateSof(60000, { scanBeforeSof: true }));
  assert.ok(
    scanFirst.finished.errors.some((finding) => UNREADABLE_DIMENSIONS.test(finding.message)),
    JSON.stringify(scanFirst.finished.errors)
  );
});

test('an in-cap JPEG icon without a readable frame header keeps its dimension finding — only a truncated one is ever re-checked', async () => {
  // SOF behind a 20 KB APP1 but cut off by the file itself: nothing was
  // left unread, so the finding is real.
  const contents = jpegWithLateSof(20000).subarray(0, 20000 + 6 + 4);
  const { finished } = await validateIcon('short.jpg', contents);
  assert.ok(finished.errors.some((finding) => UNREADABLE_DIMENSIONS.test(finding.message)), JSON.stringify(finished.errors));
});

test('jpegDimensionsNeedUnreadBytes: true only when the marker walk leaves the prefix before a verdict', () => {
  const full = jpegWithLateSof(60000);
  assert.equal(jpegDimensionsNeedUnreadBytes(full.subarray(0, ICON_CAP)), true, 'APP1 runs past the cap');
  assert.equal(jpegDimensionsNeedUnreadBytes(full), false, 'the whole file: SOF read in full');
  assert.equal(jpegDimensionsNeedUnreadBytes(full.subarray(0, 60006 + 5)), true, 'SOF frame header cut mid-way');
  assert.equal(jpegDimensionsNeedUnreadBytes(jpegWithLateSof(60000, { scanBeforeSof: true }).subarray(0, ICON_CAP)), false, 'SOS before SOF');
  assert.equal(jpegDimensionsNeedUnreadBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01])), false, 'segment length under 2');
  assert.equal(jpegDimensionsNeedUnreadBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00])), true, 'segment length itself cut off');
});

test('finishValidationResult drops nothing when no entry was truncated, and still appends the extra findings', () => {
  const dims = { rule: 'imageSafety', severity: 'error', message: 'Could not read the pixel dimensions of i.jpg from its JPEG header.', ref: { file: 'i.jpg' } };
  const icon = { name: 'i.jpg', size: 4, buffer: new Uint8Array(4) };
  const extra = { rule: 'icon', severity: 'error', message: 'e' };
  assert.deepEqual(finishValidationResult({ ok: false, errors: [dims] }, { icon }, [extra]), { ok: false, errors: [dims, extra] });
});

test('an icon over the 4 MB validation ceiling is reported as over the size limit, not as unreadable — the icon route serves it fine', () => {
  const name = 'giant-icon.png';
  const iconPath = path.join(templateRoot, name);
  fs.writeFileSync(iconPath, PNG_SIGNATURE);
  fs.truncateSync(iconPath, 4 * 1024 * 1024 + 1); // sparse: no 4 MB write
  try {
    const result = buildValidationInput({ icon: name }, STUB_TEMPLATE, templateRoot);
    assertIconFinding(result, /icon giant-icon\.png is 4194305 bytes, over the 51200-byte size limit for the icon and too large for the local validator to inspect/);
    assert.doesNotMatch(result.findings[0].message, /could not be read/);
  } finally {
    fs.rmSync(iconPath, { force: true });
  }
});
