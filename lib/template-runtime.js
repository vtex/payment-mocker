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
 * postMessage({ height }) to the host, and listening for postMessage({ locale })
 * from the host.
 *
 * Responsive layout is deliberately NOT among them. A template's own
 * `@media (width)` queries resolve against this iframe — the box the payment
 * step granted it — which is the only width its layout depends on, so it needs
 * nothing from the host to adapt. See "Responsive layout" in
 * template/CONTRACT.md.
 */
(function () {
  function parseData() {
    // Located by the stable data attribute, not the id: the id is dynamic in
    // the production host. The payload lives in a non-script element, so the
    // wrapped document has zero inline scripts and its CSP needs no nonce.
    var node = document.querySelector('[data-payment-template-i18n]');
    if (!node) return { locales: {}, defaultLocale: 'en-US' };
    return JSON.parse(node.textContent);
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
    window.parent.postMessage({ height: height }, '*');
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
    window.addEventListener('load', schedulePostHeight);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
