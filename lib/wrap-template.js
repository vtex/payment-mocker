'use strict';

/**
 * Builds the wrapped HTML document served inside the checkout preview iframe.
 *
 * Parity: this wrap must stay aligned with the production checkout host contract
 * (CSP meta, separated i18n data block, external runtime for locale + height).
 * The document deliberately contains ZERO inline scripts: both scripts are
 * <script src> tags pointing at files this server serves from /lib/, which is
 * what lets the CSP drop the nonce (see the CSP construction below) and lets
 * vcs.checkout-ui vendor those files byte for byte.
 *
 * Maintenance: while the upload handler is still in development, this module is
 * the local source of truth for wrap behavior. Medium-term, extract
 * wrap-template and template-runtime into a shared package
 * (@vtex/payment-template-wrap-runtime) consumed by the handler and this repo.
 * Until then, mirror any contract change here in the handler (or vice versa).
 */

const { isValidLocaleTag } = require('./locale-tag');
const { ORIGIN_PATTERN } = require('./origin-pattern');

// Must stay in sync with the routes preview-middleware.js serves
// (RESOLVE_LOCALE_SCRIPT_PATH / TEMPLATE_RUNTIME_SCRIPT_PATH) and with
// SCRIPT_DIRECTORY below; test/wrap-template.test.js asserts the match.
const SCRIPT_DIRECTORY = '/lib/';
const RESOLVE_LOCALE_SCRIPT = SCRIPT_DIRECTORY + 'resolve-locale.js';
const TEMPLATE_RUNTIME_SCRIPT = SCRIPT_DIRECTORY + 'template-runtime.js';

// Shared with preview-middleware.js via lib/origin-pattern.js: this is a
// redundant, defense-in-depth re-validation (see wrapTemplate below), so it
// must accept the same shapes, including an IPv6 literal in bracket notation
// (e.g. `http://[::1]:8080`) — otherwise a valid caller-supplied origin that
// already passed the caller's own check gets silently downgraded to 'self'
// here instead. Both call sites now import the same regex instead of keeping
// independently-maintained copies in sync by hand.

/**
 * Serializes the i18n payload for embedding as the TEXT CONTENT of a normal
 * HTML element (a <div>), not as the raw text of a <script>.
 *
 * That distinction drives the escaping. Inside <script> the content is raw
 * text and only `</script`-style sequences matter, so escaping `<` was enough.
 * Inside a <div> the content is parsed as HTML, so both HTML metacharacters
 * must be neutralized: `&` first (otherwise the `&` introduced by the `<`
 * escape below would itself be double-escaped) and then `<`. Both replacements
 * produce character references that the HTML parser turns back into the exact
 * original characters in `textContent`, so what JSON.parse() sees on the other
 * side is byte-identical JSON.
 *
 * U+2028/U+2029 stay JSON-escaped: harmless here, but it keeps the payload
 * safe to move back into a JS context without another escaping review.
 */
function escapeJsonForHtmlText(value) {
  return JSON.stringify(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
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

  const i18nPayload = escapeJsonForHtmlText({
    locales,
    defaultLocale,
  });

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

  // script-src is scoped to the /lib/ DIRECTORY of this server, never to the
  // bare origin, and that path is the whole point of the directive — do not
  // "simplify" it to just the origin. The bundle's own static route lives on
  // the same origin and happily serves `.js` (see the MIME map in
  // preview-middleware.js), so an origin-wide script-src would let a partner's
  // `<script src="asset-evil.js">` resolve to /template-bundle/asset-evil.js
  // and EXECUTE. Restricting to /lib/ keeps the property the previous
  // nonce-only policy had: only files this server itself serves from /lib/
  // (resolve-locale.js and template-runtime.js) can run.
  //
  // The nonce is gone because the document now has zero inline scripts. When
  // no valid origin is available we keep 'self' for consistency with
  // style-src/img-src, but note the consequence: the iframe is sandboxed
  // without `allow-same-origin`, so its origin is opaque, 'self' matches
  // nothing, and the runtime simply does not load (no locale application, no
  // height reporting). Callers that need a working preview must pass a real
  // origin.
  const scriptSrc = validOrigin ? validOrigin + SCRIPT_DIRECTORY : "'self'";

  // style-src carries 'unsafe-inline' so templates can use style="..." freely;
  // script-src does NOT and never should, under any circumstance. `style="..."`
  // cannot execute JavaScript (the only real XSS vector is `<script>`, which
  // the path-scoped script-src above locks down), so allowing inline style
  // doesn't reopen that door. The residual risk of free-form style —
  // exfiltrating data via CSS, e.g. a `background: url(https://attacker...)`
  // that leaks state through which rule matched — is blocked independently of
  // this flag: both img-src and style-src stay scoped to the origin (or
  // 'self') + data: above, so 'unsafe-inline' changes what a style attribute
  // may *apply*, never what it's allowed to *fetch*.
  const csp = [
    "default-src 'none'",
    'style-src ' + styleSrc + " 'unsafe-inline'",
    'img-src ' + imgSrc,
    'script-src ' + scriptSrc,
  ].join('; ');

  return [
    '<!doctype html>',
    '<html lang="' + defaultLocale + '">',
    '<head>',
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
    '<meta charset="utf-8">',
    '<link rel="stylesheet" href="style.css">',
    // Two external scripts, in this order: resolve-locale.js defines the
    // global `resolveLocale`, template-runtime.js consumes it. Classic scripts
    // execute in document order, so ordering alone satisfies the dependency —
    // no bundler and no duplicated algorithm (the host page loads the same
    // resolve-locale.js for its own displayName resolution).
    '<script src="' + RESOLVE_LOCALE_SCRIPT + '"></script>',
    '<script src="' + TEMPLATE_RUNTIME_SCRIPT + '"></script>',
    '</head>',
    // The container below — not `body` — is what the injected runtime measures.
    //
    // `display:flow-root` on it is the actual height fix, NOT decoration: it
    // makes the container establish a block formatting context, so the first/
    // last child's vertical margins are contained instead of collapsing out of
    // it and disappearing from the measurement (which cut content off). Do not
    // "simplify" it away.
    //
    // The runtime finds this element by the `data-payment-template-root`
    // ATTRIBUTE, never by id. In production (checkout-ui) the id will be
    // dynamic (`template-root-{groupName}`, for debugging and to avoid
    // colliding with the partner's own ids, which CONTRACT.md does not
    // restrict) while the attribute stays stable. Here the id is static
    // (`template-root`) because the mocker serves one bundle at a time — and
    // `bundleDir` is deliberately NOT interpolated into it, to avoid putting
    // one more unvalidated value inside HTML.
    //
    // `margin:0;padding:0` on `body` is cosmetic only (it drops the UA's
    // default 8px); the measurement correctness comes from `flow-root` above.
    //
    // The inline `style="..."` is allowed because the CSP grants
    // 'unsafe-inline' to style-src only; script-src never gets it.
    '<body style="margin:0;padding:0">',
    // The i18n payload rides in a NON-script element so the document keeps
    // zero inline scripts (which is what lets the CSP drop the nonce). It
    // lives in <body> rather than <head> because a <div> in <head> is invalid
    // and the parser would relocate it anyway; `hidden` keeps it out of the
    // rendered box, and being a sibling of the container it never affects the
    // measured height. The runtime reads it via the stable
    // `data-payment-template-i18n` attribute, not the id — same reasoning as
    // the container below.
    // `hidden` is backed by an inline `display:none` on purpose: `hidden` is a
    // UA-stylesheet rule, so a partner's own `div { display: block }` in
    // style.css would beat it and dump the raw JSON on screen. The inline
    // style sits above author CSS (and still loses to `!important`, which
    // remains the author's deliberate choice, as with the container below).
    '<div id="payment-template-i18n" data-payment-template-i18n hidden style="display:none">' +
      i18nPayload +
      '</div>',
    '<div id="template-root" data-payment-template-root style="display:flow-root">',
    bundle.html.text.trim(),
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}

module.exports = {
  wrapTemplate,
  escapeJsonForHtmlText,
  RESOLVE_LOCALE_SCRIPT,
  TEMPLATE_RUNTIME_SCRIPT,
};
