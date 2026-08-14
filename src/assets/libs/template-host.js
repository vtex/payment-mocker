(function () {
  var PREVIEW_CONFIG_URL = '/preview.config.json';
  var VALIDATION_URL = '/validation.json';
  var IFRAME_SRC = '/template-bundle/index.html';
  var BUNDLE_PREFIX = '/template-bundle/';
  var MAX_HEIGHT = 2000;
  var MIN_HEIGHT = 40;

  var iframe = document.getElementById('payment-template-iframe');
  var paymentGroupLabel = document.getElementById('payment-template-group-label');
  var validationBanner = document.getElementById('payment-template-validation-banner');
  var languageButtons = Array.prototype.slice.call(document.getElementsByClassName('language'));

  var previewConfig = null;
  var currentLocale = null;
  var measureTimer = null;
  var validationTimer = null;
  var lastValidationSignature = null;

  function formatFindingRef(ref) {
    if (!ref || !ref.file) return '';
    if (ref.line == null) return ref.file;
    if (ref.column == null) return ref.file + ':' + ref.line;
    return ref.file + ':' + ref.line + ':' + ref.column;
  }

  function formatFinding(finding) {
    var location = formatFindingRef(finding.ref);
    var prefix = '[' + finding.severity + '] ' + finding.rule;
    if (location) prefix += ' ' + location;
    return prefix + ' — ' + finding.message;
  }

  function renderValidationBanner(result) {
    if (!validationBanner) return;

    if (!result || !Array.isArray(result.errors)) {
      validationBanner.className = 'payment-template-validation-banner is-unavailable';
      validationBanner.innerHTML = '<strong>Validation unavailable.</strong> Restart the dev server (<code>grunt</code>) so <code>/validation.json</code> is served.';
      return;
    }

    var errors = result.errors.filter(function (finding) {
      return finding.severity === 'error';
    });
    var warnings = result.errors.filter(function (finding) {
      return finding.severity === 'warning';
    });

    if (result.ok && warnings.length === 0) {
      validationBanner.className = 'payment-template-validation-banner hide';
      validationBanner.innerHTML = '';
      return;
    }

    var title = result.ok
      ? 'Validation passed with ' + warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') + '.'
      : 'Validation failed with ' + errors.length + ' error' + (errors.length === 1 ? '' : 's') + '.';

    var items = result.errors.map(function (finding) {
      return '<li>' + formatFinding(finding) + '</li>';
    }).join('');

    validationBanner.className = 'payment-template-validation-banner' + (result.ok ? ' has-warnings' : '');
    validationBanner.innerHTML = '<strong>' + title + '</strong><ul>' + items + '</ul>';
  }

  function validationSignature(result) {
    return JSON.stringify(result);
  }

  function reloadIframePreview() {
    if (!iframe) return;
    appliedHeight = 0;
    iframe.src = IFRAME_SRC + '?' + Date.now();
  }

  function applyValidationResult(result, options) {
    options = options || {};
    var signature = validationSignature(result);
    renderValidationBanner(result);

    if (options.initial) {
      lastValidationSignature = signature;
      return;
    }

    if (signature === lastValidationSignature) {
      return;
    }

    lastValidationSignature = signature;
    reloadIframePreview();
  }

  function loadValidationResult(options, callback) {
    var request = new XMLHttpRequest();
    request.open('GET', VALIDATION_URL + '?t=' + Date.now(), true);
    request.onload = function () {
      if (request.status >= 200 && request.status < 300) {
        try {
          applyValidationResult(JSON.parse(request.responseText), options);
        } catch (error) {
          renderValidationBanner(null);
        }
      } else {
        renderValidationBanner(null);
      }
      if (callback) callback();
    };
    request.onerror = function () {
      renderValidationBanner(null);
      if (callback) callback();
    };
    request.send();
  }

  function startValidationPolling() {
    loadValidationResult({ initial: true }, function () {});
    if (validationTimer) clearInterval(validationTimer);
    validationTimer = setInterval(function () {
      loadValidationResult({}, function () {});
    }, 1500);
  }

  function clampHeight(value) {
    return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, value));
  }

  function resolveDisplayName(locale) {
    if (!previewConfig || !previewConfig.displayName) return '';
    var names = previewConfig.displayName;
    if (names[locale]) return names[locale];
    var lang = locale.split('-')[0];
    var keys = Object.keys(names);
    for (var i = 0; i < keys.length; i += 1) {
      if (keys[i].indexOf(lang + '-') === 0) return names[keys[i]];
    }
    if (names[previewConfig.defaultLocale]) return names[previewConfig.defaultLocale];
    return keys.length ? names[keys[0]] : '';
  }

  function applyPaymentGroupIcon() {
    if (!paymentGroupLabel || !previewConfig || !previewConfig.icon) return;
    var iconName = String(previewConfig.icon).replace(/^\.\//, '');
    paymentGroupLabel.style.backgroundImage = "url('" + BUNDLE_PREFIX + iconName + "')";
    paymentGroupLabel.style.backgroundRepeat = 'no-repeat';
    paymentGroupLabel.style.backgroundPosition = 'right center';
    paymentGroupLabel.style.backgroundSize = '30px auto';
  }

  function updatePaymentGroupLabel(locale) {
    if (!paymentGroupLabel) return;
    var label = resolveDisplayName(locale);
    if (label) paymentGroupLabel.textContent = label;
    applyPaymentGroupIcon();
  }

  function requestIframeMeasure() {
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage({ type: 'payment-template:measure' }, '*');
  }

  function startMeasurePolling() {
    if (measureTimer) clearInterval(measureTimer);
    var attempts = 0;
    measureTimer = setInterval(function () {
      attempts += 1;
      requestIframeMeasure();
      if (attempts >= 25) clearInterval(measureTimer);
    }, 200);
  }

  function postLocale(locale) {
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage({ locale: locale }, '*');
    requestIframeMeasure();
  }

  function setLocale(locale) {
    currentLocale = locale;
    updatePaymentGroupLabel(locale);
    postLocale(locale);
  }

  var appliedHeight = 0;

  function applyIframeHeight(value) {
    if (!iframe) return;
    var next = clampHeight(Math.ceil(value));
    if (next === appliedHeight) return;
    appliedHeight = next;
    iframe.style.height = next + 'px';
  }

  function onMessage(event) {
    if (!iframe) return;
    if (event.source !== iframe.contentWindow) return;
    var data = event.data;
    if (!data || typeof data.height !== 'number') return;
    applyIframeHeight(data.height);
  }

  function bindLanguageSwitcher() {
    languageButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        setLocale(this.dataset.lang);
      });
    });
  }

  function loadPreviewConfig(callback) {
    var request = new XMLHttpRequest();
    request.open('GET', PREVIEW_CONFIG_URL, true);
    request.onload = function () {
      if (request.status >= 200 && request.status < 300) {
        previewConfig = JSON.parse(request.responseText);
      }
      callback();
    };
    request.onerror = callback;
    request.send();
  }

  function boot() {
    if (!iframe) return;

    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.src = IFRAME_SRC + '?' + Date.now();

    window.addEventListener('message', onMessage);
    bindLanguageSwitcher();

    loadPreviewConfig(function () {
      var initialLocale = previewConfig && previewConfig.defaultLocale ? previewConfig.defaultLocale : 'pt-BR';
      applyPaymentGroupIcon();
      startValidationPolling();

      iframe.addEventListener('load', function onLoad() {
        iframe.removeEventListener('load', onLoad);
        appliedHeight = 0;
        setLocale(initialLocale);
        startMeasurePolling();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
