'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { resolveLocale } = require('../lib/resolve-locale');
const { wrapTemplate } = require('../lib/wrap-template');

// The runtime is no longer a Node module that returns its own source as a
// string — it is a real browser script served at /lib/template-runtime.js, so
// the tests read the file exactly as the browser would receive it. Same for
// lib/resolve-locale.js, which the wrapped document loads as a separate script
// tag BEFORE the runtime; evaluating both in that order inside one vm context
// reproduces the document's actual load order and the global it depends on.
function readLibScript(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'lib', name), 'utf8');
}

function evaluateBrowserScripts(sandbox) {
  vm.runInContext(readLibScript('resolve-locale.js'), sandbox);
  vm.runInContext(readLibScript('template-runtime.js'), sandbox);
}

test('resolveLocale returns the exact tag when it is present', () => {
  const locales = { 'pt-BR': {}, 'en-US': {} };
  assert.equal(resolveLocale('pt-BR', locales, 'en-US'), 'pt-BR');
});

test('resolveLocale falls back to defaultLocale when no candidate shares the language', () => {
  const locales = { 'pt-BR': {}, 'en-US': {} };
  assert.equal(resolveLocale('fr-FR', locales, 'en-US'), 'en-US');
});

test('resolveLocale breaks ties between same-language candidates by alphabetical tag order', () => {
  // Neither candidate is the defaultLocale's language, so the tie-break must be
  // deterministic (lowest alphabetical tag), not dependent on object key order.
  const locales = { 'pt-PT': {}, 'pt-BR': {} };
  assert.equal(resolveLocale('pt-AO', locales, 'en-US'), 'pt-BR');
});

test('resolveLocale prefers defaultLocale over other same-language candidates', () => {
  const locales = { 'pt-PT': {}, 'pt-BR': {} };
  assert.equal(resolveLocale('pt-AO', locales, 'pt-BR'), 'pt-BR');
});

test('resolveLocale does not resolve to an inherited Object.prototype key', () => {
  // A naive `locales[requested]` truthiness check would find `Object.prototype.constructor`
  // for `requested === 'constructor'` even though `locales` has no own property by that name,
  // and would return 'constructor' instead of falling back to defaultLocale. The exact-match
  // check must use hasOwnProperty so only real, own locale keys can be returned as-is.
  const locales = { 'pt-BR': {} };
  assert.equal(resolveLocale('constructor', locales, 'pt-BR'), 'pt-BR');
});

/**
 * lib/resolve-locale.js documents that it must stay self-contained (no
 * closures over anything outside its own parameters/body) and must keep
 * defining a global `resolveLocale`, because it is served as a standalone
 * browser script and lib/template-runtime.js — which runs isolated inside the
 * sandboxed bundle iframe, where none of this repo's module scope exists —
 * calls that global. No test previously verified that promise: an edit that
 * referenced an outer variable, or that stopped exposing the global, would
 * pass all the resolveLocale unit tests above (they call the real, in-process
 * function directly) while throwing a ReferenceError in production.
 *
 * This builds a minimal DOM stub, evaluates the two real files in the same
 * order the wrapped document loads them, inside an isolated vm context with no
 * access to this file's scope, and fails if booting throws anything — a
 * ReferenceError in particular.
 */
test('the runtime runs without error in an isolated scope, over the global resolve-locale.js defines', () => {
  const elementStub = { style: {} };
  const containerStub = {
    style: {},
    getBoundingClientRect: function () {
      return { height: 0 };
    },
  };
  const documentStub = {
    readyState: 'complete', // skip the DOMContentLoaded listener path entirely
    documentElement: { style: {} },
    body: Object.assign({ firstElementChild: containerStub }, elementStub),
    images: [],
    querySelector: function (selector) {
      // No i18n node — parseData() falls back to its empty payload.
      return selector === '[data-payment-template-root]' ? containerStub : null;
    },
    querySelectorAll: function () {
      return [];
    },
  };

  const sandbox = {
    console,
    requestAnimationFrame: function (callback) {
      callback();
    },
  };
  sandbox.document = documentStub;
  sandbox.window = sandbox; // window.parent is then undefined, so postHeight() no-ops
  sandbox.addEventListener = function () {};

  vm.createContext(sandbox);
  assert.doesNotThrow(() => {
    evaluateBrowserScripts(sandbox);
  });
  assert.equal(typeof sandbox.resolveLocale, 'function', 'resolve-locale.js must expose the global the runtime calls');
});

test('the runtime throws in an isolated scope if resolve-locale.js was not loaded first', () => {
  // Guards the load-order contract itself: the wrapped document must emit
  // /lib/resolve-locale.js BEFORE /lib/template-runtime.js. Running the runtime
  // alone must fail loudly rather than appear to work.
  const sandbox = {
    console,
    requestAnimationFrame: function (callback) {
      callback();
    },
    document: {
      readyState: 'complete',
      documentElement: { style: {}, lang: '' },
      body: { style: {} },
      images: [],
      querySelector: function () {
        return null;
      },
      querySelectorAll: function () {
        return [];
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = function () {};

  vm.createContext(sandbox);
  assert.throws(
    () => {
      vm.runInContext(readLibScript('template-runtime.js'), sandbox);
    },
    // Not `assert.throws(fn, ReferenceError)`: the error comes from the vm's
    // own realm, so it fails an instanceof check against this realm's class.
    (error) => error.name === 'ReferenceError' && /resolveLocale/.test(error.message)
  );
});

/**
 * The isolated-scope test above only exercises parseData()'s early-return
 * branch (no i18n node), so resolveLocale's same-language tie-break — the
 * branch covered directly in the "breaks ties" and "prefers defaultLocale"
 * tests near the top of this file — never once ran inside the actual
 * vm-isolated copy that ships to the sandboxed bundle iframe. This stubs a
 * real [data-payment-template-i18n] node with two locales that share a
 * language (pt-BR/pt-PT) and drives a simulated postMessage locale switch
 * through the runtime's own "message" listener (registered via the
 * addEventListener stub below, unlike the no-op used above) to confirm the
 * tie-break also resolves correctly once actually isolated.
 */
test('the runtime resolves same-language ties in an isolated scope', () => {
  const i18nNode = {
    textContent: JSON.stringify({
      locales: { 'pt-BR': { greeting: 'Oi' }, 'pt-PT': { greeting: 'Ola' } },
      defaultLocale: 'en-US',
    }),
  };

  const documentElementStub = { style: {}, lang: '' };
  const containerStub = {
    style: {},
    getBoundingClientRect: function () {
      return { height: 0 };
    },
  };
  const documentStub = {
    readyState: 'complete',
    documentElement: documentElementStub,
    body: { style: {}, firstElementChild: containerStub },
    images: [],
    querySelector: function (selector) {
      if (selector === '[data-payment-template-i18n]') return i18nNode;
      return selector === '[data-payment-template-root]' ? containerStub : null;
    },
    querySelectorAll: function () {
      return [];
    },
  };

  // Unlike the no-op `addEventListener` above, this records listeners so the
  // test can simulate the host page's postMessage locale switch afterwards —
  // exercising the runtime's own "message" handler, not the resolveLocale
  // function directly.
  const messageListeners = [];
  const sandbox = {
    console,
    requestAnimationFrame: function (callback) {
      callback();
    },
  };
  sandbox.document = documentStub;
  sandbox.window = sandbox; // window.parent is then undefined, so postHeight() no-ops
  sandbox.addEventListener = function (type, listener) {
    if (type === 'message') messageListeners.push(listener);
  };

  vm.createContext(sandbox);
  evaluateBrowserScripts(sandbox);

  assert.equal(messageListeners.length, 1, 'boot() must register exactly one "message" listener');

  // Neither pt-BR nor pt-PT is en-US's language, so the tie-break must fall
  // to the lowest alphabetical tag (pt-BR), exactly like the direct
  // resolveLocale() unit tests above — but here going through the real,
  // isolated browser scripts via a simulated incoming postMessage.
  assert.doesNotThrow(() => {
    messageListeners[0]({ source: undefined, data: { locale: 'pt-AO' } });
  });
  assert.equal(documentElementStub.lang, 'pt-BR');
});

/**
 * Height-measurement guards for lib/template-runtime.js.
 *
 * The runtime no longer resets html/body at runtime: the wrap emits a
 * container (`[data-payment-template-root]`, `display:flow-root`) around the
 * partner's HTML, and the runtime measures THAT box. The container's block
 * formatting context is what keeps the first/last child's vertical margins
 * inside the measured height instead of collapsing out of it.
 *
 * Neither jsdom nor a plain vm context runs layout, so `getBoundingClientRect()`
 * cannot reflect margin collapse on its own; the tests below stub exactly that
 * one behavior and keep a DIFFERENT height on `document.body`, so a measurement
 * that regressed back to `body` produces a visibly wrong number instead of
 * passing by coincidence.
 */

const CONTAINER_SELECTOR = '[data-payment-template-root]';

function makeBox(height) {
  return {
    style: {},
    getBoundingClientRect: function () {
      return { height: height };
    },
  };
}

/**
 * Evaluates the real browser scripts (resolve-locale.js then
 * template-runtime.js, the document's own order) in an isolated vm context over
 * a minimal DOM stub, and exposes what the height tests need: the heights posted
 * to the parent, the ResizeObserver targets, the console.error calls, and a
 * `measure()` helper that drives a fresh measurement the same way the host page
 * does — a `postMessage({ type: 'payment-template:measure' })` from
 * `window.parent`, handled by boot()'s own "message" listener, which resets the
 * runtime's internal `lastHeight` and calls schedulePostHeight() -> postHeight()
 * -> measureHeight().
 */
function bootRuntime(options) {
  const opts = options || {};
  const container = 'container' in opts ? opts.container : makeBox(0);
  const bodyStub = Object.assign(makeBox('bodyHeight' in opts ? opts.bodyHeight : 0), {
    firstElementChild: container,
  });
  const documentElementStub = Object.assign(makeBox(0), { lang: '' });

  const documentStub = {
    readyState: 'complete',
    documentElement: documentElementStub,
    body: bodyStub,
    images: [],
    querySelector: function (selector) {
      return selector === CONTAINER_SELECTOR ? container : null;
    },
    querySelectorAll: function () {
      return [];
    },
  };

  const postedHeights = [];
  const fakeParent = {
    postMessage: function (data) {
      postedHeights.push(data.height);
    },
  };
  const messageListeners = [];
  const observed = [];
  const errors = [];

  const sandbox = {
    console: {
      error: function (message) {
        errors.push(message);
      },
      warn: function () {},
      log: function () {},
    },
    requestAnimationFrame: function (callback) {
      callback();
    },
    ResizeObserver: function () {
      this.observe = function (target) {
        observed.push(target);
      };
    },
  };
  sandbox.document = documentStub;
  sandbox.window = sandbox;
  sandbox.window.parent = fakeParent; // distinct from `window` so postHeight() doesn't no-op
  sandbox.addEventListener = function (type, listener) {
    if (type === 'message') messageListeners.push(listener);
  };

  vm.createContext(sandbox);
  evaluateBrowserScripts(sandbox);

  assert.equal(messageListeners.length, 1, 'boot() must register exactly one "message" listener');

  return {
    container: container,
    bodyStub: bodyStub,
    documentElementStub: documentElementStub,
    postedHeights: postedHeights,
    observed: observed,
    errors: errors,
    measure: function () {
      messageListeners[0]({ source: fakeParent, data: { type: 'payment-template:measure' } });
      return postedHeights[postedHeights.length - 1];
    },
  };
}

test('measureHeight measures the [data-payment-template-root] container, not document.body', () => {
  // body reports a wildly different height, so a measurement that fell back to
  // it (the pre-container behavior) cannot pass this by accident.
  const runtime = bootRuntime({ container: makeBox(140.2), bodyHeight: 999 });
  assert.equal(runtime.measure(), 141, 'the posted height must be ceil() of the container box, not of body');
});

test("the wrapped document's container establishes a block formatting context, so the measured height keeps a child's bottom margin", () => {
  const CONTENT_HEIGHT = 100;
  const CHILD_MARGIN_BOTTOM = 20;

  // Read the container's declared style out of the REAL generated document, so
  // this tracks wrap-template.js instead of a hard-coded copy of what it should
  // emit: dropping `display:flow-root` there flips the stub below and fails.
  const documentHtml = wrapTemplate(
    { html: { text: '<p style="margin-bottom:20px">content</p>' }, i18n: { 'en-US': { text: '{}' } } },
    'en-US'
  );
  const containerTag = documentHtml.match(/<div[^>]*\bdata-payment-template-root\b[^>]*>/);
  assert.ok(containerTag, 'the wrapped document must contain the measured container element');
  const styleAttribute = containerTag[0].match(/style="([^"]*)"/);
  assert.ok(styleAttribute, 'the container must carry an inline style');
  const establishesBlockFormattingContext = /(^|;)\s*display\s*:\s*flow-root\s*(;|$)/.test(styleAttribute[1]);

  // Approximates margin collapse, the only layout behavior under test: a box
  // that establishes a block formatting context contains its in-flow child's
  // bottom margin and measures taller, while a plain block box lets that margin
  // collapse through and out, invisible to getBoundingClientRect() entirely.
  const container = makeBox(
    establishesBlockFormattingContext ? CONTENT_HEIGHT + CHILD_MARGIN_BOTTOM : CONTENT_HEIGHT
  );
  // body keeps the collapsed height — measuring it instead of the container is
  // exactly the regression that loses the margin again.
  const runtime = bootRuntime({ container: container, bodyHeight: CONTENT_HEIGHT });

  assert.equal(
    runtime.measure(),
    CONTENT_HEIGHT + CHILD_MARGIN_BOTTOM,
    'the container must declare display:flow-root AND be the box the runtime measures'
  );
});

test('measureHeight reports 0 and logs exactly once when the container is missing', () => {
  const runtime = bootRuntime({ container: null, bodyHeight: 500 });

  // measureHeight() runs on every host measure request and every observer tick;
  // three more measurements must not produce three more console.error calls.
  runtime.measure();
  runtime.measure();
  runtime.measure();

  assert.ok(runtime.postedHeights.length > 0, 'boot() and each measure request must still post a height');
  assert.ok(
    runtime.postedHeights.every((height) => height === 0),
    'a missing container must report 0, never silently fall back to document.body'
  );
  assert.equal(runtime.errors.length, 1, 'the missing-container error must be logged once, not on every measurement');
  assert.match(runtime.errors[0], /data-payment-template-root/);
});

test('observeLayout observes the container and documentElement, and not document.body', () => {
  const runtime = bootRuntime({ container: makeBox(10), bodyHeight: 20 });
  assert.ok(runtime.observed.includes(runtime.container), 'the measured container must be observed');
  assert.ok(runtime.observed.includes(runtime.documentElementStub), 'documentElement must stay observed (viewport-driven changes)');
  assert.ok(!runtime.observed.includes(runtime.bodyStub), 'body is redundant with the container and must not be observed');
  assert.equal(runtime.observed.length, 2, 'exactly the container and documentElement, nothing else');
});

test('the runtime file no longer ships the removed resetDocumentBox reset', () => {
  const source = readLibScript('template-runtime.js');
  assert.ok(!source.includes('resetDocumentBox'), 'the removed reset must not come back as dead code');
  assert.ok(
    !/document\.body[\s\S]{0,20}getBoundingClientRect/.test(source),
    'the height must come from the container, not from document.body'
  );
  assert.ok(source.includes(CONTAINER_SELECTOR), 'the runtime must locate the container by its stable data attribute');
});

test('the runtime file is a plain browser script, vendorable byte for byte', () => {
  // vcs.checkout-ui vendors this exact file and CI on both sides diffs the
  // copies, so it must stay loadable by <script src> — no Node module system.
  const source = readLibScript('template-runtime.js');
  assert.ok(!/module\.exports/.test(source), 'the runtime must not export itself as a Node module');
  assert.ok(!/\brequire\(/.test(source), 'the runtime must not require() anything; the browser loads it directly');
  assert.ok(
    source.includes('[data-payment-template-i18n]'),
    'the runtime must read the i18n payload by its stable data attribute'
  );
});
