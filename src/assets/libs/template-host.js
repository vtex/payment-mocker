(function () {
  var PREVIEW_CONFIG_URL = '/preview.config.json';
  var IFRAME_SRC = '/template-bundle/index.html';
  var BUNDLE_PREFIX = '/template-bundle/';
  var MAX_HEIGHT = 2000;
  var MIN_HEIGHT = 40;

  var iframe = document.getElementById('payment-template-iframe');
  var paymentGroupLabel = document.getElementById('payment-template-group-label');
  var languageButtons = Array.prototype.slice.call(document.getElementsByClassName('language'));

  var previewConfig = null;
  var currentLocale = null;
  var measureTimer = null;

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
