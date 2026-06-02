const { test } = require('node:test');
const assert = require('node:assert/strict');
const requiredFiles = require('../rules/requiredFiles');

function tmpl(overrides = {}) {
  return { html: null, css: null, i18n: null, i18nFiles: [], icon: null, assets: [], templateDir: '/tmp', ...overrides };
}

const HTML  = { path: '/tmp/partials/payment.html', size: 100 };
const I18N  = { path: '/tmp/i18n/pt-BR.json',       size: 50  };
const ICON  = { path: '/tmp/assets/img/icon.png',   size: 200 };

test('requiredFiles — passa quando html, i18n e icon estão presentes', () => {
  assert.equal(requiredFiles(tmpl({ html: HTML, i18n: I18N, icon: ICON })).length, 0);
});

test('requiredFiles — erro quando payment.html está ausente', () => {
  const errors = requiredFiles(tmpl({ i18n: I18N, icon: ICON }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'requiredFiles');
  assert.match(errors[0].message, /payment\.html/);
  assert.equal(errors[0].severity, 'error');
});

test('requiredFiles — erro quando i18n/pt-BR.json está ausente', () => {
  const errors = requiredFiles(tmpl({ html: HTML, icon: ICON }));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /pt-BR\.json/);
  assert.equal(errors[0].severity, 'error');
});

test('requiredFiles — warning quando ícone está ausente', () => {
  const errors = requiredFiles(tmpl({ html: HTML, i18n: I18N }));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /icon/i);
  assert.equal(errors[0].severity, 'warning');
});

test('requiredFiles — acumula múltiplos erros', () => {
  const errors = requiredFiles(tmpl());
  assert.ok(errors.length >= 2);
  assert.ok(errors.some(e => /payment\.html/.test(e.message)));
  assert.ok(errors.some(e => /pt-BR\.json/.test(e.message)));
});
