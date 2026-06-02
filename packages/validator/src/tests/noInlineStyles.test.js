const { test } = require('node:test');
const assert = require('node:assert/strict');
const noInlineStyles = require('../rules/noInlineStyles');

function tmpl(htmlContent) {
  return { html: htmlContent ? { path: '/tmp/payment.html', size: htmlContent.length, content: htmlContent } : null,
    css: null, i18nFiles: [], icon: null, assets: [], templateDir: '/tmp' };
}

test('noInlineStyles — passa com HTML sem style=', () => {
  assert.equal(noInlineStyles(tmpl('<div class="pay"><h3>Pagar</h3></div>')).length, 0);
});

test('noInlineStyles — bloqueia style= em div', () => {
  const errors = noInlineStyles(tmpl('<div style="color:red">Pagar</div>'));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'noInlineStyles');
  assert.match(errors[0].message, /style=/i);
});

test('noInlineStyles — bloqueia style= em qualquer tag', () => {
  const errors = noInlineStyles(tmpl('<button style="background:blue">OK</button>'));
  assert.ok(errors.some(e => e.rule === 'noInlineStyles'));
});

test('noInlineStyles — retorna vazio quando html é null', () => {
  assert.equal(noInlineStyles(tmpl(null)).length, 0);
});
