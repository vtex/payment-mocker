'use strict';

/**
 * Builds the wrapped HTML document served inside the checkout preview iframe.
 *
 * Parity: this wrap must stay aligned with the production checkout host contract
 * (CSP meta, separated i18n JSON block, injected runtime for locale + height).
 *
 * Maintenance: while the upload handler is still in development, this module is
 * the local source of truth for wrap behavior. Medium-term, extract
 * wrap-template and wrapper-runtime into a shared package
 * (@vtex/payment-template-wrap-runtime) consumed by the handler and this repo.
 * Until then, mirror any contract change here in the handler (or vice versa).
 */

const crypto = require('crypto');
const wrapperRuntimeSource = require('./wrapper-runtime');
const { isValidLocaleTag } = require('./locale-tag');
const { ORIGIN_PATTERN } = require('./origin-pattern');

// Shared with preview-middleware.js via lib/origin-pattern.js: this is a
// redundant, defense-in-depth re-validation (see wrapTemplate below), so it
// must accept the same shapes, including an IPv6 literal in bracket notation
// (e.g. `http://[::1]:8080`) — otherwise a valid caller-supplied origin that
// already passed the caller's own check gets silently downgraded to 'self'
// here instead. Both call sites now import the same regex instead of keeping
// independently-maintained copies in sync by hand.

function escapeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function parseI18nFile(file) {
  return JSON.parse(file.text);
}

function wrapTemplate(bundle, defaultLocale, origin) {
  if (!isValidLocaleTag(defaultLocale)) {
    throw new Error('defaultLocale must match ^[a-z]{2}-[A-Z]{2}$.');
  }

  const locales = {};
  for (const [locale, file] of Object.entries(bundle.i18n)) {
    locales[locale] = parseI18nFile(file);
  }

  const i18nPayload = escapeJsonForScript({
    locales,
    defaultLocale,
  });

  const nonce = crypto.randomBytes(16).toString('base64');

  // The iframe is sandboxed with `allow-scripts` but not `allow-same-origin`,
  // so the document's origin is opaque and 'self' never matches it per the
  // CSP spec. When the caller can supply a concrete origin (e.g. the dev
  // server's own host), use that instead; fall back to 'self' otherwise so
  // other callers keep working.
  //
  // `origin` is validated again here, redundantly with the caller (e.g.
  // preview-middleware's requestOrigin, which derives it from attacker-
  // controlled request headers): this function interpolates it unescaped
  // into an HTML attribute, so an origin that doesn't look like a plain
  // `scheme://host[:port]` is treated as absent rather than trusted.
  const validOrigin = typeof origin === 'string' && ORIGIN_PATTERN.test(origin) ? origin : undefined;
  const styleSrc = validOrigin ? validOrigin : "'self'";
  const imgSrc = validOrigin ? validOrigin + ' data:' : "'self' data:";

  // style-src carries 'unsafe-inline' so templates can use style="..." freely;
  // script-src does NOT and never should, under any circumstance — nonce-only
  // is the one control that actually matters here. `style="..."` cannot
  // execute JavaScript (the only real XSS vector is `<script>`, which the
  // nonce above already locks down), so allowing inline style doesn't reopen
  // that door. The residual risk of free-form style — exfiltrating data via
  // CSS, e.g. a `background: url(https://attacker...)` that leaks state
  // through which rule matched — is blocked independently of this flag: both
  // img-src and style-src stay scoped to the origin (or 'self') + data: above,
  // so 'unsafe-inline' changes what a style attribute may *apply*, never what
  // it's allowed to *fetch*.
  const csp = [
    "default-src 'none'",
    'style-src ' + styleSrc + " 'unsafe-inline'",
    'img-src ' + imgSrc,
    "script-src 'nonce-" + nonce + "'",
  ].join('; ');

  const runtime = wrapperRuntimeSource();

  return [
    '<!doctype html>',
    '<html lang="' + defaultLocale + '">',
    '<head>',
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
    '<meta charset="utf-8">',
    '<link rel="stylesheet" href="style.css">',
    '<script type="application/json" id="payment-template-i18n" nonce="' +
      nonce +
      '">' +
      i18nPayload +
      '</script>',
    '<script nonce="' + nonce + '">' + runtime + '</script>',
    '</head>',
    '<body>',
    bundle.html.text.trim(),
    '</body>',
    '</html>',
  ].join('\n');
}

module.exports = {
  wrapTemplate,
  escapeJsonForScript,
};
