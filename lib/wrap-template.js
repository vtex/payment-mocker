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

const wrapperRuntimeSource = require('./wrapper-runtime');

function escapeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function parseI18nFile(file) {
  return JSON.parse(file.text);
}

function wrapTemplate(bundle, defaultLocale) {
  const locales = {};
  for (const [locale, file] of Object.entries(bundle.i18n)) {
    locales[locale] = parseI18nFile(file);
  }

  const i18nPayload = escapeJsonForScript({
    locales,
    defaultLocale,
  });

  const csp = [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self' data:",
    "script-src 'unsafe-inline'",
  ].join('; ');

  const runtime = wrapperRuntimeSource();

  return [
    '<!doctype html>',
    '<html lang="' + defaultLocale + '">',
    '<head>',
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
    '<meta charset="utf-8">',
    '<link rel="stylesheet" href="style.css">',
    '<script type="application/json" id="payment-template-i18n">' + i18nPayload + '</script>',
    '<script>' + runtime + '</script>',
    '</head>',
    '<body>',
    bundle.html.text.trim(),
    '</body>',
    '</html>',
  ].join('\n');
}

module.exports = {
  wrapTemplate,
};
