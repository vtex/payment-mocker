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

function runValidateReference(configOverrides) {
  const configPath = path.join(tempRoot, 'template', 'preview.config.json');
  const original = fs.readFileSync(configPath, 'utf8');
  if (configOverrides) {
    fs.writeFileSync(configPath, JSON.stringify(Object.assign(JSON.parse(original), configOverrides)));
  }
  try {
    return spawnSync(process.execPath, [path.join(tempRoot, 'scripts', 'validate-reference.js')], {
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
    assert.match(result.stderr, /^validate: failed/m);
    assert.match(result.stderr, /\[icon\] preview\.config\.json icon must be a \.png, \.jpg, \.jpeg or \.webp file placed directly under template\/: icon\.bin/);
    assert.match(result.stderr, /\[displayNameSafety\]/, 'the unrelated finding must still be reported');
  } finally {
    fs.rmSync(path.join(tempRoot, 'template', 'icon.bin'), { force: true });
  }
});

test('validate-reference fails (exit 1) on an icon problem alone, like any other error', () => {
  const result = runValidateReference({ icon: 'does-not-exist.png' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /\[icon\] preview\.config\.json icon file not found: does-not-exist\.png/);
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
    assert.match(result.stderr, /\[maxFileSize\] late-sof\.jpg is 60021 bytes, over the 51200-byte limit for each icon/);
    assert.doesNotMatch(result.stderr, /Could not read the pixel dimensions/);
  } finally {
    fs.rmSync(iconPath, { force: true });
  }
});
