'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildValidationInput } = require('../lib/validation-input');

/**
 * lib/validation-input.js resolves `config.icon` against a `templateRoot`
 * (defaulting to the real template/ directory) via realpathSync plus an
 * isPathContained containment check (see resolveIconPath in that module's own
 * docblock). That containment check is the module's whole reason to exist per
 * its docblock ("a `../../` icon path can't read a file outside template/"),
 * yet had no test of its own.
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

test('buildValidationInput rejects an icon path that escapes template/ via ../', () => {
  const config = { icon: '../secret.png' };
  assert.throws(
    () => buildValidationInput(config, STUB_TEMPLATE, templateRoot),
    /icon must stay inside template\//
  );
});

test('buildValidationInput rejects a deeply nested ../ escape (e.g. equivalent to ../../etc/passwd)', () => {
  // However many `..` segments are used, resolving back out of templateRoot
  // must never succeed — whether that lands on a real file outside
  // template/ (containment error) or on nothing at all (not-found error), it
  // must throw either way, never silently resolve.
  const config = { icon: '../../../../../../secret.png' };
  assert.throws(() => buildValidationInput(config, STUB_TEMPLATE, templateRoot));
});

test('buildValidationInput rejects an icon path pointing at a file that does not exist', () => {
  const config = { icon: 'does-not-exist.png' };
  assert.throws(
    () => buildValidationInput(config, STUB_TEMPLATE, templateRoot),
    /icon file not found/
  );
});

test('buildValidationInput accepts an icon path that stays inside template/', () => {
  fs.writeFileSync(path.join(templateRoot, 'icon.png'), 'not-really-a-png');
  try {
    const input = buildValidationInput({ icon: 'icon.png' }, STUB_TEMPLATE, templateRoot);
    assert.equal(input.icon.name, 'icon.png');
    assert.equal(input.icon.size, Buffer.byteLength('not-really-a-png'));
  } finally {
    fs.rmSync(path.join(templateRoot, 'icon.png'), { force: true });
  }
});

test('buildValidationInput rejects an icon path that resolves to a directory instead of a file', () => {
  // Containment alone doesn't rule this out — a directory can be "inside
  // template/" and still not be a thing fs.readFileSync should ever be
  // pointed at. This is also the general-purpose guard against any
  // non-regular file (a FIFO/named pipe in particular would make the
  // eventual fs.readFileSync hang indefinitely waiting for a writer that
  // never arrives), just exercised here with a directory, which is portable
  // across platforms and doesn't need a special file created on disk.
  fs.mkdirSync(path.join(templateRoot, 'icon-dir.png'));
  try {
    assert.throws(
      () => buildValidationInput({ icon: 'icon-dir.png' }, STUB_TEMPLATE, templateRoot),
      /icon must be a regular file/
    );
  } finally {
    fs.rmSync(path.join(templateRoot, 'icon-dir.png'), { recursive: true, force: true });
  }
});

test('buildValidationInput rejects an icon over CONTRACT.md\'s 50 KB limit without reading it in full', () => {
  const iconPath = path.join(templateRoot, 'big-icon.png');
  fs.writeFileSync(iconPath, Buffer.alloc(50 * 1024 + 1));
  try {
    assert.throws(
      () => buildValidationInput({ icon: 'big-icon.png' }, STUB_TEMPLATE, templateRoot),
      /icon "big-icon\.png" is \d+ bytes, over the \d+-byte limit for the icon/
    );
  } finally {
    fs.rmSync(iconPath, { force: true });
  }
});

test('buildValidationInput accepts an icon exactly at the 50 KB byte cap', () => {
  const iconPath = path.join(templateRoot, 'exact-icon.png');
  fs.writeFileSync(iconPath, Buffer.alloc(50 * 1024));
  try {
    const input = buildValidationInput({ icon: 'exact-icon.png' }, STUB_TEMPLATE, templateRoot);
    assert.equal(input.icon.size, 50 * 1024);
  } finally {
    fs.rmSync(iconPath, { force: true });
  }
});
