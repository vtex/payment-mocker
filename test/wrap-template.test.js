'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeJsonForHtmlText,
  wrapTemplate,
  RESOLVE_LOCALE_SCRIPT,
  TEMPLATE_RUNTIME_SCRIPT,
} = require('../lib/wrap-template');
const {
  RESOLVE_LOCALE_SCRIPT_PATH,
  TEMPLATE_RUNTIME_SCRIPT_PATH,
} = require('../lib/preview-middleware');

function makeBundle() {
  return {
    html: { text: '<p data-i18n="pay.title"></p>' },
    i18n: {
      'en-US': { text: '{"pay":{"title":"Pay"}}' },
    },
  };
}

// Decodes the character references an HTML parser would resolve in an
// element's text content, so the tests can check the round trip the runtime
// actually performs: parser -> textContent -> JSON.parse.
function decodeHtmlText(text) {
  return text.replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

test('escapeJsonForHtmlText serializes a plain object as JSON', () => {
  const result = escapeJsonForHtmlText({ a: 1, b: 'two' });
  assert.equal(result, '{"a":1,"b":"two"}');
});

test('escapeJsonForHtmlText neutralizes markup so the payload cannot break out of its element', () => {
  const result = escapeJsonForHtmlText({ payload: '</div><script>alert(1)</script>' });
  assert.ok(!result.includes('<'), 'no raw "<" may remain: inside a <div> the content is parsed as HTML');
  assert.ok(result.includes('&lt;'));
  assert.deepEqual(JSON.parse(decodeHtmlText(result)), { payload: '</div><script>alert(1)</script>' });
});

test('escapeJsonForHtmlText escapes & so an entity in the data survives HTML parsing intact', () => {
  // The payload now lives in element text content, not raw <script> text, so
  // `&` is a metacharacter: left unescaped, `&amp;` in the data would come
  // back out of the parser as `&`, and `&lt;` as `<`, silently corrupting the
  // JSON (and, with a crafted value, forging markup).
  const value = { text: 'Tom &amp; Jerry &lt;b&gt; & co' };
  const result = escapeJsonForHtmlText(value);
  assert.ok(!/&(?!amp;|lt;)/.test(result), 'every raw "&" must be escaped as &amp;');
  assert.deepEqual(JSON.parse(decodeHtmlText(result)), value, 'the payload must survive the parser round trip byte for byte');
});

test('escapeJsonForHtmlText escapes U+2028/U+2029 line terminators', () => {
  const lineSeparator = String.fromCharCode(0x2028);
  const paragraphSeparator = String.fromCharCode(0x2029);
  const result = escapeJsonForHtmlText({ text: lineSeparator + paragraphSeparator });
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

test('wrapTemplate emits exactly two external scripts and no inline script at all', () => {
  const html = wrapTemplate(makeBundle(), 'en-US', 'http://localhost:8080');
  const scriptTags = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(scriptTags.length, 2, 'exactly the two external scripts');
  for (const tag of scriptTags) {
    assert.match(tag, /\ssrc="/, 'every script tag must load an external file');
  }
  // Zero inline script content is the precondition for dropping the nonce:
  // any <script> whose body is not empty would silently stop executing under
  // the nonce-less CSP (or, worse, invite bringing 'unsafe-inline' back).
  const inlineBodies = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(inlineBodies.length, 2, 'both script tags must be properly closed');
  for (const bodyText of inlineBodies) {
    assert.equal(bodyText.trim(), '', 'no <script> may carry inline content');
  }
  assert.ok(!html.includes('nonce'), 'the nonce is gone along with the inline scripts');
});

test('wrapTemplate loads /lib/resolve-locale.js before the runtime that depends on it', () => {
  const html = wrapTemplate(makeBundle(), 'en-US', 'http://localhost:8080');
  const resolveLocaleAt = html.indexOf('<script src="' + RESOLVE_LOCALE_SCRIPT + '">');
  const runtimeAt = html.indexOf('<script src="' + TEMPLATE_RUNTIME_SCRIPT + '">');
  assert.ok(resolveLocaleAt > -1, 'the wrapped document must load resolve-locale.js');
  assert.ok(runtimeAt > -1, 'the wrapped document must load the runtime');
  // Classic scripts run in document order and the runtime calls the global
  // resolveLocale at boot, so this order is a correctness requirement.
  assert.ok(resolveLocaleAt < runtimeAt, 'resolve-locale.js must come first');
});

test('the script URLs the wrap emits are the ones the preview middleware actually serves', () => {
  // Two independent constants, one contract: a rename on either side would
  // otherwise ship a document whose scripts 404 (and, with the path-scoped
  // CSP, would not even be allowed to load).
  assert.equal(RESOLVE_LOCALE_SCRIPT, RESOLVE_LOCALE_SCRIPT_PATH);
  assert.equal(TEMPLATE_RUNTIME_SCRIPT, TEMPLATE_RUNTIME_SCRIPT_PATH);
});

test('wrapTemplate CSP restricts script-src to the /lib/ directory, not the whole origin', () => {
  // THE security invariant of this policy. The bundle's own static route sits
  // on the same origin and serves .js, so an origin-wide script-src would let
  // a partner ship `<script src="asset-evil.js">` (resolving to
  // /template-bundle/asset-evil.js) and have it EXECUTE. Scoping to /lib/
  // keeps only this server's own two scripts runnable.
  const html = wrapTemplate(makeBundle(), 'en-US', 'http://localhost:8080');
  const scriptSrcMatch = html.match(/script-src ([^;"]+)/);
  assert.ok(scriptSrcMatch, 'CSP must include a script-src directive');
  const scriptSrc = scriptSrcMatch[1].trim();
  assert.equal(scriptSrc, 'http://localhost:8080/lib/');
  assert.ok(scriptSrc.endsWith('/lib/'), 'script-src must be path-scoped to /lib/, never the bare origin');
  assert.ok(!html.includes("script-src 'unsafe-inline'"));
  assert.ok(!/script-src [^;"]*'nonce-/.test(html), 'no nonce: the document has no inline scripts to authorize');
});

test('wrapTemplate CSP script-src falls back to \'self\' when no origin is given', () => {
  // Documented consequence: the iframe is sandboxed without allow-same-origin,
  // so 'self' matches nothing and the runtime will not load. Callers that want
  // a working preview must pass a real origin.
  const html = wrapTemplate(makeBundle(), 'en-US');
  assert.match(html, /script-src 'self'/);
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

test('wrapTemplate wraps the partner HTML in the measured flow-root container', () => {
  const html = wrapTemplate(makeBundle(), 'en-US');

  // `display:flow-root` is the height fix, not styling: it keeps the first/last
  // child's vertical margins inside the box the runtime measures instead of
  // letting them collapse out of it and cut content off.
  assert.match(
    html,
    /<div id="template-root" data-payment-template-root style="display:flow-root">\s*<p data-i18n="pay\.title"><\/p>\s*<\/div>/,
    'the container must carry display:flow-root and directly enclose the partner HTML'
  );
  // The runtime's hook is the attribute, never the id (the id is dynamic in
  // production), so the attribute must be present regardless of the id value.
  assert.ok(html.includes('data-payment-template-root'));
  // Cosmetic only — drops the UA's default body margin (8px).
  assert.ok(html.includes('<body style="margin:0;padding:0">'), 'body must zero the UA margin/padding');
  // The container must live inside body, not beside it. (Match the opening
  // tag itself: the selector string also appears inside the runtime script in
  // <head>, so a bare indexOf of the attribute name would find that first.)
  const containerAt = html.indexOf('<div id="template-root" data-payment-template-root');
  assert.ok(containerAt > html.indexOf('<body'), 'the container must come after <body>');
  assert.ok(containerAt < html.indexOf('</body>'), 'the container must come before </body>');
});

test('wrapTemplate carries the i18n payload in a non-script element the runtime can find by attribute', () => {
  const html = wrapTemplate(makeBundle(), 'en-US', 'http://localhost:8080');
  const i18nTag = html.match(/<div id="payment-template-i18n"[^>]*>/);
  assert.ok(i18nTag, 'the payload must live in a <div>, not a <script>');
  assert.match(i18nTag[0], /\sdata-payment-template-i18n\b/, 'the runtime looks it up by this stable attribute');
  assert.match(i18nTag[0], /\shidden\b/, 'the payload element must not render');
  // `hidden` alone is a UA rule a partner's `div { display: block }` would
  // beat, dumping the JSON on screen; the inline style outranks author CSS.
  assert.match(i18nTag[0], /style="display:none"/, 'the payload must stay hidden against partner CSS');
  assert.ok(!/<script[^>]*type="application\/json"/.test(html), 'the old inline JSON script must be gone');

  // The payload itself must still be readable as JSON after the parser
  // resolves character references into textContent.
  const payload = html.match(/<div id="payment-template-i18n"[^>]*>([\s\S]*?)<\/div>/)[1];
  const parsed = JSON.parse(decodeHtmlText(payload));
  assert.equal(parsed.defaultLocale, 'en-US');
  assert.deepEqual(parsed.locales['en-US'], { pay: { title: 'Pay' } });
});

test('wrapTemplate keeps the partner HTML verbatim inside the container', () => {
  // Nothing about the partner fragment may be parsed or rewritten: only the
  // pre-existing .trim() applies.
  const fragment = '  <div class="a" data-x="1">  <span>&amp; keep <!-- me --></span>\n</div>  ';
  const html = wrapTemplate({ html: { text: fragment }, i18n: { 'en-US': { text: '{}' } } }, 'en-US');
  assert.ok(html.includes('>\n' + fragment.trim() + '\n</div>'), 'the fragment must appear untouched inside the container');
  assert.equal(html.split(fragment.trim()).length - 1, 1, 'the fragment must appear exactly once');
});

test('wrapTemplate rejects an origin containing a double quote even without other markup', () => {
  const html = wrapTemplate(makeBundle(), 'en-US', 'http://localhost"onmouseover="alert(1)');
  assert.ok(!html.includes('onmouseover'));
  assert.ok(html.includes("style-src 'self'"));
});
