const { test } = require('node:test');
const assert = require('node:assert/strict');
const noExternalRefs = require('../rules/noExternalRefs');

function makeTemplate({ htmlContent = null, cssContent = null } = {}) {
  return {
    html: htmlContent ? { path: '/tmp/payment.html', size: htmlContent.length, content: htmlContent } : null,
    css: cssContent ? { path: '/tmp/style.css', size: cssContent.length, content: cssContent } : null,
    i18nFiles: [],
    icon: null,
    assets: [],
  };
}

test('noExternalRefs — passa com paths relativos no HTML', () => {
  const template = makeTemplate({ htmlContent: '<img src="./logo.png"><a href="payment.html">ok</a>' });
  assert.equal(noExternalRefs(template).length, 0);
});

test('noExternalRefs — passa com paths root-relative no CSS', () => {
  const template = makeTemplate({ cssContent: 'div { background: url(/assets/img/bg.png); }' });
  assert.equal(noExternalRefs(template).length, 0);
});

test('noExternalRefs — passa com data: URI', () => {
  const template = makeTemplate({ htmlContent: '<img src="data:image/png;base64,abc123">' });
  assert.equal(noExternalRefs(template).length, 0);
});

test('noExternalRefs — bloqueia src externo em <img>', () => {
  const template = makeTemplate({ htmlContent: '<img src="https://partner-cdn.com/pixel.gif">' });
  const errors = noExternalRefs(template);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'noExternalRefs');
  assert.match(errors[0].message, /https:\/\/partner-cdn\.com/);
});

test('noExternalRefs — bloqueia src externo em <script>', () => {
  const template = makeTemplate({ htmlContent: '<script src="https://partner.com/lib.js"></script>' });
  const errors = noExternalRefs(template);
  assert.ok(errors.some(e => e.rule === 'noExternalRefs'));
});

test('noExternalRefs — bloqueia href externo em <link>', () => {
  const template = makeTemplate({ htmlContent: '<link href="https://fonts.googleapis.com/css?family=Roboto" rel="stylesheet">' });
  const errors = noExternalRefs(template);
  assert.ok(errors.some(e => e.rule === 'noExternalRefs'));
});

test('noExternalRefs — bloqueia url() externo em CSS', () => {
  const template = makeTemplate({ cssContent: 'div { background: url("https://cdn.com/img.png"); }' });
  const errors = noExternalRefs(template);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /URL externa bloqueada em CSS/);
});

test('noExternalRefs — bloqueia @import externo em CSS', () => {
  const template = makeTemplate({ cssContent: '@import "https://fonts.googleapis.com/css2?family=Roboto";' });
  const errors = noExternalRefs(template);
  assert.ok(errors.some(e => /import externo/.test(e.message)));
});

test('noExternalRefs — detecta múltiplos erros no mesmo template', () => {
  const template = makeTemplate({
    htmlContent: '<img src="https://cdn1.com/a.png"><img src="https://cdn2.com/b.png">',
  });
  const errors = noExternalRefs(template);
  assert.equal(errors.length, 2);
});

test('noExternalRefs — retorna vazio quando html e css são null', () => {
  const template = makeTemplate();
  assert.equal(noExternalRefs(template).length, 0);
});
