const { test } = require('node:test');
const assert = require('node:assert/strict');
const htmlSafety = require('../rules/htmlSafety');

function makeHtmlTemplate(htmlContent) {
  return {
    html: { path: '/tmp/payment.html', size: htmlContent.length, content: htmlContent },
    css: null,
    i18nFiles: [],
    icon: null,
    assets: [],
  };
}

test('htmlSafety — passa com HTML limpo', () => {
  const template = makeHtmlTemplate('<div class="payment">Pagamento</div>');
  assert.equal(htmlSafety(template).length, 0);
});

test('htmlSafety — bloqueia tag <script>', () => {
  const template = makeHtmlTemplate('<div><script src="/lib.js"></script></div>');
  const errors = htmlSafety(template);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'htmlSafety');
  assert.match(errors[0].message, /<script>/);
});

test('htmlSafety — bloqueia eval()', () => {
  const template = makeHtmlTemplate('<div data-init="eval(window.x)">test</div>');
  const errors = htmlSafety(template);
  assert.ok(errors.some(e => e.rule === 'htmlSafety' && /eval/.test(e.message)));
});

test('htmlSafety — bloqueia handler onclick inline', () => {
  const template = makeHtmlTemplate('<button onclick="doSomething()">Pagar</button>');
  const errors = htmlSafety(template);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /onclick/);
});

test('htmlSafety — bloqueia handler onmouseover inline', () => {
  const template = makeHtmlTemplate('<div onmouseover="hover()">item</div>');
  const errors = htmlSafety(template);
  assert.ok(errors.some(e => /on\w+/.test(e.message)));
});

test('htmlSafety — retorna vazio quando html é null', () => {
  const template = { html: null, css: null, i18nFiles: [], icon: null, assets: [] };
  assert.equal(htmlSafety(template).length, 0);
});
