const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assetsReferenced = require('../rules/assetsReferenced');

function makeTemplate({ htmlContent = null, cssContent = null, assetNames = [], templateDir } = {}) {
  const dir = templateDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-'));
  for (const name of assetNames) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  }
  const assets = assetNames.map(name => ({ path: path.join(dir, name), size: 1 }));
  return {
    html: htmlContent ? { path: path.join(dir, 'payment.html'), size: htmlContent.length, content: htmlContent } : null,
    css: cssContent ? { path: path.join(dir, 'style.css'), size: cssContent.length, content: cssContent } : null,
    i18nFiles: [], icon: null, assets, templateDir: dir,
  };
}

test('assetsReferenced — passa quando todos assets são referenciados no HTML', () => {
  const t = makeTemplate({
    htmlContent: '<img src="logo.png">',
    assetNames: ['logo.png'],
  });
  assert.equal(assetsReferenced(t).length, 0);
});

test('assetsReferenced — passa quando asset referenciado no CSS', () => {
  const t = makeTemplate({
    cssContent: '.x { background: url("bg.png"); }',
    assetNames: ['bg.png'],
  });
  assert.equal(assetsReferenced(t).length, 0);
});

test('assetsReferenced — erro para referência quebrada (arquivo não existe)', () => {
  const t = makeTemplate({
    htmlContent: '<img src="logoo.png">',
    assetNames: ['logo.png'],
  });
  const errors = assetsReferenced(t);
  assert.ok(errors.some(e => e.rule === 'assetsReferenced' && e.severity === 'error' && /logoo\.png/.test(e.message)));
});

test('assetsReferenced — warning para asset órfão (não referenciado)', () => {
  const t = makeTemplate({
    htmlContent: '<div>Pagar</div>',
    assetNames: ['banner.png'],
  });
  const errors = assetsReferenced(t);
  assert.ok(errors.some(e => e.rule === 'assetsReferenced' && e.severity === 'warning' && /banner\.png/.test(e.message)));
});

test('assetsReferenced — ignora URLs externas nas referências', () => {
  const t = makeTemplate({
    htmlContent: '<img src="https://cdn.com/logo.png">',
    assetNames: [],
  });
  assert.equal(assetsReferenced(t).length, 0);
});

test('assetsReferenced — ignora data: URIs', () => {
  const t = makeTemplate({
    htmlContent: '<img src="data:image/png;base64,abc">',
    assetNames: [],
  });
  assert.equal(assetsReferenced(t).length, 0);
});

test('assetsReferenced — retorna vazio sem html e css', () => {
  const t = makeTemplate({ assetNames: ['bg.png'] });
  // No HTML/CSS → no references to collect, but orphan warning expected for image
  const errors = assetsReferenced(t);
  assert.ok(errors.every(e => e.severity === 'warning'));
});

test('assetsReferenced — não reporta non-image como órfão', () => {
  const t = makeTemplate({
    htmlContent: '<div>ok</div>',
    assetNames: ['data.json'],
  });
  assert.equal(assetsReferenced(t).length, 0);
});
