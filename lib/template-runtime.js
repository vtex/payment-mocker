'use strict';

/**
 * Runtime loaded inside the wrapped template iframe.
 *
 * This is a plain browser script, served verbatim by preview-middleware.js at
 * /lib/template-runtime.js and loaded with <script src>. It is NOT a Node
 * module and must never be pulled in through Node's module system: keeping it
 * a real, servable file is what lets the checkout host (vcs.checkout-ui)
 * vendor a byte-for-byte copy and have CI on both sides compare the two files.
 *
 * Load order matters. This script depends on the global `resolveLocale`
 * defined by lib/resolve-locale.js, which the wrapped document loads in a
 * <script src="/lib/resolve-locale.js"> tag placed BEFORE this one. Classic
 * scripts execute in document order, so the dependency is satisfied by
 * ordering alone — no bundler, no build step, and no second copy of the locale
 * resolution algorithm (the host page loads that same file for its own use).
 *
 * Responsibilities: locale resolution (exact tag -> language prefix ->
 * defaultLocale), applying data-i18n text, reactive height via ResizeObserver,
 * postMessage({ height }) to the host, listening for postMessage({ locale })
 * from the host, and reporting a fixed set of diagnostic codes to the host (see
 * "Diagnostics" below).
 *
 * Responsive layout is deliberately NOT among them. A template's own
 * `@media (width)` queries resolve against this iframe — the box the payment
 * step granted it — which is the only width its layout depends on, so it needs
 * nothing from the host to adapt. See "Responsive layout" in
 * template/CONTRACT.md.
 */
(function () {
  // Diagnostics.
  //
  // Three failures inside this document are invisible from the outside: the
  // stylesheet not applying, the measured container being absent, and an
  // unparseable i18n payload. The frame still loads and the height handshake
  // still succeeds, so nothing in the host's failure detection fires and the
  // shopper is left with a broken template while production stays quiet.
  //
  // `console` cannot reach production: the document's CSP is `default-src
  // 'none'` with no `connect-src`, so no beacon, fetch or XHR can leave this
  // frame. postMessage to the parent is the only channel that exists, and the
  // host owns the Splunk pipeline. Hence this one-way iframe -> host report.
  //
  // The payload carries a code from the closed set below and NOTHING else. No
  // exception message, no textContent, no markup or CSS excerpt: all of those
  // are partner-controlled, and the host must never be handed partner data it
  // then has to decide what to do with. The host already knows which template
  // it mounted, so the code alone is enough to act on.
  //
  // The host keeps its own copy of this list and validates against it, so a
  // code added here is ignored there until both sides are updated. That is the
  // intended failure mode — drop the unknown, never trust the string.
  var DIAGNOSTIC_MESSAGE_TYPE = 'payment-template:diagnostic';
  var DIAGNOSTIC_STYLESHEET_NOT_APPLIED = 'stylesheetNotApplied';
  var DIAGNOSTIC_CONTAINER_MISSING = 'containerMissing';
  var DIAGNOSTIC_I18N_PAYLOAD_INVALID = 'i18nPayloadInvalid';

  // Target origin for every message this document posts to its host.
  //
  // This script runs INSIDE the sandboxed frame, whose origin is opaque, so it
  // cannot read the parent's origin itself — `window.parent.location` is a
  // cross-origin access and throws. The host is the side that knows its own
  // origin at assembly time, so it embeds it in the document as a hidden node,
  // exactly the way the i18n payload travels, and this reads it back.
  //
  // The node is absent in the local preview (payment-mocker serves the document
  // itself and has no real host), so '*' stays the fallback. That remains safe:
  // the payload is a closed set carrying no sensitive data (see "Diagnostics"
  // above and checkout-ui invariant SEC-12).
  //
  // The value is pattern-checked, never trusted as-is: a malformed one would end
  // up as a targetOrigin the browser rejects, silently dropping every message.
  var HOST_ORIGIN_REGEX = /^https?:\/\/[^\s/]+$/;
  var cachedHostTargetOrigin = null;
  function getHostTargetOrigin() {
    if (cachedHostTargetOrigin !== null) return cachedHostTargetOrigin;
    var node = document.querySelector('[data-payment-template-host-origin]');
    var origin = '*';
    if (node) {
      try {
        var parsed = JSON.parse(node.textContent);
        if (typeof parsed === 'string' && HOST_ORIGIN_REGEX.test(parsed)) {
          origin = parsed;
        }
      } catch (e) {
        // Malformed payload: keep '*'. Same stance as the i18n table — a bad
        // value must not stop the document from talking to its host at all.
      }
    }
    cachedHostTargetOrigin = origin;
    return origin;
  }

  var reportedDiagnostics = {};
  function reportDiagnostic(code) {
    // Once per code per document: the container check runs on every
    // ResizeObserver tick and on every host measure request, so an unguarded
    // report would flood the host's telemetry with one row per frame.
    if (reportedDiagnostics[code]) return;
    reportedDiagnostics[code] = true;
    if (!window.parent || window.parent === window) return;
    // Addressed to the host's real origin when the host assembled this document
    // (checkout-ui); '*' only where no host origin node was embedded, i.e. the
    // local preview.
    window.parent.postMessage(
      { type: DIAGNOSTIC_MESSAGE_TYPE, code: code },
      getHostTargetOrigin()
    );
  }

  var EMPTY_I18N = { locales: {}, defaultLocale: 'en-US' };
  var i18nPayloadInvalidLogged = false;
  function parseData() {
    // Located by the stable data attribute, not the id: the id is dynamic in
    // the production host. The payload lives in a non-script element, so the
    // wrapped document has zero inline scripts and its CSP needs no nonce.
    var node = document.querySelector('[data-payment-template-i18n]');
    if (!node) return EMPTY_I18N;
    try {
      return JSON.parse(node.textContent);
    } catch (e) {
      // Without this guard the throw escapes boot(): no height is ever posted,
      // the handshake never completes, and the host only degrades to the static
      // method after the full 10s load timeout. Falling back to an empty table
      // keeps the document rendering — the partner's authored text stays in the
      // [data-i18n] elements — and turns a slow blank panel into a fast,
      // reported failure.
      //
      // `e.message` is deliberately not logged or reported: a JSON parse error
      // quotes the input that failed, and that input is partner content.
      if (!i18nPayloadInvalidLogged) {
        i18nPayloadInvalidLogged = true;
        console.error(
          '[payment-template] i18n payload is not valid JSON; translations will not be applied.'
        );
      }
      reportDiagnostic(DIAGNOSTIC_I18N_PAYLOAD_INVALID);
      return EMPTY_I18N;
    }
  }
  function lookup(obj, key) {
    return key.split('.').reduce(function (acc, part) {
      if (acc == null) return undefined;
      return acc[part];
    }, obj);
  }
  function applyLocale(localeTag) {
    var payload = parseData();
    var resolved = resolveLocale(localeTag, payload.locales, payload.defaultLocale);
    document.documentElement.lang = resolved;
    var table = payload.locales[resolved] || payload.locales[payload.defaultLocale] || {};
    document.querySelectorAll('[data-i18n]').forEach(function (node) {
      var key = node.getAttribute('data-i18n');
      if (!key) return;
      var value = lookup(table, key);
      if (typeof value === 'string') node.textContent = value;
    });
  }
  // The measured box is the wrap-provided container, whose display:flow-root
  // contains the first/last child margins. An author who writes e.g.
  // `div { display: block !important }` in their own style.css defeats that
  // and reintroduces margin collapse: a deliberate author override, not a bug.
  function findContainer() {
    return document.querySelector('[data-payment-template-root]');
  }
  var missingContainerLogged = false;
  function measureHeight() {
    var container = findContainer();
    if (!container) {
      // measureHeight() runs on every ResizeObserver tick and on every host
      // measure request, so log once instead of flooding the console.
      if (!missingContainerLogged) {
        missingContainerLogged = true;
        console.error('[payment-template] missing [data-payment-template-root] container; cannot measure height.');
      }
      reportDiagnostic(DIAGNOSTIC_CONTAINER_MISSING);
      return 0;
    }
    return Math.ceil(container.getBoundingClientRect().height);
  }
  var lastHeight = -1;
  function postHeight() {
    if (!window.parent || window.parent === window) return;
    var height = measureHeight();
    if (height === lastHeight) return;
    lastHeight = height;
    // Addressed to the host's real origin when the host assembled this document
    // (checkout-ui); '*' only where no host origin node was embedded, i.e. the
    // local preview.
    window.parent.postMessage({ height: height }, getHostTargetOrigin());
  }
  function schedulePostHeight() {
    requestAnimationFrame(function () {
      requestAnimationFrame(postHeight);
    });
  }
  function whenImagesReady(callback) {
    var images = Array.prototype.slice.call(document.images || []);
    if (!images.length) {
      callback();
      return;
    }
    var pending = 0;
    images.forEach(function (image) {
      if (image.complete) return;
      pending += 1;
      image.addEventListener('load', function onLoad() {
        image.removeEventListener('load', onLoad);
        pending -= 1;
        if (pending === 0) callback();
      });
      image.addEventListener('error', function onError() {
        image.removeEventListener('error', onError);
        pending -= 1;
        if (pending === 0) callback();
      });
    });
    if (pending === 0) callback();
  }
  // The wrapped document declares <link rel="stylesheet" href="style.css">,
  // resolved against the bundle's <base href>. When that sheet does not apply —
  // 404 at the bundle URL, blocked by the document's own style-src, or a
  // network failure — nothing else notices: the frame still loads, this runtime
  // still runs, the height handshake still succeeds, and the shopper simply
  // sees an unstyled template. Nothing in the host's failure detection covers
  // it, because the host never requests the stylesheet: the browser does, as a
  // subresource.
  //
  // `link.sheet` is the signal. A cross-origin sheet that loaded still exposes
  // the CSSStyleSheet object (only reading `cssRules` is restricted), so a null
  // here means it genuinely did not apply rather than merely being foreign.
  //
  // Checked at `load`, when subresources have settled: the <link> sits in
  // <head> above this script, so attaching an error listener from here could
  // miss an event that already fired.
  var stylesheetWarningLogged = false;
  function checkStylesheetApplied() {
    if (stylesheetWarningLogged) return;
    var link = document.querySelector('link[rel="stylesheet"]');
    if (!link) return;
    if (link.sheet) return;
    stylesheetWarningLogged = true;
    console.error(
      '[payment-template] stylesheet did not apply: ' +
        (link.href || 'style.css') +
        ' — the template is rendering unstyled. Likely causes: the file is ' +
        'missing from the bundle, the document CSP blocked it, or the request ' +
        'failed.'
    );
    // The console message above carries link.href for local debugging; the
    // reported payload carries only the code. The host composes the bundle URL
    // itself and does not need it echoed back from inside the frame.
    reportDiagnostic(DIAGNOSTIC_STYLESHEET_NOT_APPLIED);
  }
  function observeLayout() {
    if (typeof ResizeObserver !== 'function') return;
    var observer = new ResizeObserver(schedulePostHeight);
    var container = findContainer();
    // The container is what gets measured; body and body.firstElementChild
    // are now redundant with it. documentElement stays for viewport-driven
    // changes.
    if (container) observer.observe(container);
    if (document.documentElement) observer.observe(document.documentElement);
  }
  function boot() {
    var payload = parseData();
    applyLocale(payload.defaultLocale);
    window.addEventListener('message', function (event) {
      if (event.source !== window.parent) return;
      var data = event.data;
      if (!data) return;
      if (data.type === 'payment-template:measure') {
        lastHeight = -1;
        schedulePostHeight();
        return;
      }
      if (typeof data.locale === 'string') {
        applyLocale(data.locale);
        schedulePostHeight();
      }
    });
    observeLayout();
    schedulePostHeight();
    whenImagesReady(schedulePostHeight);
    window.addEventListener('load', function onLoad() {
      schedulePostHeight();
      checkStylesheetApplied();
    });
    // `load` may already have fired by the time this runs (the runtime is a
    // classic script, but boot() can be deferred to DOMContentLoaded).
    if (document.readyState === 'complete') checkStylesheetApplied();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
