'use strict';

/**
 * Resolves a requested locale tag against the set of locales a bundle ships.
 *
 * Parity: this is the single source of truth for locale resolution. The file
 * is served verbatim as a plain browser script and loaded by BOTH the host
 * page and the wrapped iframe document, so it must stay self-contained (no
 * closures over variables outside its own parameters/body, no imports) and
 * must keep defining a global `resolveLocale` — lib/template-runtime.js
 * depends on that global, and vcs.checkout-ui vendors this file as-is.
 *
 * Tie-break: when several candidate locales share the requested language and
 * none of them is `defaultLocale`, the candidate with the lowest alphabetical
 * tag wins (see CONTRACT.md, "Locale tags").
 */
function resolveLocale(requested, locales, defaultLocale) {
  var hasLocale = Object.prototype.hasOwnProperty;
  if (hasLocale.call(locales, requested)) return requested;
  var lang = requested.split('-')[0];
  var matches = Object.keys(locales).filter(function (tag) {
    return tag === lang || tag.indexOf(lang + '-') === 0;
  });
  matches.sort();
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    var defaultLang = defaultLocale.split('-')[0];
    if (defaultLang === lang && hasLocale.call(locales, defaultLocale)) return defaultLocale;
    return matches[0];
  }
  return defaultLocale;
}

// Dual-consumed: required as a CommonJS module by preview-config.js and the
// tests, AND served verbatim as a plain <script src> by
// preview-middleware.js's /lib/resolve-locale.js route to two browser
// consumers — src/assets/libs/template-host.js in the host page, and
// lib/template-runtime.js inside the sandboxed bundle iframe (neither can
// `require()` this file). In a browser <script> tag there is no `module`, so
// guard the assignment instead of assuming a CommonJS environment.
//
// Written longhand (`resolveLocale: resolveLocale`), not as an ES6 shorthand.
// This branch only ever RUNS under Node, but the whole file has to PARSE in
// every browser that loads it as a plain <script src> — and IE11 / legacy
// EdgeHTML reject shorthand property syntax at parse time, which kills the
// script before a single line executes and takes the global `resolveLocale`
// (and therefore lib/template-runtime.js) down with it.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveLocale: resolveLocale };
} else {
  this.resolveLocale = resolveLocale;
}
