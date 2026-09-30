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

let tempRoot;

test.before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-mocker-validate-reference-'));
  for (const dir of ['scripts', 'lib', 'template']) {
    fs.cpSync(path.join(REPO_ROOT, dir), path.join(tempRoot, dir), { recursive: true });
  }
  // test/preview-middleware.test.js briefly writes a stray notes.txt into the
  // REAL template/reference (its REAL_STRAY_FILE_PATH — the one way to
  // exercise the zero-argument production path), and `node --test` runs test
  // files in parallel processes, so this copy can catch it mid-test. Dropped
  // here so the copy is always the checked-in bundle.
  fs.rmSync(path.join(tempRoot, 'template', 'reference', 'notes.txt'), { force: true });
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
