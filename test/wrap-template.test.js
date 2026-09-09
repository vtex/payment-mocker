'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeJsonForScript, wrapTemplate } = require('../lib/wrap-template');

function makeBundle() {
  return {
    html: { text: '<p data-i18n="pay.title"></p>' },
    i18n: {
      'en-US': { text: '{"pay":{"title":"Pay"}}' },
    },
  };
}

test('escapeJsonForScript serializes a plain object as JSON', () => {
  const result = escapeJsonForScript({ a: 1, b: 'two' });
  assert.equal(result, '{"a":1,"b":"two"}');
});

test('escapeJsonForScript neutralizes a closing </script> sequence', () => {
  const result = escapeJsonForScript({ payload: '</script><script>alert(1)</script>' });
  assert.ok(!result.includes('<'), 'no raw "<" should remain in the escaped output');
  assert.ok(result.includes('\\u003c'));
});

test('escapeJsonForScript escapes U+2028/U+2029 line terminators', () => {
  const lineSeparator = String.fromCharCode(0x2028);
  const paragraphSeparator = String.fromCharCode(0x2029);
  const result = escapeJsonForScript({ text: lineSeparator + paragraphSeparator });
  assert.ok(!result.includes(lineSeparator));
  assert.ok(!result.includes(paragraphSeparator));
  assert.ok(result.includes('\\u2028'));
  assert.ok(result.includes('\\u2029'));
});

test('wrapTemplate rejects a defaultLocale that does not match the locale-tag format', () => {
  // 'pt' is a language-only tag (no region), which CONTRACT.md's
  // ^[a-z]{2}-[A-Z]{2}$ format explicitly rejects.
  assert.throws(() => wrapTemplate(makeBundle(), 'pt'), /defaultLocale must match/);
});

test('wrapTemplate rejects a defaultLocale with the wrong case (region before language)', () => {
  assert.throws(() => wrapTemplate(makeBundle(), 'PT-br'), /defaultLocale must match/);
});

test('wrapTemplate embeds one nonce and reuses it on both <script> tags', () => {
  const html = wrapTemplate(makeBundle(), 'en-US', 'http://localhost:8080');
  const nonces = [...html.matchAll(/<script[^>]*\snonce="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(nonces.length, 2, 'both the i18n data script and the runtime script must carry a nonce');
  assert.equal(nonces[0], nonces[1], 'the nonce must be identical on both tags');
  assert.ok(nonces[0].length > 0);
});

test('wrapTemplate CSP script-src never allows unsafe-inline, only the nonce', () => {
  // This is the real security invariant: script-src staying nonce-only is
  // what keeps <script> injection locked down. style-src is deliberately
  // allowed 'unsafe-inline' (see the CSP-construction comment in
  // wrap-template.js) since style="..." cannot execute JavaScript, so this
  // guard must check script-src specifically, not the whole document.
  const html = wrapTemplate(makeBundle(), 'en-US', 'http://localhost:8080');
  assert.ok(!html.includes("script-src 'unsafe-inline'"));
  const scriptSrcMatch = html.match(/script-src ([^;"]+)/);
  assert.ok(scriptSrcMatch, 'CSP must include a script-src directive');
  assert.match(scriptSrcMatch[1].trim(), /^'nonce-[^']+'$/, 'script-src must contain only the nonce token, nothing else');
});

test('wrapTemplate CSP style-src allows unsafe-inline (templates may use style="..." freely)', () => {
  const html = wrapTemplate(makeBundle(), 'en-US', 'http://localhost:8080');
  assert.ok(html.includes("style-src http://localhost:8080 'unsafe-inline'"));
});

test('wrapTemplate CSP scopes style-src/img-src to the given origin', () => {
  const html = wrapTemplate(makeBundle(), 'en-US', 'http://localhost:8080');
  assert.ok(html.includes('style-src http://localhost:8080'));
  assert.ok(html.includes('img-src http://localhost:8080 data:'));
});

test('wrapTemplate CSP falls back to \'self\' when no origin is given', () => {
  const html = wrapTemplate(makeBundle(), 'en-US');
  assert.ok(html.includes("style-src 'self' 'unsafe-inline'"));
  assert.ok(html.includes("img-src 'self' data:"));
});

test('wrapTemplate rejects a hostile origin (e.g. a spoofed Host header) instead of interpolating it raw', () => {
  // A crafted `Host`/`x-forwarded-proto` value could otherwise close the CSP
  // meta tag's `content="..."` attribute and inject executable markup.
  const hostileOrigin = 'x; script-src \'unsafe-inline\'"><script>alert(1)</script><b y="';
  const html = wrapTemplate(makeBundle(), 'en-US', hostileOrigin);

  assert.ok(!html.includes('<script>alert(1)</script>'), 'the raw hostile payload must not appear unescaped');
  assert.ok(!html.includes('"><script>'), 'the origin must not be able to break out of the content attribute');
  // A rejected origin falls back to the same 'self' behavior as no origin.
  assert.ok(html.includes("style-src 'self'"));
  assert.ok(html.includes("img-src 'self' data:"));
});

test('wrapTemplate rejects an origin containing a double quote even without other markup', () => {
  const html = wrapTemplate(makeBundle(), 'en-US', 'http://localhost"onmouseover="alert(1)');
  assert.ok(!html.includes('onmouseover'));
  assert.ok(html.includes("style-src 'self'"));
});
