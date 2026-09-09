'use strict';

const fs = require('fs');
const path = require('path');
const { ORIGIN_PATTERN } = require('./origin-pattern');

const BUNDLE_PREFIX = '/template-bundle/';
const ICON_PREFIX = '/template-icon/';
const PREVIEW_CONFIG_PATH = '/preview.config.json';
// Reports the validator's findings for the currently configured bundle as
// JSON, without ever blocking the wrapped preview on them (see
// serveWrappedIndex below). src/assets/libs/template-host.js polls this to
// render a banner above the payment box instead, so the dev can keep looking
// at the template they're building while they fix the errors on their own
// schedule.
const TEMPLATE_VALIDATION_PATH = '/template-validation.json';
// Serves lib/resolve-locale.js verbatim so the checkout shell mock
// (src/assets/libs/template-host.js) can consume the exact same locale
// resolution logic that wrapper-runtime.js inlines into the iframe, instead
// of maintaining a third, divergent copy of the algorithm.
const RESOLVE_LOCALE_SCRIPT_PATH = '/lib/resolve-locale.js';

function invalidateWrapCache() {
  [
    './wrap-template.js',
    './wrapper-runtime.js',
    './load-bundle.js',
    './preview-config.js',
    './resolve-locale.js',
    './path-contained.js',
    './validation-input.js',
    './locale-tag.js',
    './origin-pattern.js',
  ].forEach(function (modulePath) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch (error) {
      // Module may not be loaded yet.
    }
  });
}

function loadBundle(bundleDir) {
  invalidateWrapCache();
  return require('./load-bundle').loadBundle(bundleDir);
}

function toValidationBundle(bundle, defaultLocale) {
  return require('./load-bundle').toValidationBundle(bundle, defaultLocale);
}

function buildValidationInput(config, template, templateRoot) {
  return require('./validation-input').buildValidationInput(config, template, templateRoot);
}

function readPreviewConfig(templateRoot) {
  invalidateWrapCache();
  return require('./preview-config').readPreviewConfig(templateRoot);
}

function defaultTemplateRoot() {
  invalidateWrapCache();
  return require('./preview-config').TEMPLATE_ROOT;
}

function isPathContained(root, target) {
  invalidateWrapCache();
  return require('./path-contained').isPathContained(root, target);
}

function wrapTemplate(bundle, defaultLocale, origin) {
  invalidateWrapCache();
  return require('./wrap-template').wrapTemplate(bundle, defaultLocale, origin);
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

const PROTOCOL_PATTERN = /^https?$/;
// ORIGIN_PATTERN itself lives in lib/origin-pattern.js (shared with
// wrap-template.js) — see the import above and that module's docblock for
// why it accepts either a plain hostname or an IPv6 literal in bracket
// notation (e.g. `[::1]`), each with an optional port.

function requestProtocol(req) {
  const forwarded = req.headers && req.headers['x-forwarded-proto'];
  const candidate = forwarded
    ? String(forwarded).split(',')[0].trim()
    : req.socket && req.socket.encrypted
    ? 'https'
    : 'http';
  return PROTOCOL_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * Builds the preview server's own origin from request headers, for use as the
 * wrapped document's CSP style-src/img-src. Both the protocol and the fully
 * assembled origin are validated: `Host` and `x-forwarded-proto` are
 * attacker-controlled headers, and interpolating them unvalidated into the
 * CSP meta tag lets a crafted header value break out of the `content="..."`
 * attribute (or smuggle a bogus scheme into the CSP) and inject executable
 * markup. Returning `undefined` on any mismatch makes wrapTemplate fall back
 * to `'self'`, per its existing design.
 */
function requestOrigin(req) {
  if (!req.headers || !req.headers.host) return undefined;
  const protocol = requestProtocol(req);
  if (!protocol) return undefined;
  const origin = protocol + '://' + req.headers.host;
  return ORIGIN_PATTERN.test(origin) ? origin : undefined;
}

/**
 * Normalizes the path portion of a `/template-bundle/...` request URL for the
 * "is this the index?" check. `path.normalize` alone leaves edge cases like
 * `/template-bundle//index.html` (normalizes to the absolute `/index.html`)
 * and `/template-bundle/index.html/` (trailing slash preserved) unmatched
 * against the plain `'index.html'` comparison, so both used to fall through
 * to the static-file branch and serve the raw, unwrapped index.html.
 */
function normalizeIndexPath(relativePath) {
  return path
    .normalize(relativePath)
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+$/, '');
}

function serveWrappedIndex(config, req, res) {
  // Deliberately does NOT gate on validate() here: an author actively editing
  // a bundle is very often mid-edit, and blocking the preview on every rule
  // violation meant they couldn't see what they were building until it was
  // fully fixed. Validation still runs — see serveTemplateValidation below —
  // but only to inform the banner the host page renders, never to withhold
  // the render itself. loadBundle can still throw synchronously (e.g. a file
  // name outside the contract, which leaves nothing to render at all), so
  // this stays wrapped in a promise chain with a single .catch that never
  // lets a synchronous throw escape as an uncaught exception or leak a stack
  // trace/absolute filesystem path back to the client.
  Promise.resolve()
    .then(function () {
      const bundle = loadBundle(config.bundlePath);
      const html = wrapTemplate(bundle, config.defaultLocale, requestOrigin(req));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(html);
    })
    .catch(function (error) {
      console.error('Failed to prepare template preview:', error);
      res.statusCode = 500;
      res.end('Failed to prepare template preview.');
    });
}

// Matches one or more consecutive `/segment` groups — i.e. anything that
// looks like an absolute Unix path — inside an arbitrary error message.
// Deliberately generic (see sanitizeErrorMessage below) rather than a list of
// specific paths to strip.
//
// The leading `(?<![\w@.])` stops a match from starting mid-identifier: a bare
// npm specifier like `@vtex/payment-templates-validator` (no leading slash —
// exactly what a "Cannot find module" error quotes verbatim) contains a `/`
// that this pattern would otherwise happily latch onto, treat as the start of
// a path, and rewrite into a mangled, half-eaten string — the very kind of
// corruption this replaced a naive substring-replace to avoid in the first
// place. Requiring the character right before the `/` to be neither a word
// character nor `@`/`.` means the pattern only fires at an actual path
// boundary (start of string, whitespace, a quote, `:`, `=`, ...).
const ABSOLUTE_PATH_PATTERN = /(?<![\w@.])(?:\/[^\s'"()]+)+/g;

/**
 * Strips the server's absolute filesystem path(s) out of an error message
 * before it's allowed anywhere near the client. `error.message` for the
 * failure modes this guards (loadBundle rejecting a file outside the
 * template contract, a raw ENOENT for a missing index.html/style.css, a
 * `Cannot find module '...'` from a dependency that never got installed,
 * ...) frequently embeds an absolute filesystem path verbatim — including
 * the server's OS username on a typical dev machine. Every other route in
 * this file already takes care never to do this (see sendInvalidConfigError
 * and serveWrappedIndex's .catch); this is the same treatment for
 * serveTemplateValidation.
 *
 * This used to swap out only `config.bundlePath` and `templateRoot`
 * specifically, via plain string replace. That missed any other absolute
 * path an error could mention (e.g. the `Require stack:` entries Node prints
 * for a missing module), and — because it replaced by literal substring
 * rather than being path-aware — could also *corrupt* the message when
 * `templateRoot` sits under a symlinked ancestor (e.g. macOS's
 * `/var` -> `/private/var`, which `os.tmpdir()` resolves through and which
 * the tests already exercise): stripping the un-resolved `templateRoot`
 * prefix out of a resolved path containing `/private/var/...` leaves a
 * mangled fragment like `/privatetemplate/icon.png` behind.
 *
 * Instead of predicting which specific strings might appear, find every
 * substring that merely *looks* like an absolute Unix path
 * (`ABSOLUTE_PATH_PATTERN` above) and collapse each one down to its
 * basename. That keeps the actionable part of the message (which file) while
 * dropping the directory structure and OS username, regardless of which
 * absolute path shows up or how it's spelled.
 *
 * Unlike the old version, this never takes `config`/`templateRoot` as
 * parameters at all — it doesn't need to know either one in advance to do
 * its job. That matters because Gruntfile.js constructs the middleware with
 * createPreviewMiddleware() and no arguments at all in production, so
 * `templateRoot` is `undefined` on that path; a sanitizer that depended on
 * being handed it would silently do half its job (or none of it) on the one
 * code path that actually matters. Resolving the pattern generically sidesteps
 * that dependency entirely instead of working around it with a fallback.
 */
function sanitizeErrorMessage(message) {
  return String(message).replace(ABSOLUTE_PATH_PATTERN, function (match) {
    return path.basename(match);
  });
}

/**
 * Reports the validator's findings for the currently configured bundle as
 * JSON — `{ ok, errors }`, the same shape `validate()` itself returns — for
 * the checkout shell mock to render as a banner. Any failure (a malformed
 * bundle that loadBundle rejects outright, a malformed icon/displayName that
 * makes validate() throw synchronously, ...) is reported the same way, as an
 * `ok: false` finding, rather than a 500: this endpoint's only job is
 * describing what's wrong with the bundle, so it should never itself be the
 * thing that's broken.
 */
function serveTemplateValidation(config, req, res, templateRoot) {
  Promise.resolve()
    .then(function () {
      const bundle = loadBundle(config.bundlePath);
      const { validate } = require('@vtex/payment-templates-validator');
      const template = toValidationBundle(bundle, config.defaultLocale);
      const input = buildValidationInput(config, template, templateRoot);
      return validate(input);
    })
    .catch(function (error) {
      console.error('Template validation failed to run:', error);
      const rawMessage = error && error.message ? error.message : String(error);
      return {
        ok: false,
        errors: [
          {
            rule: 'load',
            severity: 'error',
            message: sanitizeErrorMessage(rawMessage),
          },
        ],
      };
    })
    .then(function (result) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(JSON.stringify({ ok: !!result.ok, errors: result.errors || [] }));
    })
    .catch(function (error) {
      // Belt-and-suspenders: the .catch above already turns every *expected*
      // failure (loadBundle rejecting the bundle, validate() throwing) into a
      // normal { ok: false, errors: [...] } result. This final .catch is only
      // reached if something inside that .catch/.then itself throws
      // unexpectedly (e.g. sanitizeErrorMessage choking on a non-string
      // message) — in which case that rejection would otherwise have no
      // handler downstream, which recent Node versions can escalate to a
      // fatal unhandled-rejection crash. Per this function's own docblock
      // ("this endpoint's only job... it should never itself be the thing
      // that's broken"), log the real error for the dev running the server,
      // but never leak error.message (or anything else about it) to the
      // client — by this point the error is unexpected enough that its
      // content can't be trusted to be safe to show.
      console.error('Template validation route failed unexpectedly:', error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Failed to run template validation.');
      }
    });
}

/**
 * Responds with a fixed, generic message for a broken/missing
 * preview.config.json instead of interpolating `error.message`, which for
 * the common failure modes (missing file, bad JSON) includes the absolute
 * filesystem path of the server (e.g. an ENOENT's `path` property embedded
 * in the message). The real error — path and all — still goes to the
 * server log via console.error for whoever is running the dev server.
 */
function sendInvalidConfigError(res, error) {
  console.error('Invalid preview.config.json:', error);
  res.statusCode = 500;
  res.end('Invalid preview.config.json');
}

/**
 * Serves preview.config.json itself, at the exact URL
 * src/assets/libs/template-host.js fetches it from. Deliberately re-shapes
 * the object rather than forwarding `readPreviewConfig()`'s return value
 * as-is: that function stamps an absolute `bundlePath` onto the config for
 * internal use, and that path must never reach the client.
 */
function servePreviewConfig(req, res, templateRoot) {
  let config;
  try {
    config = readPreviewConfig(templateRoot);
  } catch (error) {
    sendInvalidConfigError(res, error);
    return;
  }

  // The locale switcher in the checkout shell mock is populated from the
  // bundle's own i18n files rather than a hardcoded list, so it can never
  // offer a locale the bundle doesn't actually ship.
  let availableLocales = [];
  try {
    const bundle = loadBundle(config.bundlePath);
    availableLocales = Object.keys(bundle.i18n).sort();
  } catch (error) {
    // Bundle may violate the contract; the validation banner (fetched
    // separately from /template-validation.json) already reports that.
    // Degrade to an empty list here instead of taking the whole route down.
  }

  const clientConfig = {
    bundleDir: config.bundleDir,
    defaultLocale: config.defaultLocale,
    // Always present (possibly empty) so the client never has to handle
    // an undefined case.
    availableLocales,
  };
  if (config.icon !== undefined) clientConfig.icon = config.icon;
  if (config.displayName !== undefined) clientConfig.displayName = config.displayName;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(JSON.stringify(clientConfig));
}

function streamFile(resolvedFile, res) {
  res.setHeader('Content-Type', contentType(resolvedFile));
  res.setHeader('Cache-Control', 'no-cache');
  const stream = fs.createReadStream(resolvedFile);
  // `open` failures (EACCES, the file vanishing between realpathSync and
  // open, ...) surface as an async 'error' event on the stream. Without a
  // listener, that event becomes an uncaughtException and takes down the
  // whole dev server.
  stream.on('error', function () {
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end('Failed to read file');
  });
  stream.pipe(res);
}

/**
 * Serves lib/resolve-locale.js itself as a plain static script. The path is
 * fixed (not derived from the request URL), so there is no user input to
 * validate or contain here.
 */
function serveResolveLocaleScript(req, res) {
  streamFile(path.join(__dirname, 'resolve-locale.js'), res);
}

/**
 * Serves `config.icon` from a dedicated route rooted at TEMPLATE_ROOT, not
 * bundlePath. Per CONTRACT.md the icon is "stored separately from the
 * versioned bundle": resolving it inside the bundle directory leaves no way
 * to configure one that isn't also rejected by loadBundle's contract check
 * (an unreferenced extra file) or the validator's unused-asset check
 * (referenced nowhere in HTML/CSS).
 */
function serveTemplateIcon(req, res, templateRoot) {
  let config;
  try {
    config = readPreviewConfig(templateRoot);
  } catch (error) {
    sendInvalidConfigError(res, error);
    return;
  }

  if (!config.icon) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  let relativePath;
  try {
    relativePath = decodeURIComponent(req.url.slice(ICON_PREFIX.length).split('?')[0]);
  } catch (error) {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  const normalizedPath = normalizeIndexPath(relativePath);
  const normalizedIcon = normalizeIndexPath(config.icon);

  if (normalizedPath.toLowerCase() !== normalizedIcon.toLowerCase()) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  const root = templateRoot || defaultTemplateRoot();
  let resolvedRoot;
  let resolvedFile;
  try {
    resolvedRoot = fs.realpathSync(root);
    resolvedFile = fs.realpathSync(path.join(root, normalizedIcon));
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    res.statusCode = 500;
    res.end('Failed to resolve path');
    return;
  }

  if (!isPathContained(resolvedRoot, resolvedFile)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(resolvedFile);
  } catch (error) {
    // The file can vanish (or become inaccessible) in the window between
    // the realpathSync above and this stat — treat that race the same as
    // "not found" instead of letting a synchronous throw escape to
    // connect's default handler, which would leak a stack trace and an
    // absolute filesystem path back to the client.
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  if (stat.isDirectory()) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  streamFile(resolvedFile, res);
}

function createPreviewMiddleware(options) {
  const templateRoot = options && options.templateRoot;

  return function previewMiddleware(req, res, next) {
    if (!req.url) {
      next();
      return;
    }

    const pathOnly = req.url.split('?')[0];
    const isConfigRoute = pathOnly === PREVIEW_CONFIG_PATH;
    const isResolveLocaleRoute = pathOnly === RESOLVE_LOCALE_SCRIPT_PATH;
    const isValidationRoute = pathOnly === TEMPLATE_VALIDATION_PATH;
    const isIconRoute = req.url.indexOf(ICON_PREFIX) === 0;
    const isBundleRoute = req.url.indexOf(BUNDLE_PREFIX) === 0;

    // None of this middleware's routes match — defer to the next handler in
    // the chain without touching the method at all.
    if (!isConfigRoute && !isResolveLocaleRoute && !isValidationRoute && !isIconRoute && !isBundleRoute) {
      next();
      return;
    }

    // Every route this middleware owns is read-only, so reject any other
    // method uniformly here, before dispatching to a specific route handler.
    // Previously only /preview.config.json and /template-validation.json
    // carried this guard; /template-bundle/..., /template-icon/..., and
    // /lib/resolve-locale.js accepted POST/PUT/DELETE etc. as if they were
    // GET.
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.end('Method Not Allowed');
      return;
    }

    if (isConfigRoute) {
      servePreviewConfig(req, res, templateRoot);
      return;
    }

    if (isResolveLocaleRoute) {
      serveResolveLocaleScript(req, res);
      return;
    }

    if (isValidationRoute) {
      let validationConfig;
      try {
        validationConfig = readPreviewConfig(templateRoot);
      } catch (error) {
        sendInvalidConfigError(res, error);
        return;
      }
      serveTemplateValidation(validationConfig, req, res, templateRoot);
      return;
    }

    if (isIconRoute) {
      serveTemplateIcon(req, res, templateRoot);
      return;
    }

    let config;
    try {
      config = readPreviewConfig(templateRoot);
    } catch (error) {
      sendInvalidConfigError(res, error);
      return;
    }

    let relativePath;
    try {
      relativePath = decodeURIComponent(req.url.slice(BUNDLE_PREFIX.length).split('?')[0]);
    } catch (error) {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }

    const normalizedPath = normalizeIndexPath(relativePath);

    // Lexical containment check FIRST, with no filesystem access: resolving a
    // path via fs.realpathSync requires the target to exist, and doing that
    // before checking containment turns a 403-vs-404 status difference into
    // an oracle that lets an attacker (this dev server listens on all
    // interfaces) enumerate the existence of arbitrary files on disk via
    // `/template-bundle/../../../../etc/passwd`-style requests — independent
    // of whether the escaping path is percent-encoded. `normalizedPath` is
    // already decoded and normalized above, so a plain string-based
    // path.resolve + containment check here is enough to catch every
    // escaping request uniformly, before anything touches the disk.
    //
    // This check — and the "is this the index?" decision right after it —
    // must run on `lexicalTarget` (the resolved absolute path), never on the
    // raw relative string. A URL like `/template-bundle/../reference/index.html`
    // has a relative form that isn't literally `index.html`, but can still
    // *resolve* back inside the bundle (or to the bundle's own index.html)
    // once `..` segments are collapsed. Deciding "is index?" from the
    // pre-resolution string let such a URL slip past both the wrap/CSP path
    // and the containment check's protection into the raw static-file
    // branch below, serving the unwrapped, unvalidated fragment.
    const lexicalTarget = path.resolve(config.bundlePath, normalizedPath);
    if (!isPathContained(config.bundlePath, lexicalTarget)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    // `normalizeIndexPath('')` normalizes to `'.'`, and `path.resolve(bundlePath,
    // '.')` returns `bundlePath` itself, so the first arm below covers the
    // bare `/template-bundle/` request (with its trailing slash — a bare
    // `/template-bundle`, with no trailing slash, doesn't match BUNDLE_PREFIX
    // at all and is sent to `next()` earlier, before any of this code runs);
    // the second arm covers every other path (however it was spelled,
    // including via `..` segments) that resolves to `<bundlePath>/index.html`.
    // Comparison
    // is case-insensitive on purpose: case-insensitive filesystems (default
    // on macOS/APFS, and Windows) resolve `INDEX.HTML` to the same physical
    // file as `index.html`, so a case-sensitive comparison here would let
    // that request fall through to the static-file branch below and serve
    // the raw, unwrapped fragment with no CSP and no validation.
    const indexTarget = path.join(config.bundlePath, 'index.html');
    const isIndex =
      lexicalTarget === config.bundlePath || lexicalTarget.toLowerCase() === indexTarget.toLowerCase();

    if (isIndex) {
      // Only the exact canonical forms are served in place (case-insensitive).
      // Anything else that resolves to the index (a doubled slash, a
      // trailing slash, `./index.html`, `../reference/index.html`, ...) is
      // redirected to the canonical URL instead: serving the wrap directly
      // at a non-canonical URL leaves the wrapped document's *base* URL
      // non-canonical too, so every relative reference in it (style.css,
      // asset-*) resolves against the wrong path and 404s/500s (ENOTDIR) —
      // and, for the `..`-escaping forms specifically, redirecting (rather
      // than serving) means the raw string is never treated as "already the
      // index" and routed around the wrap/CSP/validation path.
      const lowerRelative = relativePath.toLowerCase();
      const isCanonical = lowerRelative === '' || lowerRelative === '.' || lowerRelative === 'index.html';
      if (!isCanonical) {
        const queryIndex = req.url.indexOf('?');
        const querySuffix = queryIndex === -1 ? '' : req.url.slice(queryIndex);
        res.statusCode = 301;
        // Every other response sets this; without it, a dev server's redirect
        // is otherwise cacheable by the browser heuristically/persistently.
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Location', BUNDLE_PREFIX + 'index.html' + querySuffix);
        res.end();
        return;
      }
      serveWrappedIndex(config, req, res);
      return;
    }

    // lib/load-bundle.js deliberately excludes dotfiles (any path segment
    // starting with `.`) from the bundle contract, so nothing that matches
    // one could ever have come from a validated/wrapped bundle in the first
    // place. Without this guard, the static-file branch below would still
    // happily stream them straight off disk by realpath alone — serving
    // `.env`, `.git/config`, editor swap files, etc. over HTTP with no
    // prerequisite at all. `isIndex` is already false here, so the canonical
    // `''`/`.`/`index.html` cases above are unaffected.
    if (normalizedPath.split(path.sep).some(function (segment) { return segment.startsWith('.'); })) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    let resolvedRoot;
    let resolvedFile;
    try {
      resolvedRoot = fs.realpathSync(config.bundlePath);
      resolvedFile = fs.realpathSync(lexicalTarget);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }
      res.statusCode = 500;
      res.end('Failed to resolve path');
      return;
    }

    // Second containment check, now against the realpath'd result: this is
    // what still catches a symlink inside the bundle that points outside it
    // (the lexical check above can't see through symlinks).
    if (!isPathContained(resolvedRoot, resolvedFile)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    let stat;
    try {
      stat = fs.statSync(resolvedFile);
    } catch (error) {
      // The file can vanish (or become inaccessible) in the window between
      // the realpathSync above and this stat — treat that race the same as
      // "not found" instead of letting a synchronous throw escape to
      // connect's default handler, which would leak a stack trace and an
      // absolute filesystem path back to the client.
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    if (stat.isDirectory()) {
      next();
      return;
    }

    streamFile(resolvedFile, res);
  };
}

module.exports = {
  BUNDLE_PREFIX,
  ICON_PREFIX,
  PREVIEW_CONFIG_PATH,
  RESOLVE_LOCALE_SCRIPT_PATH,
  TEMPLATE_VALIDATION_PATH,
  createPreviewMiddleware,
  normalizeIndexPath,
  sanitizeErrorMessage,
};
