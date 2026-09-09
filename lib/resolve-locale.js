'use strict';

/**
 * Resolves a requested locale tag against the set of locales a bundle ships.
 *
 * Parity: this is the single source of truth for locale resolution. Its source
 * text is embedded verbatim (via Function#toString) into the runtime script
 * injected by wrapper-runtime.js, so it must stay self-contained (no closures
 * over variables outside its own parameters/body) to remain valid once inlined
 * into the wrapped document.
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

// Dual-consumed: required as a CommonJS module by wrap-template.js (which
// inlines resolveLocale.toString() into the iframe runtime) and by
// preview-config.js/tests, AND served verbatim as a plain <script src> by
// preview-middleware.js's /lib/resolve-locale.js route for
// src/assets/libs/template-host.js (which runs in the host page, not inside
// the sandboxed bundle iframe, so it can't `require()` this file). In a
// browser <script> tag there is no `module`, so guard the assignment instead
// of assuming a CommonJS environment.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveLocale };
} else {
  this.resolveLocale = resolveLocale;
}
