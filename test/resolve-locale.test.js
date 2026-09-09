'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { resolveLocale } = require('../lib/resolve-locale');
const wrapperRuntimeSource = require('../lib/wrapper-runtime');

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
 * closures over anything outside its own parameters/body) because
 * wrapper-runtime.js embeds its source verbatim via Function#toString() and
 * runs it isolated inside the sandboxed bundle iframe, where none of this
 * repo's module scope exists. No test previously verified that promise: a
 * future edit that referenced an outer variable would pass all the
 * resolveLocale unit tests above (they call the real, in-process function
 * directly) while throwing a ReferenceError in production, once actually
 * inlined and run with no enclosing scope.
 *
 * This builds a minimal DOM stub, evaluates the full wrapper-runtime source
 * (which includes the inlined resolveLocale) inside an isolated vm context
 * with no access to this file's scope, and fails if booting it throws
 * anything — a ReferenceError in particular.
 */
test('the wrapper runtime (with resolveLocale inlined) runs without error in an isolated scope', () => {
  const source = wrapperRuntimeSource();

  const elementStub = { style: {} };
  const documentStub = {
    readyState: 'complete', // skip the DOMContentLoaded listener path entirely
    documentElement: { style: {} },
    body: Object.assign({ firstElementChild: null }, elementStub),
    images: [],
    getElementById: function () {
      return null; // no #payment-template-i18n node — parseData() falls back
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
    getComputedStyle: function () {
      return { display: 'block' };
    },
  };
  sandbox.document = documentStub;
  sandbox.window = sandbox; // window.parent is then undefined, so postHeight() no-ops
  sandbox.addEventListener = function () {};

  vm.createContext(sandbox);
  assert.doesNotThrow(() => {
    vm.runInContext(source, sandbox);
  });
});

/**
 * The isolated-scope test above only exercises parseData()'s early-return
 * branch (getElementById returns null), so the inlined resolveLocale's
 * same-language tie-break — the branch covered directly in the "breaks ties"
 * and "prefers defaultLocale" tests near the top of this file — never once
 * ran inside the actual vm-isolated copy that ships to the sandboxed bundle
 * iframe. This stubs a real #payment-template-i18n node with two locales that
 * share a language (pt-BR/pt-PT) and drives a simulated postMessage locale
 * switch through the runtime's own "message" listener (registered via the
 * addEventListener stub below, unlike the no-op used above) to confirm the
 * tie-break also resolves correctly once actually inlined and isolated.
 */
test('the wrapper runtime (with resolveLocale inlined) resolves same-language ties in an isolated scope', () => {
  const source = wrapperRuntimeSource();

  const i18nNode = {
    textContent: JSON.stringify({
      locales: { 'pt-BR': { greeting: 'Oi' }, 'pt-PT': { greeting: 'Ola' } },
      defaultLocale: 'en-US',
    }),
  };

  const documentElementStub = { style: {}, lang: '' };
  const documentStub = {
    readyState: 'complete',
    documentElement: documentElementStub,
    body: { style: {}, firstElementChild: null },
    images: [],
    getElementById: function (id) {
      return id === 'payment-template-i18n' ? i18nNode : null;
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
    getComputedStyle: function () {
      return { display: 'block' };
    },
  };
  sandbox.document = documentStub;
  sandbox.window = sandbox; // window.parent is then undefined, so postHeight() no-ops
  sandbox.addEventListener = function (type, listener) {
    if (type === 'message') messageListeners.push(listener);
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  assert.equal(messageListeners.length, 1, 'boot() must register exactly one "message" listener');

  // Neither pt-BR nor pt-PT is en-US's language, so the tie-break must fall
  // to the lowest alphabetical tag (pt-BR), exactly like the direct
  // resolveLocale() unit tests above — but here going through the fully
  // inlined, isolated copy via a simulated incoming postMessage.
  assert.doesNotThrow(() => {
    messageListeners[0]({ source: undefined, data: { locale: 'pt-AO' } });
  });
  assert.equal(documentElementStub.lang, 'pt-BR');
});

/**
 * Regression guard for measureHeight()/resetDocumentBox()'s margin-collapse
 * handling (lib/wrapper-runtime.js). Neither jsdom nor a plain vm context
 * actually runs layout, so `getBoundingClientRect()` can't reflect real
 * margin-collapse behavior on its own — this stubs it to approximate just
 * that one behavior: a block box whose bottom margin collapses through into
 * its parent (the default, `display: block`) does NOT count that margin as
 * part of its own measured height, while a box that establishes a new block
 * formatting context (`display: flow-root`, which resetDocumentBox applies
 * to `body`) contains the child's margin and DOES count it.
 *
 * A prior version of this test only checked `bodyStub.style.display ===
 * 'flow-root'` right after boot() ran, and derived the stubbed height from
 * that same flag. That is circular: boot() itself calls resetDocumentBox()
 * directly (once, up front, independent of any measurement), so the flag was
 * already 'flow-root' for a reason that has nothing to do with the
 * measureHeight() call this test is supposed to be protecting. A mutation
 * test proved it: deleting the `resetDocumentBox()` call from inside
 * measureHeight() left this test passing, because boot()'s own earlier call
 * had already set the flag.
 *
 * This version breaks that circularity by explicitly undoing boot()'s
 * earlier effect — resetting `body.style.display` back to 'block' — *before*
 * triggering the measurement under test, so 'flow-root' is not present for
 * any reason left over from boot(). It then drives a fresh measurement the
 * same way the host page does after boot: a simulated
 * `postMessage({ type: 'payment-template:measure' })` from `window.parent`,
 * handled by boot()'s own "message" listener (captured below), which resets
 * the runtime's internal `lastHeight` and calls schedulePostHeight() ->
 * postHeight() -> measureHeight(). Only if measureHeight() itself calls
 * resetDocumentBox() again does 'flow-root' come back before
 * getBoundingClientRect() runs, and only then does the stubbed height
 * include the child's margin.
 */
test('measureHeight (via the wrapper runtime, inlined and isolated) counts a child\'s bottom margin, proving resetDocumentBox runs from inside measureHeight itself', () => {
  const source = wrapperRuntimeSource();

  const CONTENT_HEIGHT = 100;
  const CHILD_MARGIN_BOTTOM = 20;

  const bodyStub = { style: {}, firstElementChild: null };
  // Approximates margin-collapse: only once `body` has switched to
  // `display: flow-root` (a new block formatting context) does its measured
  // height grow to include the in-flow child's bottom margin: without it,
  // that margin collapses through body and is invisible to
  // getBoundingClientRect() entirely.
  bodyStub.getBoundingClientRect = function () {
    const containsMargin = bodyStub.style.display === 'flow-root';
    return { height: containsMargin ? CONTENT_HEIGHT + CHILD_MARGIN_BOTTOM : CONTENT_HEIGHT };
  };

  const documentStub = {
    readyState: 'complete',
    documentElement: { style: {} },
    body: bodyStub,
    images: [],
    getElementById: function () {
      return null;
    },
    querySelectorAll: function () {
      return [];
    },
  };

  const parentMessages = [];
  const fakeParent = {
    postMessage: function (data) {
      parentMessages.push(data);
    },
  };

  // Unlike the no-op `addEventListener` used in some tests above, this
  // records boot()'s "message" listener so the simulated
  // 'payment-template:measure' postMessage below can be delivered through it.
  const messageListeners = [];
  const sandbox = {
    console,
    requestAnimationFrame: function (callback) {
      callback();
    },
    // Always reports 'block', matching a template author who never set
    // display on body themselves — resetDocumentBox is the only thing that
    // can move it to 'flow-root' before measurement.
    getComputedStyle: function () {
      return { display: 'block' };
    },
  };
  sandbox.document = documentStub;
  sandbox.window = sandbox;
  sandbox.window.parent = fakeParent; // distinct from `window` so postHeight() doesn't no-op
  sandbox.addEventListener = function (type, listener) {
    if (type === 'message') messageListeners.push(listener);
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  assert.equal(messageListeners.length, 1, 'boot() must register exactly one "message" listener');
  // Sanity check only — this is boot()'s own up-front resetDocumentBox() call,
  // NOT the thing this test protects. It gets undone immediately below.
  assert.equal(bodyStub.style.display, 'flow-root', 'sanity check: boot() applies flow-root at least once, on its own');

  // Break the circularity: simulate a state where flow-root is NOT present
  // for any reason left over from boot(), then discard any messages posted
  // so far so only the measurement under test below is asserted on.
  bodyStub.style.display = 'block';
  parentMessages.length = 0;

  assert.doesNotThrow(() => {
    messageListeners[0]({ source: fakeParent, data: { type: 'payment-template:measure' } });
  });

  assert.ok(parentMessages.length > 0, 'the simulated measure message must trigger a new height postMessage');
  assert.equal(
    parentMessages[parentMessages.length - 1].height,
    CONTENT_HEIGHT + CHILD_MARGIN_BOTTOM,
    "measureHeight() itself must re-apply flow-root before measuring — this only passes if resetDocumentBox() runs from inside measureHeight(), not merely once earlier from boot()"
  );
});
