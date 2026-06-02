const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const maxImageDimensions = require('../rules/maxImageDimensions');

function makePngBuffer(width, height) {
  const buf = Buffer.alloc(24);
  buf.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function makePngAsset(width, height, name = 'img.png') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-'));
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, makePngBuffer(width, height));
  return { path: filePath, size: 24 };
}

test('maxImageDimensions — passa com PNG dentro do limite (500x500)', () => {
  const asset = makePngAsset(500, 500);
  const template = { html: null, css: null, i18nFiles: [], icon: null, assets: [asset], templateDir: '/tmp' };
  assert.equal(maxImageDimensions(template).length, 0);
});

test('maxImageDimensions — falha com PNG 3000x1000', () => {
  const asset = makePngAsset(3000, 1000, 'bg.png');
  const template = { html: null, css: null, i18nFiles: [], icon: null, assets: [asset], templateDir: '/tmp' };
  const errors = maxImageDimensions(template);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'maxImageDimensions');
  assert.match(errors[0].message, /3000/);
});

test('maxImageDimensions — ignora arquivos não-PNG', () => {
  const asset = { path: '/tmp/doc.pdf', size: 100 };
  const template = { html: null, css: null, i18nFiles: [], icon: null, assets: [asset], templateDir: '/tmp' };
  assert.equal(maxImageDimensions(template).length, 0);
});

test('maxImageDimensions — respeita opts.maxImageDimension', () => {
  const asset = makePngAsset(1500, 1500);
  const template = { html: null, css: null, i18nFiles: [], icon: null, assets: [asset], templateDir: '/tmp' };
  assert.equal(maxImageDimensions(template, { maxImageDimension: 2000 }).length, 0);
  assert.equal(maxImageDimensions(template, { maxImageDimension: 1000 }).length, 1);
});

test('maxImageDimensions — retorna vazio com assets vazio', () => {
  const template = { html: null, css: null, i18nFiles: [], icon: null, assets: [], templateDir: '/tmp' };
  assert.equal(maxImageDimensions(template).length, 0);
});
