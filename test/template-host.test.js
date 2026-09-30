'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const HOST_SCRIPT = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'assets', 'libs', 'template-host.js'),
  'utf8'
);

/**
 * template-host.js is a browser script wrapped in an IIFE with no exports, so
 * — like test/resolve-locale.test.js does for the in-iframe runtime — the real
 * file is evaluated as the browser receives it, inside a vm context with a
 * hand-built DOM stub (there is no jsdom in this repo's dependencies).
 *
 * `boot()` registers the message listener via window.addEventListener, which
 * is the stub that hands it back here: that is the entry point under test, and
 * capturing it that way exercises the real registration instead of a copy of
 * onMessage. The XMLHttpRequest stub never fires onload/onerror/ontimeout, so
 * boot stops right after the listener is attached — no preview config, no
 * validation banner, no iframe src assignment.
 */
function bootHost() {
  const warnings = [];
  const contentWindow = {};
  const iframe = {
    style: {},
    contentWindow,
    setAttribute: function () {},
    addEventListener: function () {},
  };

  let messageHandler = null;

  const sandbox = {
    console: {
      warn: function (message) {
        warnings.push(message);
      },
      error: function () {},
      log: function () {},
    },
    XMLHttpRequest: function () {
      this.open = function () {};
      this.send = function () {};
    },
    setInterval: function () {
      return 0;
    },
    clearInterval: function () {},
  };

  sandbox.document = {
    readyState: 'complete', // skip the DOMContentLoaded path entirely
    getElementById: function (id) {
      // Only the iframe exists: the label and the language select are optional
      // in template-host.js (every use guards on them), so leaving them null
      // keeps this stub to the minimum onMessage actually needs.
      return id === 'payment-template-iframe' ? iframe : null;
    },
    querySelector: function () {
      return null;
    },
    createElement: function () {
      return { style: {}, appendChild: function () {} };
    },
    addEventListener: function () {},
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = function (type, handler) {
    if (type === 'message') messageHandler = handler;
  };

  vm.createContext(sandbox);
  vm.runInContext(HOST_SCRIPT, sandbox);

  assert.equal(typeof messageHandler, 'function', 'boot() must register a message listener');

  return {
    iframe,
    warnings,
    post: function (data, source) {
      messageHandler({ source: source === undefined ? contentWindow : source, data: data });
    },
  };
}

test('template-host onMessage applies a height message from the iframe', () => {
  const host = bootHost();
  host.post({ height: 120 });
  assert.equal(host.iframe.style.height, '120px');
});

test('template-host onMessage ignores a message from a window that is not the iframe', () => {
  // Pre-existing guard: anything posting into the host page (an ad frame, an
  // extension, the page itself) must not be able to resize the template.
  const host = bootHost();
  host.post({ height: 120 }, { notTheIframe: true });
  assert.equal(host.iframe.style.height, undefined);
});

// lib/template-runtime.js posts diagnostics as { type, code } with no `height`
// field at all, so the `typeof data.height !== 'number'` filter used to drop
// every one of them before anything looked at the type — the whole diagnostic
// channel was inert on the host side.
for (const code of ['stylesheetNotApplied', 'containerMissing', 'i18nPayloadInvalid']) {
  test('template-host onMessage surfaces the ' + code + ' diagnostic without touching the height', () => {
    const host = bootHost();
    host.post({ type: 'payment-template:diagnostic', code: code });
    assert.deepEqual(host.warnings, ['[payment-template] diagnostic: ' + code]);
    assert.equal(host.iframe.style.height, undefined);
  });
}

test('template-host onMessage drops a diagnostic code outside the closed set', () => {
  // Same stance the runtime documents for its own side: an unrecognized code
  // is dropped, never echoed — the host must not display a string it has no
  // prior agreement about.
  const host = bootHost();
  host.post({ type: 'payment-template:diagnostic', code: 'algumCodigoDesconhecido' });
  assert.deepEqual(host.warnings, []);
  assert.equal(host.iframe.style.height, undefined);
});

test('template-host onMessage ignores a diagnostic-shaped message from another window', () => {
  const host = bootHost();
  host.post({ type: 'payment-template:diagnostic', code: 'containerMissing' }, { notTheIframe: true });
  assert.deepEqual(host.warnings, []);
});

test('template-host onMessage still ignores a message with no usable payload', () => {
  const host = bootHost();
  assert.doesNotThrow(() => {
    host.post(null);
    host.post({ height: 'tall' });
    host.post({ type: 'payment-template:other' });
  });
  assert.equal(host.iframe.style.height, undefined);
  assert.deepEqual(host.warnings, []);
});

/**
 * A minimal DOM-element stub capable of holding a textContent string and
 * appended children — the shape renderValidationBanner and
 * renderLanguageOptions actually build (div > strong, ul > li; a <select>'s
 * <option> children), which the flat `{ style: {}, appendChild: noop }` stub
 * bootHost()/the original bootHostWithConfig used is too thin to observe.
 */
function makeElement() {
  return {
    style: {},
    textContent: '',
    value: '',
    children: [],
    appendChild: function (child) {
      this.children.push(child);
    },
    addEventListener: function () {},
  };
}

/**
 * Unlike bootHost() above (built for onMessage, whose XHR stub never fires),
 * this drives boot() through loadPreviewConfig's callback by answering
 * /preview.config.json synchronously, which is what actually calls
 * applyPaymentGroupIcon() and renderLanguageOptions(). /template-validation.json
 * is answered with `validationResult` (a trivially clean result by default),
 * which drives renderValidationBanner the same boot() call also triggers.
 *
 * The accordion anchor and its parentNode.insertBefore are stubbed just
 * enough for ensureValidationBanner to succeed and hand back the real banner
 * node it builds, captured here as `banner` for assertions — previously
 * querySelector always returned null, so ensureValidationBanner returned null
 * immediately and renderValidationBanner's whole body (the actual thing under
 * test) never ran in any test in this file.
 */
function bootHostWithConfig(previewConfig, validationResult) {
  const warnings = [];
  const paymentGroupLabel = { style: {}, textContent: '' };
  const languageSelect = makeElement();
  const iframe = {
    style: {},
    contentWindow: {},
    setAttribute: function () {},
    addEventListener: function () {},
  };
  const accordionAnchor = {
    parentNode: {
      insertBefore: function (node) {
        accordionAnchor.parentNode.insertedNode = node;
      },
    },
  };

  const sandbox = {
    console: {
      warn: function (message) {
        warnings.push(message);
      },
      error: function () {},
      log: function () {},
    },
    XMLHttpRequest: function () {
      const self = this;
      let url;
      this.open = function (method, requestUrl) {
        url = requestUrl;
      };
      this.send = function () {
        self.status = 200;
        self.responseText =
          url === '/preview.config.json'
            ? JSON.stringify(previewConfig)
            : JSON.stringify(validationResult || { ok: true, errors: [] });
        if (self.onload) self.onload();
      };
    },
    setInterval: function () {
      return 0;
    },
    clearInterval: function () {},
  };

  sandbox.document = {
    readyState: 'complete',
    getElementById: function (id) {
      if (id === 'payment-template-iframe') return iframe;
      if (id === 'payment-template-group-label') return paymentGroupLabel;
      if (id === 'language-select') return languageSelect;
      return null;
    },
    querySelector: function () {
      return accordionAnchor;
    },
    createElement: function () {
      return makeElement();
    },
    addEventListener: function () {},
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = function () {};

  vm.createContext(sandbox);
  vm.runInContext(HOST_SCRIPT, sandbox);

  return {
    paymentGroupLabel,
    languageSelect,
    warnings,
    banner: accordionAnchor.parentNode.insertedNode,
  };
}

test('applyPaymentGroupIcon renders a plain icon filename', () => {
  const host = bootHostWithConfig({ defaultLocale: 'pt-BR', icon: 'icon.png' });
  assert.equal(host.paymentGroupLabel.style.backgroundImage, "url('/template-icon/icon.png')");
  assert.deepEqual(host.warnings, []);
});

test('applyPaymentGroupIcon strips a leading "./" the same as before', () => {
  const host = bootHostWithConfig({ defaultLocale: 'pt-BR', icon: './icon.png' });
  assert.equal(host.paymentGroupLabel.style.backgroundImage, "url('/template-icon/icon.png')");
});

test('applyPaymentGroupIcon escapes the characters that could break out of the CSS url(\'...\') it is embedded in', () => {
  // encodeURIComponent alone left the closing "'" and ")" as-is, so this
  // value would end the url('...') early and smuggle a second
  // background-image pointing at an attacker-controlled origin. The fix
  // percent-encodes exactly those leftover characters instead of rejecting
  // the whole name, so the icon still renders (safely) rather than silently
  // disappearing.
  const host = bootHostWithConfig({ defaultLocale: 'pt-BR', icon: "x'),url('https://evil.example/img" });
  assert.equal(
    host.paymentGroupLabel.style.backgroundImage,
    "url('/template-icon/x%27%29%2Curl%28%27https%3A%2F%2Fevil.example%2Fimg')"
  );
  assert.ok(!host.paymentGroupLabel.style.backgroundImage.includes("'https"), 'must not smuggle a second url(...)');
  assert.deepEqual(host.warnings, []);
});

test('applyPaymentGroupIcon renders a name outside the old plain-filename allow-list (accented character, space)', () => {
  // The old ICON_NAME_PATTERN allow-list rejected this even though the
  // server-side contract (lib/preview-config.js's ICON_FILENAME_PATTERN)
  // has always accepted any flat name ending in an image extension.
  const host = bootHostWithConfig({ defaultLocale: 'pt-BR', icon: 'ícone da loja.png' });
  assert.equal(
    host.paymentGroupLabel.style.backgroundImage,
    "url('/template-icon/" + encodeURIComponent('ícone da loja.png') + "')"
  );
  assert.deepEqual(host.warnings, []);
});

test('renderValidationBanner hides the banner for a clean result', () => {
  const host = bootHostWithConfig({ defaultLocale: 'pt-BR' }, { ok: true, errors: [] });
  assert.equal(host.banner.style.display, 'none');
  assert.equal(host.banner.textContent, '');
});

test('renderValidationBanner shows an error finding, with its rule/message/file', () => {
  const host = bootHostWithConfig(
    { defaultLocale: 'pt-BR' },
    {
      ok: false,
      errors: [{ rule: 'load', severity: 'error', message: 'index.html is missing', ref: { file: 'index.html' } }],
    }
  );
  assert.equal(host.banner.style.display, 'block');
  assert.equal(host.banner.style.background, '#f2dede');
  const [title, list] = host.banner.children;
  assert.equal(title.textContent, 'Template validation failed:');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].textContent, '[error] load: index.html is missing (index.html)');
});

// @vtex/payment-templates-core returns `ok: true` even when `errors` is
// non-empty, as long as every finding is a warning — renderValidationBanner's
// own docblock explains this used to be swallowed by checking `validation.ok`
// instead of `errors.length`. This is the regression that guard prevents.
test('renderValidationBanner still shows a warning-only finding even though ok is true', () => {
  const host = bootHostWithConfig(
    { defaultLocale: 'pt-BR' },
    { ok: true, errors: [{ rule: 'assetUsage', severity: 'warning', message: 'asset-logo.png is never referenced' }] }
  );
  assert.equal(host.banner.style.display, 'block');
  assert.equal(host.banner.style.background, '#fcf8e3');
  const [title, list] = host.banner.children;
  assert.equal(title.textContent, 'Template validation warnings:');
  assert.equal(list.children[0].textContent, '[warning] assetUsage: asset-logo.png is never referenced');
});

test('renderValidationBanner skips a malformed finding instead of dropping the whole list', () => {
  // A non-object entry in `errors` (validate() only ever returns finding
  // objects, but this endpoint's own load-failure fallback and a future bug
  // are both free to violate that) must not throw out of the forEach below —
  // the guard this pins is `if (!finding || typeof finding !== 'object') return;`.
  const host = bootHostWithConfig(
    { defaultLocale: 'pt-BR' },
    { ok: false, errors: [null, { rule: 'load', severity: 'error', message: 'ok finding' }] }
  );
  assert.equal(host.banner.style.display, 'block');
  const list = host.banner.children[1];
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].textContent, '[error] load: ok finding');
});

test('renderLanguageOptions populates the select from availableLocales, with a Default option first', () => {
  const host = bootHostWithConfig({ defaultLocale: 'pt-BR', availableLocales: ['en-US', 'es-AR'] });
  assert.equal(host.languageSelect.children.length, 3);
  assert.equal(host.languageSelect.children[0].textContent, 'Default (pt-BR)');
  assert.equal(host.languageSelect.children[1].value, 'en-US');
  assert.equal(host.languageSelect.children[2].value, 'es-AR');
  assert.equal(host.languageSelect.value, '');
});
