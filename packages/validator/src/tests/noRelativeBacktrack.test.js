const { test } = require('node:test');
const assert = require('node:assert/strict');
const noRelativeBacktrack = require('../rules/noRelativeBacktrack');

function tmpl(cssContent) {
  return { html: null, css: cssContent ? { path: '/tmp/style.css', size: cssContent.length, content: cssContent } : null,
    i18nFiles: [], icon: null, assets: [], templateDir: '/tmp' };
}

test('noRelativeBacktrack — passa com url() relativo simples', () => {
  assert.equal(noRelativeBacktrack(tmpl('div { background: url("./img/bg.png"); }')).length, 0);
});

test('noRelativeBacktrack — passa com url() absoluto root-relative', () => {
  assert.equal(noRelativeBacktrack(tmpl('div { background: url("/assets/img/bg.png"); }')).length, 0);
});

test('noRelativeBacktrack — bloqueia url() com ../', () => {
  const errors = noRelativeBacktrack(tmpl('div { background: url("../../img/logo.png"); }'));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'noRelativeBacktrack');
  assert.match(errors[0].message, /\.\.\//);
});

test('noRelativeBacktrack — bloqueia url() com .. sem barra', () => {
  const errors = noRelativeBacktrack(tmpl("div { background: url('../img/logo.png'); }"));
  assert.ok(errors.some(e => e.rule === 'noRelativeBacktrack'));
});

test('noRelativeBacktrack — retorna vazio quando css é null', () => {
  assert.equal(noRelativeBacktrack(tmpl(null)).length, 0);
});
