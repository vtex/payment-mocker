'use strict';

const fs = require('fs');
const path = require('path');
const { ORIGIN_PATTERN } = require('@vtex/payment-templates-core/wrap');

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
// Serves @vtex/payment-templates-core/wrap/resolve-locale.js verbatim (see
// serveResolveLocaleScript below) to two consumers: the checkout shell mock
// (src/assets/libs/template-host.js), which runs in the host page, and the
// wrapped iframe document, which loads it as the first of its two
// <script src> tags. One shared file instead of divergent copies of the
// algorithm — resolve-locale.js itself no longer lives in this repo's lib/,
// only this route path (kept stable for both consumers above) does.
const RESOLVE_LOCALE_SCRIPT_PATH = '/lib/resolve-locale.js';
// Serves @vtex/payment-templates-core/wrap/template-runtime.js verbatim (see
// serveTemplateRuntimeScript below) as the wrapped document's second script
// tag. Keeping the runtime a real, servable file (rather than a string a Node
// module builds) is what lets vcs.checkout-ui vendor a byte-for-byte copy and
// diff the two in CI — template-runtime.js itself no longer lives in this
// repo's lib/, only this route path does.
const TEMPLATE_RUNTIME_SCRIPT_PATH = '/lib/template-runtime.js';

function invalidateWrapCache() {
  [
    // wrap-template.js, locale-tag.js, origin-pattern.js and theme-tokens.js
    // moved to @vtex/payment-templates-core/wrap (see the RFC in that repo) —
    // that module is not local source under active edit, so it has nothing to
    // invalidate here. template-runtime.js and resolve-locale.js are streamed
    // from the package's dist/ on every request (see serveResolveLocaleScript
    // / serveTemplateRuntimeScript below), never require()d, so neither has a
    // require.cache entry either.
    './load-bundle.js',
    './preview-config.js',
    './path-contained.js',
    './validation-input.js',
  ].forEach(function (modulePath) {
    try {
      const resolvedId = require.resolve(modulePath);
      delete require.cache[resolvedId];
      // Deleting the cache entry above is not enough on its own: require()
      // also unconditionally pushes the freshly loaded Module onto this
      // file's own `module.children`, with no dedup and nothing that ever
      // removes an old entry. This function runs on nearly every request, so
      // without this, every invalidate+require cycle left one more discarded
      // Module object (and everything it in turn references) reachable
      // forever through this file's module.children, even though nothing
      // could reach it through require.cache anymore — an unbounded leak for
      // a long-running dev server. Splicing out the stale entry before the
      // caller re-requires keeps at most one live child per module path.
      for (let i = module.children.length - 1; i >= 0; i--) {
        if (module.children[i].id === resolvedId) module.children.splice(i, 1);
      }
    } catch (error) {
      // Module may not be loaded yet.
    }
  });
}

function loadBundle(bundleDir) {
  invalidateWrapCache();
  return require('./load-bundle').loadBundle(bundleDir);
}

function isAllowedBundleFilename(name) {
  invalidateWrapCache();
  return require('./load-bundle').isAllowedBundleFilename(name);
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

function wrapTemplate(bundle, defaultLocale, origin, themeTokens) {
  invalidateWrapCache();
  return require('@vtex/payment-templates-core/wrap').wrapTemplate(bundle, defaultLocale, origin, themeTokens);
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

// CONTRACT.md: the icon is "any raster file placed directly under template/"
// — PNG/JPEG/WebP, no subdirectory. Nothing enforced that shape before: an
// `icon` value naming an .html file directly (no symlink needed at all) was
// served as text/html by the icon route, same failure class as an
// extension-less `asset-*` used to let through on the bundle route.
const ICON_FILENAME_PATTERN = /^[^/\\]+\.(?:png|jpe?g|webp)$/i;

const PROTOCOL_PATTERN = /^https?$/;
// ORIGIN_PATTERN itself lives in @vtex/payment-templates-core/wrap (shared
// with that package's own wrap-template.js) — see the import above and that
// module's docblock for why it accepts either a plain hostname or an IPv6
// literal in bracket notation (e.g. `[::1]`), each with an optional port.

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

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * True only for a `Host` header naming this machine itself. Gruntfile.js
 * binds `hostname: '*'` (every interface, not just loopback) so this dev
 * server — which this file's routes hand the partner's own unpublished
 * bundle, its icon, and the validator's findings to, with no auth of any
 * kind — is reachable by anything else on the same network.
 *
 * What this actually closes: DNS rebinding — a browser page whose hostname a
 * DNS answer later points at this machine sends the hostname it navigated to
 * as `Host`, not `localhost`, because a page's own script can never set that
 * header itself (fetch/XHR both refuse to; it's one of the fixed set of
 * headers only the browser's own navigation controls). That request still
 * physically reaches this server over whatever route the DNS answer
 * resolved to, so rejecting a non-local `Host` here is what stops it.
 *
 * What this does NOT close: a non-browser client on the same network — curl,
 * a script, another program — can set `Host` to anything it likes, `Host:
 * localhost` included, and this check has no way to tell that request apart
 * from a real local one; `Host` is just a request header, not a property of
 * which interface the connection actually arrived on. Actually keeping a
 * scripted LAN peer out means binding Gruntfile.js's `connect.options.hostname`
 * (and `watch.livereload.options.livereload.host`, which tiny-lr defaults to
 * `'*'` the same way) to `'localhost'` instead of `'*'` — a larger, deliberate
 * change than this file can make on its own, since it also removes the
 * ability to preview from another device (e.g. a phone) on the same network,
 * which `hostname: '*'` exists to allow in the first place.
 *
 * IPv6 hostnames arrive bracketed (`[::1]:8080`), so the port suffix is
 * stripped by locating the closing bracket rather than splitting on `:` —
 * naively splitting on the first `:` would cut a bracket-less IPv6 literal to
 * pieces, though `Host` headers use the bracketed form exactly to avoid that
 * ambiguity in the first place.
 */
function isLocalHostname(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;
  const hostname = hostHeader[0] === '[' ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
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
      // `themeTokens` is optional and normally absent: production derives these
      // values from the live checkout DOM, which the preview has no equivalent
      // of, so here they are declared by hand to exercise the tokenized branch.
      const html = wrapTemplate(bundle, config.defaultLocale, requestOrigin(req), config.themeTokens);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      // Defense in depth: the isolation this document actually relies on is
      // the parent checkout shell's `<iframe sandbox="allow-scripts">`
      // attribute (src/assets/libs/template-host.js), which only applies when
      // this response is loaded *as* that iframe. Grunt's dev server binds
      // `hostname: '*'` (Gruntfile.js), so this same URL is reachable
      // directly — as a top-level navigation — by anything on the same
      // network, where no iframe attribute exists to sandbox it. A `sandbox`
      // directive can only be delivered via this header, never via the
      // wrapped document's own `<meta http-equiv="Content-Security-Policy">`
      // (wrapTemplate's own CSP, scoped to script-src/style-src/img-src) —
      // the two are independent and both apply. `allow-scripts` alone, with
      // no `allow-same-origin`, still lets the runtime execute but confines
      // it to a unique opaque origin either way this document is loaded.
      res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
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
// npm specifier like `@vtex/payment-templates-core` (no leading slash —
// exactly what a "Cannot find module" error quotes verbatim) contains a `/`
// that this pattern would otherwise happily latch onto, treat as the start of
// a path, and rewrite into a mangled, half-eaten string — the very kind of
// corruption this replaced a naive substring-replace to avoid in the first
// place. Requiring the character right before the `/` to be neither a word
// character nor `@`/`.` means the pattern only fires at an actual path
// boundary (start of string, whitespace, a quote, `:`, `=`, ...).
//
// A segment may also contain a single space immediately followed by an
// uppercase letter — `Mobile Documents`, `My Projects`, `Program Files`, the
// common shape of a real folder name with a space in it, which the plain
// `[^\s'"()]+` below would otherwise stop at, leaving everything past the
// space (including more of the path, and the OS username in it) unredacted.
// The lookahead is what keeps this from also swallowing ordinary prose after
// the path: an English sentence resumes in lowercase ("... contains files
// outside ..."), so the space right after the path itself is never followed
// by an uppercase letter and the match still ends exactly there.
//
// `\p{Lu}` (Unicode "uppercase letter"), not `[A-Z]`: an ASCII-only class
// missed a name like `João Ávila` — "Á" is uppercase but outside A-Z, so the
// match stopped one word early and "Ávila\..." leaked. `\p{Lu}` (with the `u`
// flag below) covers uppercase in any script while still excluding lowercase,
// so it closes that gap without reopening the prose-swallowing one.
//
// KNOWN REMAINING GAP, not closed by this or any character-class tweak: a
// real folder/user name whose second word starts lowercase (`jane doe`, a
// perfectly ordinary display name) is indistinguishable, character by
// character, from resumed lowercase prose ("... contains files ...") — the
// match still stops at that space, and the un-redacted remainder can still
// carry a path fragment past it. Closing this for real means giving up on
// "guess where the path ends" entirely in favor of stripping specific KNOWN
// absolute values (templateRoot, bundlePath, os.homedir(), process.cwd())
// by literal substring first, before falling back to this generic pattern —
// a larger, deliberate design change from the one this file documents below
// (see sanitizeErrorMessage's own docblock on why it currently takes no such
// values as parameters), not attempted here.
//
// `(?<!:\/)` alongside the existing `(?<![\w@.])`: without it, a URL quoted in
// a message (`http://localhost:8080/template-bundle/index.html`) matches too
// — the scheme's `//` looks exactly like an absolute path starting mid-string
// — and gets mangled down to just its basename (`http:index.html`). Neither
// lookbehind alone stops this (the first only blocks starting exactly on the
// character after `:`, and the engine just retries one character later, on
// the second `/`); rejecting a start that is itself immediately preceded by
// `:/` closes both attempts, since by the second one those are exactly the
// two preceding characters. `(?!\/)` on the leading slash is what makes that
// rejection reach the second `/` at all, instead of silently absorbing it as
// part of the same match one position earlier.
const ABSOLUTE_PATH_PATTERN = /(?<![\w@.])(?<!:\/)(?:\/(?!\/)(?:[^\s'"()]|[ ](?=\p{Lu}))+)+/gu;

// The same job for Windows-shaped absolute paths — a drive letter
// (`C:\Users\alice\...`) or a UNC share (`\\server\share\...`) — which the
// Unix pattern above cannot see at all, since they contain no forward slash.
// A message quoting one of those leaks the full path, OS username included,
// exactly like the Unix case. Segment characters are restricted the same way
// (no whitespace, quotes or parens) so the match stops at the end of the path
// rather than eating the rest of the sentence — and, like the Unix pattern
// above, a segment may contain a single space immediately followed by an
// uppercase letter in any script (`C:\Users\Jane Doe\...`, `C:\Users\João
// Ávila\...`), for the same reason, the same `\p{Lu}` fix, and the same
// bound against swallowing trailing prose — and the same known remaining gap
// for a lowercase-starting second word, see the Unix pattern's comment above.
const WINDOWS_SEGMENT = '(?:[^\\s\'"()\\\\]|[ ](?=\\p{Lu}))+';
const WINDOWS_PATH_PATTERN = new RegExp(
  '(?:[A-Za-z]:|\\\\)\\\\' + WINDOWS_SEGMENT + '(?:\\\\' + WINDOWS_SEGMENT + ')*',
  'gu'
);

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
  return String(message)
    .replace(ABSOLUTE_PATH_PATTERN, function (match) {
      return path.basename(match);
    })
    // path.win32 explicitly, not the platform-default `path`: on macOS/Linux
    // — where this dev server usually runs, and where a Windows-shaped path
    // can still reach it through a message it merely relays — `path.basename`
    // is the POSIX one, doesn't treat `\` as a separator, and would hand the
    // entire `C:\Users\alice\...` string back unchanged.
    .replace(WINDOWS_PATH_PATTERN, function (match) {
      return path.win32.basename(match);
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
function loadFailureResult(error) {
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
}

function sendValidationResult(res, result) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(JSON.stringify({ ok: !!result.ok, errors: result.errors || [] }));
}

function serveTemplateValidation(config, req, res, templateRoot) {
  Promise.resolve()
    .then(function () {
      const bundle = loadBundle(config.bundlePath);
      const { validate } = require('@vtex/payment-templates-core');
      const template = toValidationBundle(bundle, config.defaultLocale);
      const input = buildValidationInput(config, template, templateRoot);
      return validate(input);
    })
    .catch(function (error) {
      console.error('Template validation failed to run:', error);
      return loadFailureResult(error);
    })
    .then(function (result) {
      sendValidationResult(res, result);
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

/**
 * `declaredContentType`, when passed, overrides the extension-sniffed value
 * that would otherwise come from `resolvedFile` itself. That distinction
 * matters wherever `resolvedFile` was reached by following a symlink
 * (`fs.realpathSync`) whose *target* has a different extension than the name
 * that actually passed this route's contract/shape check — e.g. a bundle's
 * `asset-x.png` symlinked to an `evil.html` elsewhere in the same bundle:
 * containment still passes (the target is inside the bundle), the name still
 * passes (it's a validly-shaped `asset-*.png`), but sniffing off the resolved
 * target would serve it as `text/html` regardless. Callers that already
 * validated a name against the contract pass that name's own content type
 * here instead of letting the resolved target answer the question.
 */
function streamFile(resolvedFile, res, declaredContentType) {
  res.setHeader('Content-Type', declaredContentType || contentType(resolvedFile));
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
 * Serves the verbatim resolve-locale.js from @vtex/payment-templates-core
 * (the shared source of truth — see that repo's rfc-wrap-runtime.md) as a
 * plain static script. The path is fixed (not derived from the request URL),
 * so there is no user input to validate or contain here.
 */
function serveResolveLocaleScript(req, res) {
  streamFile(require.resolve('@vtex/payment-templates-core/wrap/resolve-locale.js'), res);
}

/**
 * Serves the verbatim template-runtime.js from @vtex/payment-templates-core,
 * the same way serveResolveLocaleScript does. The path is fixed (not derived
 * from the request URL), so there is no user input to validate or contain
 * here.
 */
function serveTemplateRuntimeScript(req, res) {
  streamFile(require.resolve('@vtex/payment-templates-core/wrap/template-runtime.js'), res);
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

  // Checked last, after the traversal/existence checks above so those keep
  // answering with their own, more specific status (403 for an escaping
  // path) — this is purely about what KIND of file `normalizedIcon` may name,
  // regardless of where it resolves to.
  if (!ICON_FILENAME_PATTERN.test(normalizedIcon)) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  streamFile(resolvedFile, res, contentType(normalizedIcon));
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
    const isTemplateRuntimeRoute = pathOnly === TEMPLATE_RUNTIME_SCRIPT_PATH;
    const isValidationRoute = pathOnly === TEMPLATE_VALIDATION_PATH;
    const isIconRoute = req.url.indexOf(ICON_PREFIX) === 0;
    const isBundleRoute = req.url.indexOf(BUNDLE_PREFIX) === 0;

    // None of this middleware's routes match — defer to the next handler in
    // the chain without touching the method at all.
    if (
      !isConfigRoute &&
      !isResolveLocaleRoute &&
      !isTemplateRuntimeRoute &&
      !isValidationRoute &&
      !isIconRoute &&
      !isBundleRoute
    ) {
      next();
      return;
    }

    // Every route this middleware owns hands out the partner's own
    // unpublished bundle, icon or validator findings, with no auth — see
    // isLocalHostname's own docblock for why that matters given Gruntfile.js
    // binds every interface, not just loopback. Checked before the method
    // guard below so a non-local Host is rejected uniformly regardless of
    // method, and before any route-specific handler ever reads the request.
    if (!isLocalHostname(req.headers && req.headers.host)) {
      res.statusCode = 403;
      res.end('Forbidden');
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

    if (isTemplateRuntimeRoute) {
      serveTemplateRuntimeScript(req, res);
      return;
    }

    if (isValidationRoute) {
      let validationConfig;
      try {
        validationConfig = readPreviewConfig(templateRoot);
      } catch (error) {
        // Unlike sendInvalidConfigError's plain-text 500 (used by the other
        // routes below), this route's contract is `{ ok, errors }` JSON — the
        // checkout shell mock's banner only ever renders on a 2xx response
        // from this endpoint. A bad preview.config.json (a malformed
        // defaultLocale, a bundleDir that doesn't exist, ...) used to 500
        // here, which meant exactly the mistakes an author is most likely to
        // make while editing showed no banner at all, only a bare failure in
        // the iframe. Reporting it the same way loadBundle/validate() failures
        // already are keeps this route's own promise: "this endpoint's only
        // job is describing what's wrong with the bundle, so it should never
        // itself be the thing that's broken."
        console.error('Invalid preview.config.json:', error);
        sendValidationResult(res, loadFailureResult(error));
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

    // Same reasoning one step further: containment says *where* a file may
    // live, never *what* it may be called, so this branch used to stream any
    // filename that happened to sit inside the bundle directory — including
    // a stray `evil.html`, served as text/html, at the preview server's own
    // origin and outside the sandboxed iframe. lib/load-bundle.js rejects the
    // whole bundle over such a file, but it is never consulted for an
    // individual request, so the contract check has to happen here too — by
    // asking load-bundle.js itself rather than by restating its rule.
    //
    // Checked against the full `normalizedPath`, not `path.basename(...)`: the
    // bundle contract is a FLAT folder (CONTRACT.md), so a legitimate name is
    // never inside a subdirectory in the first place, and every arm of
    // isAllowedBundleFilename is a full-string match/anchored regex — a nested
    // path like `old/index.html` fails all of them as a whole, whereas taking
    // just its basename would wrongly compare `index.html` alone and pass. That
    // gap mattered here specifically: index.html is the one name this branch
    // must never serve unwrapped (the canonical one is handled above, wrapped
    // and with its CSP), and it was the one name basename-only checking let
    // slip back in through any subdirectory.
    //
    // Lexical, like the dotfile guard above it, and deliberately before any
    // realpathSync/statSync, so a disallowed name answers 404 identically
    // whether or not the file exists.
    if (!isAllowedBundleFilename(normalizedPath)) {
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

    // contentType(normalizedPath), not resolvedFile: normalizedPath already
    // passed isAllowedBundleFilename above, so its own extension is what
    // decides the Content-Type — sniffing resolvedFile instead would trust
    // whatever a symlink inside the bundle actually points to (e.g. a
    // contract-shaped `asset-x.png` symlinked to an `evil.html` elsewhere in
    // the same bundle, which containment alone doesn't catch: the resolved
    // target is still inside the bundle, just not what the name claims it is).
    streamFile(resolvedFile, res, contentType(normalizedPath));
  };
}

module.exports = {
  BUNDLE_PREFIX,
  ICON_PREFIX,
  PREVIEW_CONFIG_PATH,
  RESOLVE_LOCALE_SCRIPT_PATH,
  TEMPLATE_RUNTIME_SCRIPT_PATH,
  TEMPLATE_VALIDATION_PATH,
  createPreviewMiddleware,
  normalizeIndexPath,
  sanitizeErrorMessage,
};
