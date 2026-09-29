(function () {
  var PREVIEW_CONFIG_URL = '/preview.config.json';
  var TEMPLATE_VALIDATION_URL = '/template-validation.json';
  var IFRAME_SRC = '/template-bundle/index.html';
  var ICON_PREFIX = '/template-icon/';
  var MAX_HEIGHT = 2000;
  var MIN_HEIGHT = 40;

  var iframe = document.getElementById('payment-template-iframe');
  var paymentGroupLabel = document.getElementById('payment-template-group-label');
  var languageSelect = document.getElementById('language-select');

  var previewConfig = null;
  var currentLocale = null;
  var measureTimer = null;

  function clampHeight(value) {
    return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, value));
  }

  function resolveDisplayName(locale) {
    if (!previewConfig || !previewConfig.displayName) return '';
    var names = previewConfig.displayName;
    // Delegates to the same resolution algorithm the wrapped template's
    // in-iframe runtime uses (@vtex/payment-templates-core/wrap's
    // resolve-locale.js, served statically at /lib/resolve-locale.js and
    // loaded via <script> above template-host.js in src/index.html), instead
    // of a third, divergent reimplementation that skipped candidate sorting
    // and the defaultLocale preference.
    if (typeof window.resolveLocale !== 'function') return '';
    var resolved = window.resolveLocale(locale, names, previewConfig.defaultLocale);
    return names[resolved] || '';
  }

  // encodeURIComponent leaves `!'()*` unescaped — they're valid in a URI by
  // its own spec — but iconName lands inside a single-quoted url('...') in a
  // CSS property value below, where a bare `'` or `)` ends that value early
  // and lets whatever follows smuggle a second background-image (e.g. a
  // request to an attacker-controlled origin: `x'),url('https://evil/img`).
  //
  // This used to reject any name outside a plain-filename shape
  // (`/^[A-Za-z0-9._/-]+$/`) instead. That was both stricter and looser than
  // the contract that actually governs the icon
  // (lib/preview-middleware.js's ICON_FILENAME_PATTERN, `/^[^/\\]+\.(?:png|jpe?g|webp)$/i`,
  // via the `/template-icon/` route): a legitimate name outside `[A-Za-z0-9._-]`
  // (an accented character, a space) was rejected here even though the server
  // would happily serve it, while a name containing `/` passed here even
  // though the server always 404s it (icons are a flat name, no
  // subdirectory). Escaping only the three characters that are actually
  // unsafe in this specific position fixes the injection without guessing at
  // a shape the server, not this file, is the authority on — an icon name
  // this doesn't reject can still 404 at the server, same as any other
  // invalid one, which is a harmless broken image, not a security issue.
  function escapeForCssUrl(value) {
    return value.replace(/['()]/g, function (char) {
      return '%' + char.charCodeAt(0).toString(16);
    });
  }

  function applyPaymentGroupIcon() {
    if (!paymentGroupLabel || !previewConfig || !previewConfig.icon) return;
    var iconName = String(previewConfig.icon).replace(/^\.\//, '');
    paymentGroupLabel.style.backgroundImage =
      "url('" + ICON_PREFIX + escapeForCssUrl(encodeURIComponent(iconName)) + "')";
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

  var DIAGNOSTIC_MESSAGE_TYPE = 'payment-template:diagnostic';
  // The host's own copy of the closed set the in-iframe runtime reports (see
  // "Diagnostics" in @vtex/payment-templates-core/wrap's template-runtime.js,
  // pinned in package.json): a code missing from this list is dropped, never
  // trusted or displayed, so adding one on the runtime side is a no-op here
  // until both sides are updated. Nothing in this repo checks the two lists
  // automatically now that the runtime is an external, versioned dependency —
  // a bump that adds a diagnostic code needs this list touched by hand.
  var DIAGNOSTIC_CODES = ['stylesheetNotApplied', 'containerMissing', 'i18nPayloadInvalid'];

  function onMessage(event) {
    if (!iframe) return;
    if (event.source !== iframe.contentWindow) return;
    var data = event.data;
    // Diagnostics carry no `height`, so they have to be taken before the
    // height filter below — which otherwise dropped the entire diagnostic
    // channel on the floor.
    if (data && data.type === DIAGNOSTIC_MESSAGE_TYPE) {
      if (DIAGNOSTIC_CODES.indexOf(data.code) !== -1) {
        console.warn('[payment-template] diagnostic: ' + data.code);
      }
      return;
    }
    if (!data || typeof data.height !== 'number') return;
    applyIframeHeight(data.height);
  }

  // Populates the locale switcher from the bundle's own i18n files
  // (previewConfig.availableLocales, already sorted by the server) instead of
  // a hardcoded list of flags, which could advertise locales the bundle never
  // shipped. The leading "Default" option maps to the empty string and stands
  // for previewConfig.defaultLocale, matching the locale the iframe is booted
  // with. Built with createElement/textContent rather than innerHTML, since
  // the locale tags come from the bundle's own filenames.
  function renderLanguageOptions() {
    if (!languageSelect) return;
    var defaultLocale = (previewConfig && previewConfig.defaultLocale) || 'pt-BR';
    var locales = previewConfig && Array.isArray(previewConfig.availableLocales)
      ? previewConfig.availableLocales
      : [];

    languageSelect.textContent = '';

    var defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Default (' + defaultLocale + ')';
    languageSelect.appendChild(defaultOption);

    locales.forEach(function (locale) {
      var option = document.createElement('option');
      option.value = locale;
      option.textContent = locale;
      languageSelect.appendChild(option);
    });

    languageSelect.value = '';
  }

  function loadPreviewConfig(callback) {
    var request = new XMLHttpRequest();
    request.open('GET', PREVIEW_CONFIG_URL, true);
    request.onload = function () {
      if (request.status >= 200 && request.status < 300) {
        try {
          previewConfig = JSON.parse(request.responseText);
        } catch (error) {
          previewConfig = null;
        }
      }
      callback();
    };
    request.onerror = callback;
    request.timeout = 5000;
    request.ontimeout = callback;
    request.send();
  }

  var validationBanner = null;

  // Lazily creates the banner and inserts it as the previous sibling of the
  // payment box's accordion body, so it sits above the payment options and
  // the template iframe without disturbing the knockout bindings on either.
  function ensureValidationBanner() {
    if (validationBanner) return validationBanner;
    var anchor = document.querySelector('.accordion-body.payment-body');
    if (!anchor || !anchor.parentNode) return null;
    validationBanner = document.createElement('div');
    validationBanner.id = 'payment-template-validation-banner';
    validationBanner.style.display = 'none';
    validationBanner.style.margin = '0 0 10px';
    validationBanner.style.padding = '8px 14px';
    validationBanner.style.border = '1px solid #eed3d7';
    validationBanner.style.borderRadius = '4px';
    validationBanner.style.background = '#f2dede';
    validationBanner.style.color = '#b94a48';
    validationBanner.style.fontSize = '13px';
    validationBanner.style.lineHeight = '1.4';
    anchor.parentNode.insertBefore(validationBanner, anchor);
    return validationBanner;
  }

  // Renders the validator's findings as a banner instead of blocking the
  // preview: the dev keeps seeing the template they're building and fixes
  // the errors on their own schedule. Built with createElement/textContent
  // rather than innerHTML, since finding.message/ref.file ultimately come
  // from the bundle's own content.
  function renderValidationBanner(validation) {
    var banner = ensureValidationBanner();
    if (!banner) return;

    var errors = validation && Array.isArray(validation.errors) ? validation.errors : [];
    // Deliberately does NOT also check `validation.ok`:
    // @vtex/payment-templates-core returns `ok: true` even when `errors`
    // is non-empty, as long as every finding in it is a warning (e.g. an
    // unused CSS class) rather than an error. Hiding the banner whenever
    // `ok` was true used to swallow that whole class of findings silently,
    // even though `npm run validate:reference` surfaces them in the
    // terminal. The empty-array check below is what actually covers the
    // genuinely-clean case.
    if (errors.length === 0) {
      banner.style.display = 'none';
      banner.textContent = '';
      return;
    }

    var hasError = errors.some(function (finding) {
      return finding && finding.severity === 'error';
    });

    banner.textContent = '';
    banner.style.background = hasError ? '#f2dede' : '#fcf8e3';
    banner.style.color = hasError ? '#b94a48' : '#8a6d3b';
    banner.style.border = '1px solid ' + (hasError ? '#eed3d7' : '#faebcc');

    var title = document.createElement('strong');
    title.textContent = hasError ? 'Template validation failed:' : 'Template validation warnings:';
    banner.appendChild(title);

    var list = document.createElement('ul');
    list.style.margin = '6px 0 0';
    list.style.paddingLeft = '18px';
    errors.forEach(function (finding) {
      // Same guard as the `hasError` check above: a malformed finding (not a
      // plain object) must be skipped here too, or `finding.ref`/`finding.severity`
      // throw a TypeError that escapes this forEach, is swallowed by
      // loadTemplateValidation's empty catch (meant only for malformed JSON),
      // and leaves the banner cleared (banner.textContent = '' already ran
      // above) with no findings shown and no trace of why.
      if (!finding || typeof finding !== 'object') return;
      var item = document.createElement('li');
      var file = finding.ref && finding.ref.file ? ' (' + finding.ref.file + ')' : '';
      item.textContent = '[' + finding.severity + '] ' + finding.rule + ': ' + finding.message + file;
      list.appendChild(item);
    });
    banner.appendChild(list);
    banner.style.display = 'block';
  }

  function loadTemplateValidation(callback) {
    var request = new XMLHttpRequest();
    request.open('GET', TEMPLATE_VALIDATION_URL, true);
    request.onload = function () {
      if (request.status >= 200 && request.status < 300) {
        try {
          renderValidationBanner(JSON.parse(request.responseText));
        } catch (error) {
          // Malformed payload: leave the banner in whatever state it was.
        }
      }
      if (callback) callback();
    };
    request.onerror = function () {
      if (callback) callback();
    };
    request.timeout = 5000;
    request.ontimeout = function () {
      if (callback) callback();
    };
    request.send();
  }

  function boot() {
    if (!iframe) return;

    iframe.setAttribute('sandbox', 'allow-scripts');

    window.addEventListener('message', onMessage);
    if (languageSelect) {
      languageSelect.addEventListener('change', function () {
        // An empty value is the "Default" option: fall back to the same
        // locale `initialLocale` below resolves to, so picking Default back
        // reproduces exactly the boot state.
        setLocale(this.value || (previewConfig && previewConfig.defaultLocale) || 'pt-BR');
      });
    }
    loadTemplateValidation();

    loadPreviewConfig(function () {
      var initialLocale = previewConfig && previewConfig.defaultLocale ? previewConfig.defaultLocale : 'pt-BR';
      renderLanguageOptions();
      applyPaymentGroupIcon();

      iframe.addEventListener('load', function onLoad() {
        iframe.removeEventListener('load', onLoad);
        appliedHeight = 0;
        setLocale(initialLocale);
        startMeasurePolling();
      });
      iframe.src = IFRAME_SRC + '?' + Date.now();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
