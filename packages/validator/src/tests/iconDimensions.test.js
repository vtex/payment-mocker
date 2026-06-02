const { test } = require('node:test');
const assert = require('node:assert/strict');
const iconDimensions = require('../rules/iconDimensions');

function makePngBuffer(width, height) {
  const buf = Buffer.alloc(24);
  buf.write('\x89PNG\r\n\x1a\n', 0, 'binary'); // PNG signature
  buf.writeUInt32BE(13, 8);                      // IHDR length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function tmpl(iconBuf) {
  return {
    html: null, css: null, i18nFiles: [], assets: [], templateDir: '/tmp',
    icon: iconBuf ? { path: '/tmp/icon.png', size: iconBuf.length, buffer: iconBuf } : null,
  };
}

test('iconDimensions — passa com ícone 80x80px', () => {
  assert.equal(iconDimensions(tmpl(makePngBuffer(80, 80))).length, 0);
});

test('iconDimensions — passa com ícone no limite mínimo (40x40)', () => {
  assert.equal(iconDimensions(tmpl(makePngBuffer(40, 40))).length, 0);
});

test('iconDimensions — passa com ícone no limite máximo (200x200)', () => {
  assert.equal(iconDimensions(tmpl(makePngBuffer(200, 200))).length, 0);
});

test('iconDimensions — falha com ícone muito grande (4000x4000)', () => {
  const errors = iconDimensions(tmpl(makePngBuffer(4000, 4000)));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'iconDimensions');
  assert.match(errors[0].message, /4000/);
  assert.match(errors[0].message, /200/);
});

test('iconDimensions — falha com ícone muito pequeno (10x10)', () => {
  const errors = iconDimensions(tmpl(makePngBuffer(10, 10)));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /pequeno|mínimo/i);
});

test('iconDimensions — respeita opts.iconMinDimension e opts.iconMaxDimension', () => {
  const buf = makePngBuffer(300, 300);
  assert.equal(iconDimensions(tmpl(buf), { iconMaxDimension: 500 }).length, 0);
  assert.equal(iconDimensions(tmpl(buf), { iconMaxDimension: 200 }).length, 1);
});

test('iconDimensions — retorna vazio quando icon é null', () => {
  assert.equal(iconDimensions(tmpl(null)).length, 0);
});
