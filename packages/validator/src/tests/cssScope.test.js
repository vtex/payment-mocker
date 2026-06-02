const { test } = require('node:test');
const assert = require('node:assert/strict');
const cssScope = require('../rules/cssScope');

function tmpl(cssContent) {
  return { html: null, css: cssContent ? { path: '/tmp/style.css', size: cssContent.length, content: cssContent } : null,
    i18nFiles: [], icon: null, assets: [], templateDir: '/tmp' };
}

test('cssScope — passa com seletor scoped', () => {
  assert.equal(cssScope(tmpl('[data-payment-template] .btn { color: blue; }')).length, 0);
});

test('cssScope — passa com seletor aninhado via espaço', () => {
  assert.equal(cssScope(tmpl('[data-payment-template] h3 { margin: 0; }')).length, 0);
});

test('cssScope — aviso com seletor não-scoped (body)', () => {
  const errors = cssScope(tmpl('body { background: red; }'));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'cssScope');
  assert.equal(errors[0].severity, 'warning');
  assert.match(errors[0].message, /body/);
});

test('cssScope — aviso com seletor de classe não-scoped', () => {
  const errors = cssScope(tmpl('.payment-title { color: red; }'));
  assert.ok(errors.some(e => e.rule === 'cssScope'));
});

test('cssScope — ignora @keyframes', () => {
  assert.equal(cssScope(tmpl('@keyframes fade { from { opacity: 0; } to { opacity: 1; } }')).length, 0);
});

test('cssScope — ignora @font-face', () => {
  assert.equal(cssScope(tmpl('@font-face { font-family: "X"; src: url("/f.woff2"); }')).length, 0);
});

test('cssScope — ignora @media com seletor scoped interno', () => {
  const css = '@media (max-width: 768px) { [data-payment-template] .btn { display: block; } }';
  assert.equal(cssScope(tmpl(css)).length, 0);
});

test('cssScope — aviso dentro de @media com seletor não-scoped', () => {
  const css = '@media (max-width: 768px) { body { margin: 0; } }';
  const errors = cssScope(tmpl(css));
  assert.ok(errors.some(e => e.rule === 'cssScope'));
});

test('cssScope — retorna vazio quando css é null', () => {
  assert.equal(cssScope(tmpl(null)).length, 0);
});
