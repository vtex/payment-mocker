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
 * Unlike bootHost() above (built for onMessage, whose XHR stub never fires),
 * this drives boot() through loadPreviewConfig's callback by answering
 * /preview.config.json synchronously, which is what actually calls
 * applyPaymentGroupIcon(). /template-validation.json is answered with a
 * trivially clean result so the validation-banner XHR the same boot() also
 * fires doesn't throw.
 */
function bootHostWithConfig(previewConfig) {
  const warnings = [];
  const paymentGroupLabel = { style: {}, textContent: '' };
  const iframe = {
    style: {},
    contentWindow: {},
    setAttribute: function () {},
    addEventListener: function () {},
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
          url === '/preview.config.json' ? JSON.stringify(previewConfig) : JSON.stringify({ ok: true, errors: [] });
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
      return null;
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
  sandbox.addEventListener = function () {};

  vm.createContext(sandbox);
  vm.runInContext(HOST_SCRIPT, sandbox);

  return { paymentGroupLabel, warnings };
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

test('applyPaymentGroupIcon refuses an icon name that could break out of the CSS url(\'...\') it is embedded in', () => {
  // Before the fix, encodeURIComponent left the closing "'" and ")" as-is, so
  // this value would end the url('...') early and smuggle a second
  // background-image pointing at an attacker-controlled origin.
  const host = bootHostWithConfig({ defaultLocale: 'pt-BR', icon: "x'),url('https://evil.example/img" });
  assert.equal(host.paymentGroupLabel.style.backgroundImage, undefined);
  assert.equal(host.warnings.length, 1);
  assert.match(host.warnings[0], /unexpected shape/);
});
