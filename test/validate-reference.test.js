'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Runs the real scripts/validate-reference.js end to end, exit code and all —
 * the thing `npm run validate:reference` and Gruntfile.js's `validate` task
 * both run. The script (via lib/preview-config.js's TEMPLATE_ROOT) always
 * reads the template/ directory next to its own lib/, so rather than ever
 * touching the real, git-tracked template/, each run copies scripts/, lib/
 * and template/ into a disposable directory, links the real node_modules in
 * beside them, and edits only that copy's preview.config.json.
 */
const REPO_ROOT = path.join(__dirname, '..');

// Files another test file temporarily writes INTO the real, checked-in
// template/ — today only test/preview-middleware.test.js's stray notes.txt in
// template/reference (its REAL_STRAY_FILE_PATH, the one way to exercise the
// zero-argument production path; every other write in the suite goes to a
// temp copy). `node --test` runs test files in parallel processes, so the
// copy below can run while that file exists, or while it is being created or
// deleted. Copying it and removing it afterwards, as this used to, was not
// enough: fs.cpSync could list notes.txt and then find it gone by the time it
// stat'd/copied it, throwing ENOENT out of this whole file's `before`. The
// `filter` below rejects these names by basename alone — cpSync calls it
// before it ever stats or opens an entry, so a scratch file appearing,
// vanishing or half-written mid-copy is never touched at all. Add a name here
// if another test starts writing into the real template/.
const TEST_SCRATCH_NAMES = new Set(['notes.txt']);

function skipTestScratch(source) {
  return !TEST_SCRATCH_NAMES.has(path.basename(source));
}

let tempRoot;

test.before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-mocker-validate-reference-'));
  for (const dir of ['scripts', 'lib', 'template']) {
    fs.cpSync(path.join(REPO_ROOT, dir), path.join(tempRoot, dir), { recursive: true, filter: skipTestScratch });
  }
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tempRoot, 'node_modules'), 'dir');
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function runValidateReference(configOverrides, extraArgs) {
  const configPath = path.join(tempRoot, 'template', 'preview.config.json');
  const original = fs.readFileSync(configPath, 'utf8');
  if (configOverrides) {
    fs.writeFileSync(configPath, JSON.stringify(Object.assign(JSON.parse(original), configOverrides)));
  }
  try {
    return spawnSync(process.execPath, [path.join(tempRoot, 'scripts', 'validate-reference.js')].concat(extraArgs || []), {
      encoding: 'utf8',
    });
  } finally {
    fs.writeFileSync(configPath, original);
  }
}

test('validate-reference exits 0 and prints validate: ok for the unmodified reference bundle', () => {
  const result = runValidateReference();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^validate: ok/);
});

test('validate-reference reports a misnamed icon AND an unrelated bundle error, and exits 1', () => {
  // A misnamed icon used to throw out of buildValidationInput: the script
  // printed only that one error (as a raw stack) and never reported anything
  // validate() would have found in the rest of the bundle.
  fs.copyFileSync(path.join(tempRoot, 'template', 'icon.png'), path.join(tempRoot, 'template', 'icon.bin'));
  try {
    const result = runValidateReference({
      icon: 'icon.bin',
      displayName: { 'pt-BR': 'A'.repeat(91), 'en-US': 'Example Pay' },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /^validate: failed \(\d+ errors?\)/m);
    assert.match(result.stderr, /\[error\] icon — preview\.config\.json icon must be a \.png, \.jpg, \.jpeg or \.webp file placed directly under template\/: icon\.bin/);
    assert.match(result.stderr, /\[error\] displayNameSafety — /, 'the unrelated finding must still be reported');
  } finally {
    fs.rmSync(path.join(tempRoot, 'template', 'icon.bin'), { force: true });
  }
});

test('validate-reference fails (exit 1) on an icon problem alone, like any other error', () => {
  const result = runValidateReference({ icon: 'does-not-exist.png' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /\[error\] icon — preview\.config\.json icon file not found: does-not-exist\.png/);
});

test('validate-reference reports a text file past the 4 MB ceiling as one clean [load] finding, like the preview banner — no raw exception or stack', () => {
  // toValidationBundle refuses such a file (lib/load-bundle.js's
  // MAX_VALIDATION_BYTES). The banner always showed that as a single `load`
  // finding; this script used to let the throw reach main().catch, which
  // printed the raw Error with its stack trace instead of `validate: failed`.
  const htmlPath = path.join(tempRoot, 'template', 'reference', 'index.html');
  const original = fs.readFileSync(htmlPath);
  const realSize = 4 * 1024 * 1024 + 1;
  fs.writeFileSync(htmlPath, Buffer.concat([original, Buffer.from(' '.repeat(realSize - original.byteLength))]));
  try {
    const result = runValidateReference();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'validate: failed (1 error) — template at template/reference\n' +
        '  [error] load — index.html is ' + realSize + ' bytes, far over the size limit for each HTML file and over the 4194304-byte ceiling up to which the local preview can hand an oversized file to the validator at all — shrink or remove it to see the rest of the bundle\'s findings.\n'
    );
    assert.doesNotMatch(result.stderr, /^\s+at /m, 'no stack frames');
    assert.doesNotMatch(result.stderr, /Error:/, 'no raw Error dump');
  } finally {
    fs.writeFileSync(htmlPath, original);
  }
});

test('validate-reference reports an unreadable preview.config.json as a clean [load] finding too', () => {
  const configPath = path.join(tempRoot, 'template', 'preview.config.json');
  const original = fs.readFileSync(configPath);
  fs.writeFileSync(configPath, '{ not json');
  try {
    const result = spawnSync(process.execPath, [path.join(tempRoot, 'scripts', 'validate-reference.js')], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /^validate: failed \(1 error\)\n {2}\[error\] load — /);
    assert.doesNotMatch(result.stderr, /^\s+at /m, 'no stack frames');
    assert.ok(!result.stderr.includes(tempRoot), 'the absolute path must be sanitized: ' + result.stderr);
  } finally {
    fs.writeFileSync(configPath, original);
  }
});

test('validate-reference reports an oversized late-SOF JPEG icon as oversized only, like the preview banner (shared finishValidationResult)', () => {
  const iconPath = path.join(tempRoot, 'template', 'late-sof.jpg');
  fs.writeFileSync(
    iconPath,
    Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, (60002 >> 8) & 0xff, 60002 & 0xff]),
      Buffer.alloc(60000, 0x41),
      Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x64, 0x00, 0x64, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]),
    ])
  );
  try {
    const result = runValidateReference({ icon: 'late-sof.jpg' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /\[error\] maxFileSize late-sof\.jpg — late-sof\.jpg is 60021 bytes, over the 51200-byte limit for each icon/);
    assert.doesNotMatch(result.stderr, /Could not read the pixel dimensions/);
  } finally {
    fs.rmSync(iconPath, { force: true });
  }
});

test('validate-reference --json prints the raw { ok, errors } result for an ok bundle, and exits 0', () => {
  const result = runValidateReference(null, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, errors: [] });
  assert.equal(result.stderr, '');
});

test('validate-reference --json prints the raw findings (icon included) for a failing bundle, on stdout only, and exits 1', () => {
  const result = runValidateReference({ icon: 'icon.bin' }, ['--json']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stderr, '', 'JSON mode keeps stderr empty so CI can pipe stdout');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.some((finding) => finding.rule === 'icon' && /icon\.bin/.test(finding.message)));
});

test('validate-reference --json reports a bundle it cannot load as one raw `load` finding, still without a stack or absolute path', () => {
  const configPath = path.join(tempRoot, 'template', 'preview.config.json');
  const original = fs.readFileSync(configPath);
  fs.writeFileSync(configPath, '{ not json');
  try {
    const result = spawnSync(process.execPath, [path.join(tempRoot, 'scripts', 'validate-reference.js'), '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.errors.map((finding) => finding.rule), ['load']);
    assert.ok(!result.stdout.includes(tempRoot), 'the absolute path must be sanitized: ' + result.stdout);
  } finally {
    fs.writeFileSync(configPath, original);
  }
});

test('validate-reference prints a file:line:column location when a finding carries one', () => {
  const htmlPath = path.join(tempRoot, 'template', 'reference', 'index.html');
  const original = fs.readFileSync(htmlPath, 'utf8');
  fs.writeFileSync(htmlPath, '<script>1</script>\n' + original);
  try {
    const result = runValidateReference();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /\[error\] htmlSafety index\.html:\d+:\d+ — /);
  } finally {
    fs.writeFileSync(htmlPath, original);
  }
});

test('validate-reference --json delivers the whole result when it is larger than a pipe buffer (no process.exit() truncation)', () => {
  // process.exit() right after a big write to a pipe discards what didn't fit
  // in the pipe's buffer (~64 KB; observed on macOS) and the JSON arrives cut
  // off. Enough unused CSS classes make the result far larger than that.
  const cssPath = path.join(tempRoot, 'template', 'reference', 'style.css');
  const original = fs.readFileSync(cssPath, 'utf8');
  let extra = '';
  for (let i = 0; i < 1500; i++) extra += '\n.unused-class-' + i + ' { color: red; }';
  fs.writeFileSync(cssPath, original + extra);
  try {
    const result = runValidateReference(null, ['--json']);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.length > 100 * 1024, 'the fixture must exceed a pipe buffer: ' + result.stdout.length);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.errors.filter((finding) => finding.rule === 'cssClassUsage').length >= 1500);
    assert.equal(result.stderr, '');
  } finally {
    fs.writeFileSync(cssPath, original);
  }
});
