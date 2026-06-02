const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const maxFileSize = require('../rules/maxFileSize');

function makeTemplate(files = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-'));
  const slots = {};

  for (const [key, content] of Object.entries(files)) {
    const filePath = path.join(tmpDir, `${key}.html`);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    fs.writeFileSync(filePath, buf);
    slots[key] = { path: filePath, size: buf.length };
  }

  return slots;
}

test('maxFileSize — passa quando total está abaixo do limite', () => {
  const template = {
    html: { path: '/tmp/f.html', size: 1000 },
    css: null,
    i18n: null,
    icon: null,
    assets: [{ path: '/tmp/a.png', size: 2000 }],
  };
  const errors = maxFileSize(template);
  assert.equal(errors.length, 0);
});

test('maxFileSize — falha quando total ultrapassa 128KB', () => {
  const template = {
    html: { path: '/tmp/f.html', size: 100 * 1024 },
    css: null,
    i18n: null,
    icon: null,
    assets: [{ path: '/tmp/a.bin', size: 50 * 1024 }],
  };
  const errors = maxFileSize(template);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'maxFileSize');
  assert.match(errors[0].message, /excede o limite/);
});

test('maxFileSize — respeita opts.maxFileSize como limite customizado', () => {
  const template = {
    html: { path: '/tmp/f.html', size: 10 * 1024 },
    css: null,
    i18n: null,
    icon: null,
    assets: [],
  };
  const errors = maxFileSize(template, { maxFileSize: 5 * 1024 });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /5KB/);
});

test('maxFileSize — ignora slots null', () => {
  const template = {
    html: null,
    css: null,
    i18n: null,
    icon: null,
    assets: [{ path: '/tmp/a.png', size: 100 }],
  };
  const errors = maxFileSize(template);
  assert.equal(errors.length, 0);
});
