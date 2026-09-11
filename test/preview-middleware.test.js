'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const {
  normalizeIndexPath,
  createPreviewMiddleware,
  sanitizeErrorMessage,
  BUNDLE_PREFIX,
  ICON_PREFIX,
  PREVIEW_CONFIG_PATH,
  TEMPLATE_VALIDATION_PATH,
  RESOLVE_LOCALE_SCRIPT_PATH,
  TEMPLATE_RUNTIME_SCRIPT_PATH,
} = require('../lib/preview-middleware');
const { configPathFor, readPreviewConfig } = require('../lib/preview-config');

test('normalizeIndexPath treats an empty relative path as the index', () => {
  // path.normalize('') is '.', not '' — the caller compares against both.
  assert.equal(normalizeIndexPath(''), '.');
});

test('normalizeIndexPath strips a doubled leading slash (/template-bundle//index.html case)', () => {
  assert.equal(normalizeIndexPath('/index.html'), 'index.html');
});

test('normalizeIndexPath strips a trailing slash (/template-bundle/index.html/ case)', () => {
  assert.equal(normalizeIndexPath('index.html/'), 'index.html');
});

test('normalizeIndexPath strips both a leading and trailing slash', () => {
  assert.equal(normalizeIndexPath('/index.html/'), 'index.html');
});

test('normalizeIndexPath leaves a non-index asset path alone', () => {
  assert.equal(normalizeIndexPath('asset-logo.png'), 'asset-logo.png');
});

/**
 * Exercises createPreviewMiddleware() with plain object req/res stand-ins (no
 * real sockets/network) — a fake Writable captures whatever the middleware
 * writes so assertions can inspect status code and body.
 *
 * The middleware itself is pointed at a disposable copy of template/ (see the
 * `before`/`after` hooks below) rather than the real, git-tracked directory:
 * `withPreviewConfig` below mutates preview.config.json to exercise
 * misconfiguration paths, and doing that against the checked-in file directly
 * risked leaving it corrupted if a future bug ever caused a handler to hang
 * (see the `invokeMiddleware` timeout for the other half of that concern).
 */
function createRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  });
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = function (name, value) {
    res.headers[name] = value;
  };
  res.body = function () {
    return Buffer.concat(chunks).toString('utf8');
  };
  return res;
}

const INVOKE_TIMEOUT_MS = 2000;

/**
 * Invokes the middleware and resolves with the res stand-in once it finishes
 * (or calls `next()`). Rejects after INVOKE_TIMEOUT_MS instead of hanging
 * forever if a future bug causes the middleware to neither end the response
 * nor call `next()` — without this, such a bug would hang the test run
 * indefinitely (or, before the temp-dir isolation above, leave a Ctrl-C'd run
 * with the real preview.config.json still swapped out).
 */
function invokeMiddleware(req) {
  const middleware = createPreviewMiddleware({ templateRoot: tempTemplateRoot });
  return new Promise((resolve, reject) => {
    const res = createRes();
    const timer = setTimeout(() => {
      reject(
        new Error(
          'invokeMiddleware timed out after ' +
            INVOKE_TIMEOUT_MS +
            'ms — the middleware never called res.end()/next() for ' +
            req.url
        )
      );
    }, INVOKE_TIMEOUT_MS);
    function settle(value) {
      clearTimeout(timer);
      resolve(value);
    }
    res.on('finish', () => settle(res));
    res.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    middleware(req, res, function next() {
      settle(res);
    });
  });
}

/**
 * Like invokeMiddleware, but builds the middleware with createPreviewMiddleware()
 * called with ZERO arguments — the only way Gruntfile.js actually constructs
 * it in production. Every other test in this file passes
 * { templateRoot: tempTemplateRoot } explicitly, so none of them exercise the
 * real default-root fallback inside createPreviewMiddleware/readPreviewConfig
 * (e.g. `options && options.templateRoot`, `templateRoot || TEMPLATE_ROOT`) —
 * a regression there (say, losing the `||` while refactoring to
 * destructuring) would sail through the whole suite unnoticed. This reads
 * the real, git-tracked template/preview.config.json, so it must stay
 * read-only: no withPreviewConfig, no writes, nothing that could leave that
 * checked-in file mutated.
 */
function invokeMiddlewareWithDefaultRoot(req) {
  const middleware = createPreviewMiddleware();
  return new Promise((resolve, reject) => {
    const res = createRes();
    const timer = setTimeout(() => {
      reject(
        new Error(
          'invokeMiddlewareWithDefaultRoot timed out after ' +
            INVOKE_TIMEOUT_MS +
            'ms — the middleware never called res.end()/next() for ' +
            req.url
        )
      );
    }, INVOKE_TIMEOUT_MS);
    function settle(value) {
      clearTimeout(timer);
      resolve(value);
    }
    res.on('finish', () => settle(res));
    res.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    middleware(req, res, function next() {
      settle(res);
    });
  });
}

function makeReq(relativePath, overrides) {
  return Object.assign(
    {
      url: BUNDLE_PREFIX + relativePath,
      headers: { host: 'localhost:8080' },
    },
    overrides
  );
}

function makeIconReq(relativePath) {
  return {
    url: ICON_PREFIX + relativePath,
    headers: { host: 'localhost:8080' },
  };
}

function makeConfigReq(overrides) {
  return Object.assign(
    {
      url: PREVIEW_CONFIG_PATH,
      headers: { host: 'localhost:8080' },
    },
    overrides
  );
}

function makeValidationReq(overrides) {
  return Object.assign(
    {
      url: TEMPLATE_VALIDATION_PATH,
      headers: { host: 'localhost:8080' },
    },
    overrides
  );
}

/**
 * Recursively copies `src` into `dest` (both directories). Node's fs.cpSync
 * with { recursive: true } does exactly this in one call.
 */
function copyTemplateTree(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

const REAL_TEMPLATE_ROOT = path.join(__dirname, '..', 'template');

let tempContainer;
let tempTemplateRoot;
let CONFIG_PATH;

test.before(() => {
  // The template copy lives one level *below* tempContainer (not directly at
  // the mkdtemp root) so a "package.json" placed alongside it can stand in
  // for the real repo's package.json in the "escapes template/" test below —
  // a real file that exists one level above tempTemplateRoot, without
  // reaching outside this test's own disposable directory to find one.
  tempContainer = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-mocker-template-'));
  tempTemplateRoot = path.join(tempContainer, 'template');
  copyTemplateTree(REAL_TEMPLATE_ROOT, tempTemplateRoot);
  fs.writeFileSync(path.join(tempContainer, 'package.json'), JSON.stringify({ name: 'escape-target-stub' }));

  // Every call in this file passes tempTemplateRoot explicitly (to
  // createPreviewMiddleware({ templateRoot }) or readPreviewConfig(root)) —
  // no env var, no module cache tricks — so this never touches the real,
  // checked-in template/ directory.
  CONFIG_PATH = configPathFor(tempTemplateRoot);
});

test.after(() => {
  fs.rmSync(tempContainer, { recursive: true, force: true });
});

/**
 * Temporarily swaps the temp copy's preview.config.json for `configObj` for
 * the duration of `fn`, restoring the original content afterwards even if
 * `fn` throws. This mutates only the disposable temp directory created in
 * `before()`, never the checked-in template/preview.config.json.
 */
async function withPreviewConfig(configObj, fn) {
  const original = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configObj));
  try {
    await fn();
  } finally {
    fs.writeFileSync(CONFIG_PATH, original);
  }
}

test('createPreviewMiddleware: path traversal outside the bundle dir is rejected with 403', async () => {
  const res = await invokeMiddleware(makeReq('../CONTRACT.md'));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body(), 'Forbidden');
});

test('createPreviewMiddleware: a missing bundle file responds 404', async () => {
  const res = await invokeMiddleware(makeReq('does-not-exist.png'));
  assert.equal(res.statusCode, 404);
  assert.equal(res.body(), 'Not Found');
});

test('createPreviewMiddleware: a path traversal escape responds 403 whether or not the target exists (no existence oracle)', async () => {
  // Before the fix, containment was only checked *after* fs.realpathSync,
  // which requires the target to exist — so an escaping path to a real file
  // (package.json, one level above template/) answered 403, while an
  // escaping path to a made-up file answered 404, letting a network peer
  // enumerate arbitrary file existence on the dev's disk.
  const existing = await invokeMiddleware(makeReq('../../package.json'));
  const missing = await invokeMiddleware(makeReq('../../this-file-does-not-exist-anywhere.xyz'));
  assert.equal(existing.statusCode, 403);
  assert.equal(missing.statusCode, 403);
  assert.equal(existing.body(), missing.body());
});

test('createPreviewMiddleware: a `..`-escape that resolves back to the bundle index is never served as a raw fragment', async () => {
  // The checked-in preview.config.json's bundleDir is "reference", so
  // resolving "<bundlePath>/../reference/index.html" lands back on
  // "<bundlePath>/index.html" exactly. Before the fix, the "is this the
  // index?" decision ran on the *raw relative string* ('../reference/index.html'),
  // which isn't literally 'index.html'/''/'.', so this fell through to the
  // static-file branch and served the raw, unwrapped template/reference/index.html
  // fragment — no doctype, no CSP, no i18n runtime, and never validated.
  // The fix must classify this by the *resolved* path instead, so the request
  // ends up either 403'd or redirected into the wrapped/validated index path,
  // but never serving the raw fragment as a top-level document.
  const variants = ['../reference/index.html', '../reference/INDEX.HTML', 'x/../../reference/index.html'];

  for (const variant of variants) {
    const res = await invokeMiddleware(makeReq(variant));
    const body = res.body();
    // The raw fragment (template/reference/index.html) has no <!doctype> and
    // no CSP meta tag — it starts with `<section class="pay">`. Directly
    // assert on the tell-tale absence of the CSP meta tag rather than the
    // presence of a doctype (the fragment never had one, so that check would
    // pass trivially and miss the bypass entirely).
    assert.ok(
      res.statusCode !== 200 || body.includes('Content-Security-Policy'),
      'a 200 response for ' + variant + ' must be the wrapped document (with CSP), never the raw fragment'
    );
    assert.ok(
      res.statusCode === 403 || res.statusCode === 301 || res.statusCode === 200,
      'expected 403 (contained-out), 301 (redirect to canonical index), or 200 (wrapped) for ' + variant
    );
    if (res.statusCode === 301) {
      assert.equal(res.headers['Location'], BUNDLE_PREFIX + 'index.html');
    }
  }
});

test('createPreviewMiddleware: a percent-encoded `..`-escape that resolves back to the bundle index is never served as a raw fragment', async () => {
  const res = await invokeMiddleware(makeReq('..%2Freference%2Findex.html', { url: BUNDLE_PREFIX + '%2e%2e/reference/index.html' }));
  const body = res.body();
  assert.ok(
    res.statusCode !== 200 || body.includes('Content-Security-Policy'),
    'a 200 response must be the wrapped document (with CSP), never the raw fragment'
  );
  assert.ok(res.statusCode === 403 || res.statusCode === 301 || res.statusCode === 200);
  if (res.statusCode === 301) {
    assert.equal(res.headers['Location'], BUNDLE_PREFIX + 'index.html');
  }
});

test('createPreviewMiddleware: a symlink inside the bundle pointing outside it responds 403 (realpath containment check)', async () => {
  // The lexical containment check (above) can't see through symlinks — it
  // only ever inspects the string form of the request path. This test
  // exercises the *second* containment check, done against the realpath'd
  // result, which is the only defense against a symlink physically present
  // inside the bundle directory that points somewhere outside it.
  const config = readPreviewConfig(tempTemplateRoot);
  const symlinkPath = path.join(config.bundlePath, 'asset-evil-symlink.png');
  fs.symlinkSync('/etc/hosts', symlinkPath);
  try {
    const res = await invokeMiddleware(makeReq('asset-evil-symlink.png'));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body(), 'Forbidden');
  } finally {
    fs.rmSync(symlinkPath, { force: true });
  }
});

test('createPreviewMiddleware: a dotfile inside the bundle responds 404 even though it exists and is contained', async () => {
  // lib/load-bundle.js deliberately excludes dotfiles from the bundle
  // contract. Before the fix, the static-file branch only checked path
  // containment (never filename), so a dotfile physically present inside the
  // bundle dir — .env, .DS_Store, a leftover editor swap file, ... — was
  // still streamed straight off disk with a 200, with no symlink and no
  // bundle-contract check involved at all.
  const config = readPreviewConfig(tempTemplateRoot);
  const dotfilePath = path.join(config.bundlePath, '.env');
  fs.writeFileSync(dotfilePath, 'SECRET=should-not-be-servable');
  try {
    const res = await invokeMiddleware(makeReq('.env'));
    assert.equal(res.statusCode, 404);
    assert.equal(res.body(), 'Not Found');
  } finally {
    fs.rmSync(dotfilePath, { force: true });
  }
});

test('createPreviewMiddleware: a dotfile nested in a dot-directory inside the bundle responds 404', async () => {
  // Covers a dotfile inside a dot-*directory* (e.g. `.git/config`), not just
  // a dotfile at the top level — the guard must reject on ANY path segment
  // starting with `.`, not only the last one.
  const config = readPreviewConfig(tempTemplateRoot);
  const dotDirPath = path.join(config.bundlePath, '.hidden');
  const dotfilePath = path.join(dotDirPath, 'config');
  fs.mkdirSync(dotDirPath, { recursive: true });
  fs.writeFileSync(dotfilePath, 'value\n');
  try {
    const res = await invokeMiddleware(makeReq('.hidden/config'));
    assert.equal(res.statusCode, 404);
    assert.equal(res.body(), 'Not Found');
  } finally {
    fs.rmSync(dotDirPath, { recursive: true, force: true });
  }
});

test('createPreviewMiddleware: an invalid percent-escape in the URL responds 400', async () => {
  const res = await invokeMiddleware(makeReq('%'));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body(), 'Bad Request');
});

test('createPreviewMiddleware: an upper-case INDEX.HTML request is wrapped, not served raw', async () => {
  const res = await invokeMiddleware(makeReq('INDEX.HTML'));
  assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');
  const body = res.body();
  assert.ok(body.startsWith('<!doctype html>'), 'must be the wrapped document, not the raw fragment');
  assert.ok(body.includes('Content-Security-Policy'), 'the wrap must inject the CSP meta tag');
  assert.ok(body.includes('payment-template-i18n'), 'the wrap must inject the i18n data block');
});

test('createPreviewMiddleware: a trailing slash on the wrapped index redirects to the canonical URL', async () => {
  const res = await invokeMiddleware(makeReq('index.html/'));
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers['Location'], BUNDLE_PREFIX + 'index.html');
});

test('createPreviewMiddleware: the redirect to the canonical index preserves the query string', async () => {
  const res = await invokeMiddleware(makeReq('index.html/', { url: BUNDLE_PREFIX + 'index.html/?locale=en-US' }));
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers['Location'], BUNDLE_PREFIX + 'index.html?locale=en-US');
});

test('createPreviewMiddleware: the redirect to the canonical index sets Cache-Control: no-cache', async () => {
  const res = await invokeMiddleware(makeReq('index.html/'));
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers['Cache-Control'], 'no-cache');
});

// The /template-icon/ route (ICON_PREFIX) serves `config.icon` from
// TEMPLATE_ROOT rather than from bundlePath, with its own containment check.
// The checked-in template/preview.config.json points `icon` at `icon.png`.

test('createPreviewMiddleware (icon route): a filename that does not match config.icon responds 404', async () => {
  const res = await invokeMiddleware(makeIconReq('not-the-configured-icon.png'));
  assert.equal(res.statusCode, 404);
});

test('createPreviewMiddleware (icon route): no icon configured responds 404', async () => {
  await withPreviewConfig({ bundleDir: 'reference', defaultLocale: 'pt-BR' }, async () => {
    const res = await invokeMiddleware(makeIconReq('icon.png'));
    assert.equal(res.statusCode, 404);
  });
});

test('createPreviewMiddleware (icon route): an icon path escaping template/ responds 403', async () => {
  // package.json exists at the repo root, one level above the temp copy of
  // template/ — real file, so realpathSync succeeds and containment is what
  // rejects it.
  await withPreviewConfig(
    { bundleDir: 'reference', defaultLocale: 'pt-BR', icon: '../package.json' },
    async () => {
      const res = await invokeMiddleware(makeIconReq('../package.json'));
      assert.equal(res.statusCode, 403);
    }
  );
});

test('createPreviewMiddleware (icon route): the configured icon path responds 200 with an image content-type', async () => {
  const res = await invokeMiddleware(makeIconReq('icon.png'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/png');
});

// The /preview.config.json route (servePreviewConfig) is the whole reason
// the client-facing config is re-shaped instead of forwarding
// readPreviewConfig()'s return value as-is: that function stamps an absolute
// bundlePath onto the config for internal use, which must never reach the
// browser.

test('createPreviewMiddleware (config route): responds 200 with a JSON content-type', async () => {
  const res = await invokeMiddleware(makeConfigReq());
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /^application\/json/);
});

test('createPreviewMiddleware (config route): the response body never includes the absolute bundlePath', async () => {
  const res = await invokeMiddleware(makeConfigReq());
  const body = JSON.parse(res.body());
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'bundlePath'), false);
  // Sanity check this is actually the real config, not an empty stub.
  assert.equal(body.bundleDir, 'reference');
  assert.equal(body.defaultLocale, 'pt-BR');
});

test('createPreviewMiddleware() called with zero arguments (the real production path) serves the real template/preview.config.json', async () => {
  // Gruntfile.js calls createPreviewMiddleware() with no arguments at all —
  // every other test in this file passes { templateRoot: tempTemplateRoot }
  // and never touches this default-root fallback. This is a read-only GET
  // against the checked-in template/preview.config.json (bundleDir:
  // 'reference', defaultLocale: 'pt-BR' — confirmed by reading that file
  // directly), so no withPreviewConfig/mutation is involved.
  const res = await invokeMiddlewareWithDefaultRoot(makeConfigReq());
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body());
  assert.equal(body.bundleDir, 'reference');
  assert.equal(body.defaultLocale, 'pt-BR');
});

test('createPreviewMiddleware (config route): availableLocales lists the bundle\'s own i18n locales, sorted', async () => {
  // The locale switcher in src/assets/libs/template-host.js is populated from
  // this field instead of a hardcoded list of flags, which used to advertise
  // fr-FR and es-ES even though no bundle ever shipped them. The reference
  // bundle (copied into tempTemplateRoot) ships exactly i18n-pt-BR.json and
  // i18n-en-US.json.
  const res = await invokeMiddleware(makeConfigReq());
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body());
  assert.deepEqual(body.availableLocales, ['en-US', 'pt-BR']);
});

test('createPreviewMiddleware (config route): a contract-breaking bundle still responds 200 with an empty availableLocales', async () => {
  // A file that matches neither the i18n nor the asset-* naming rules makes
  // loadBundle() throw. That must not take the whole config route down: the
  // dev still needs bundleDir/defaultLocale/displayName to render the shell,
  // and the contract violation itself is already reported by the separate
  // /template-validation.json banner. Same temp-file technique the dotfile
  // tests above use, so the checked-in template/ is never touched.
  const config = readPreviewConfig(tempTemplateRoot);
  const strayPath = path.join(config.bundlePath, 'not-in-the-contract.txt');
  fs.writeFileSync(strayPath, 'breaks the bundle contract');
  try {
    const res = await invokeMiddleware(makeConfigReq());
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body());
    assert.deepEqual(body.availableLocales, []);
    // The rest of the config still has to come through.
    assert.equal(body.bundleDir, 'reference');
  } finally {
    fs.rmSync(strayPath, { force: true });
  }
});

test('createPreviewMiddleware (config route): a malformed preview.config.json responds 500 with a generic message, no filesystem path', async () => {
  await withPreviewConfig({ bundleDir: 'reference' }, async () => {
    // Missing defaultLocale — readPreviewConfig() throws synchronously.
    const res = await invokeMiddleware(makeConfigReq());
    assert.equal(res.statusCode, 500);
    const body = res.body();
    assert.equal(body, 'Invalid preview.config.json');
    assert.ok(!body.includes(tempTemplateRoot), 'must not leak the server filesystem path');
  });
});

test('createPreviewMiddleware (config route): a non-GET/HEAD method responds 405', async () => {
  const res = await invokeMiddleware(makeConfigReq({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Allow'], 'GET, HEAD');
});

// The wrapped index used to block on validate() and serve an error page
// instead of the bundle when it failed. It no longer does: the dev should
// keep seeing the template they're building, with the checkout shell mock
// (src/assets/libs/template-host.js) showing the errors as a banner instead.
// /template-validation.json is what feeds that banner.

test('createPreviewMiddleware (validation route): a valid bundle responds 200 with ok:true and no errors', async () => {
  const res = await invokeMiddleware(makeValidationReq());
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /^application\/json/);
  const body = JSON.parse(res.body());
  assert.equal(body.ok, true);
  assert.deepEqual(body.errors, []);
});

test('createPreviewMiddleware (validation route): an invalid bundle responds 200 with ok:false and a non-empty errors list', async () => {
  // displayName over the 90-code-point limit (CONTRACT.md) is a deterministic
  // validation failure, independent of any CSS/HTML relationship in the
  // reference bundle.
  await withPreviewConfig(
    {
      bundleDir: 'reference',
      defaultLocale: 'pt-BR',
      displayName: { 'pt-BR': 'A'.repeat(91), 'en-US': 'Example Pay' },
    },
    async () => {
      const res = await invokeMiddleware(makeValidationReq());
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body());
      assert.equal(body.ok, false);
      assert.ok(Array.isArray(body.errors) && body.errors.length > 0);
    }
  );
});

test('createPreviewMiddleware (validation route): a loadBundle failure (file outside the template contract) responds 200 with ok:false and never leaks the server filesystem path', async () => {
  // Unlike the displayName-too-long case above (validate() runs and returns
  // ok:false normally), a stray file outside load-bundle.js's contract makes
  // loadBundle() throw *synchronously*, before validate() ever runs — the
  // path this endpoint's own .catch is responsible for. Before the fix, that
  // .catch put error.message (which embeds the bundle's absolute path) raw
  // into the JSON response.
  const config = readPreviewConfig(tempTemplateRoot);
  const strayFilePath = path.join(config.bundlePath, 'notes.txt');
  fs.writeFileSync(strayFilePath, 'not part of the contract');
  try {
    const res = await invokeMiddleware(makeValidationReq());
    assert.equal(res.statusCode, 200);
    const rawBody = res.body();
    const body = JSON.parse(rawBody);
    assert.equal(body.ok, false);
    assert.equal(body.errors[0].rule, 'load');
    assert.ok(!rawBody.includes(tempTemplateRoot), 'must not leak the server filesystem path');
  } finally {
    fs.rmSync(strayFilePath, { force: true });
  }
});

test('createPreviewMiddleware (validation route) called with zero arguments (the real production path): a loadBundle failure still never leaks the server filesystem path', async () => {
  // Same failure mode as the loadBundle-failure test above (a stray file
  // outside load-bundle.js's contract), but invoked the way Gruntfile.js
  // actually constructs the middleware in production: createPreviewMiddleware()
  // with zero arguments, so templateRoot is undefined all the way down to
  // sanitizeErrorMessage too. Before the fix, sanitizeErrorMessage only
  // sanitized `templateRoot`/`config.bundlePath` when a caller handed them
  // over explicitly; every other test in this file passes
  // { templateRoot: tempTemplateRoot }, so none of them exercised this path,
  // and the real server — which never passes templateRoot at all — leaked
  // the raw absolute path, OS username included, straight to the client.
  const config = readPreviewConfig(); // real, checked-in template/, default root
  const strayFilePath = path.join(config.bundlePath, 'notes.txt');
  fs.writeFileSync(strayFilePath, 'not part of the contract');
  try {
    const res = await invokeMiddlewareWithDefaultRoot(makeValidationReq());
    assert.equal(res.statusCode, 200);
    const rawBody = res.body();
    const body = JSON.parse(rawBody);
    assert.equal(body.ok, false);
    assert.equal(body.errors[0].rule, 'load');
    assert.ok(!rawBody.includes(REAL_TEMPLATE_ROOT), 'must not leak the server filesystem path');
    assert.ok(!rawBody.includes(config.bundlePath), 'must not leak the absolute bundle path');
  } finally {
    fs.rmSync(strayFilePath, { force: true });
  }
});

// sanitizeErrorMessage itself (unit-level, not just through the validation
// route): the old implementation only ever rewrote two specific strings
// (config.bundlePath and templateRoot) via split/join. These exercise the
// generic regex replacement directly, covering exactly the two failure modes
// that split/join could not: an absolute path that is neither of the two
// predicted strings, and a resolved path that would have been *corrupted*
// (not just left exposed) by a naive substring swap.
test('sanitizeErrorMessage redacts an absolute path outside the two previously-known cases (bundlePath/templateRoot)', () => {
  // Stands in for `require('@vtex/payment-templates-validator')` failing
  // because the dependency isn't installed — a realistic incomplete-`npm i`
  // scenario. Node's real message for this also quotes the bare specifier
  // '@vtex/payment-templates-validator' verbatim, which is not itself a
  // filesystem path and must survive untouched.
  const message =
    "Cannot find module '@vtex/payment-templates-validator'\nRequire stack:\n- /Users/carolinaalmeida/Documents/vtex/payment-mocker/lib/preview-middleware.js";
  const sanitized = sanitizeErrorMessage(message);
  assert.ok(!sanitized.includes('/Users/carolinaalmeida'), 'the absolute require-stack path must be stripped');
  assert.ok(sanitized.includes('preview-middleware.js'), 'the actionable filename must survive');
  assert.ok(sanitized.includes("'@vtex/payment-templates-validator'"), 'the bare module specifier is not a path and must be left alone');
});

test('sanitizeErrorMessage does not corrupt a path via prefix substitution when it sits under a symlinked ancestor', () => {
  // The old split/join approach replaced the literal `templateRoot` string,
  // which breaks when the error's message instead contains the *resolved*
  // form of that same path (e.g. macOS's /var -> /private/var, which
  // os.tmpdir()/fs.realpathSync resolve through and which this suite's own
  // tempTemplateRoot lives under): splitting on the unresolved templateRoot
  // string against a resolved-symlink message finds no match, or — if the
  // unresolved prefix happens to appear elsewhere in the resolved string —
  // splices out only part of it, leaving a mangled path like
  // "/privatetemplate/icon.png" that doesn't correspond to anything real.
  // The regex-based approach never does prefix substitution at all, so this
  // can't happen regardless of whether the path in the message is resolved.
  const message = "ENOENT: no such file or directory, open '/private/var/folders/xy/T/payment-mocker-template-abc123/template/icon.png'";
  const sanitized = sanitizeErrorMessage(message);
  assert.ok(!sanitized.includes('/private/var'), 'no resolved-symlink path fragment should leak');
  assert.ok(!sanitized.includes('privatetemplate'), 'must never merge into a mangled, non-existent path');
  assert.ok(sanitized.includes('icon.png'), 'the actionable filename must survive');
});

test('createPreviewMiddleware (validation route): a non-GET/HEAD method responds 405', async () => {
  const res = await invokeMiddleware(makeValidationReq({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Allow'], 'GET, HEAD');
});

test('createPreviewMiddleware (validation route): a malformed preview.config.json responds 500 with a generic message, no filesystem path', async () => {
  await withPreviewConfig({ bundleDir: 'reference' }, async () => {
    // Missing defaultLocale — readPreviewConfig() throws synchronously, the
    // same failure mode already covered for the config route above, but here
    // exercised through the validation route's own readPreviewConfig() call.
    const res = await invokeMiddleware(makeValidationReq());
    assert.equal(res.statusCode, 500);
    const body = res.body();
    assert.equal(body, 'Invalid preview.config.json');
    assert.ok(!body.includes(tempTemplateRoot), 'must not leak the server filesystem path');
  });
});

// Every route this middleware owns must reject non-GET/HEAD methods
// uniformly (see the guard at the top of previewMiddleware). The config and
// validation routes are covered above; these two cover the icon and
// resolve-locale-script routes, which previously accepted any method.

test('createPreviewMiddleware (icon route): a non-GET/HEAD method responds 405', async () => {
  const res = await invokeMiddleware(Object.assign(makeIconReq('icon.png'), { method: 'DELETE' }));
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Allow'], 'GET, HEAD');
});

test('createPreviewMiddleware (resolve-locale script route): a non-GET/HEAD method responds 405', async () => {
  const res = await invokeMiddleware({
    url: RESOLVE_LOCALE_SCRIPT_PATH,
    headers: { host: 'localhost:8080' },
    method: 'PUT',
  });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Allow'], 'GET, HEAD');
});

test('createPreviewMiddleware (resolve-locale script route): GET serves the real lib/resolve-locale.js source, not just a 200', async () => {
  // res.statusCode defaults to 200 in createRes() above, so asserting only
  // the status code would pass even if this route served the wrong file, an
  // empty body, or nothing at all — it never actually confirms the route
  // serves lib/resolve-locale.js. Assert on the response body containing the
  // real function definition, and on the Content-Type this route sets.
  const res = await invokeMiddleware({
    url: RESOLVE_LOCALE_SCRIPT_PATH,
    headers: { host: 'localhost:8080' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/javascript; charset=utf-8');
  assert.match(res.body(), /function resolveLocale/);
});

test('createPreviewMiddleware (template-runtime script route): a non-GET/HEAD method responds 405', async () => {
  const res = await invokeMiddleware({
    url: TEMPLATE_RUNTIME_SCRIPT_PATH,
    headers: { host: 'localhost:8080' },
    method: 'PUT',
  });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Allow'], 'GET, HEAD');
});

test('createPreviewMiddleware (template-runtime script route): GET serves the real lib/template-runtime.js file, byte for byte', async () => {
  // Same reasoning as the resolve-locale route test above: a status-code-only
  // assertion would pass on an empty body or the wrong file. This route is
  // what vcs.checkout-ui vendors from, so compare against the file on disk.
  const res = await invokeMiddleware({
    url: TEMPLATE_RUNTIME_SCRIPT_PATH,
    headers: { host: 'localhost:8080' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/javascript; charset=utf-8');
  const onDisk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'template-runtime.js'), 'utf8');
  assert.equal(res.body(), onDisk);
});

test('createPreviewMiddleware: a non-GET/HEAD method on a URL this middleware does not own is passed through to next(), not 405\'d', async () => {
  // The 405 guard must only apply to this middleware's own routes; anything
  // else should still fall through untouched.
  const res = await invokeMiddleware({ url: '/some-other-route', headers: { host: 'localhost:8080' }, method: 'POST' });
  assert.equal(res.statusCode, 200); // untouched res stand-in default; next() was called
});

test('createPreviewMiddleware (icon route): an invalid percent-escape in the URL responds 400', async () => {
  const res = await invokeMiddleware({ url: ICON_PREFIX + '%', headers: { host: 'localhost:8080' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body(), 'Bad Request');
});

// requestOrigin/requestProtocol (preview-middleware.js) build the wrapped
// document's CSP origin from request headers and validate it before use;
// these were previously only exercised indirectly (via wrap-template.test.js
// calling wrapTemplate directly with a literal origin string), never through
// the middleware's own header-derived construction.

test('createPreviewMiddleware: a Host header that fails ORIGIN_PATTERN falls back to CSP style-src \'self\' instead of being interpolated', async () => {
  const res = await invokeMiddleware(
    makeReq('', { headers: { host: 'evil.com"><script>alert(1)</script>' } })
  );
  assert.equal(res.statusCode, 200);
  const body = res.body();
  assert.ok(body.includes("style-src 'self'"));
  assert.ok(!body.includes('<script>alert(1)</script>'), 'the raw hostile Host header must not appear unescaped');
});

test('createPreviewMiddleware: an x-forwarded-proto: https header scopes the CSP to https://<host>', async () => {
  const res = await invokeMiddleware(
    makeReq('', { headers: { host: 'localhost:8080', 'x-forwarded-proto': 'https' } })
  );
  assert.equal(res.statusCode, 200);
  const body = res.body();
  assert.ok(body.includes('style-src https://localhost:8080'));
});

test('createPreviewMiddleware: an invalid x-forwarded-proto value is ignored, falling back to CSP style-src \'self\'', async () => {
  const res = await invokeMiddleware(
    makeReq('', { headers: { host: 'localhost:8080', 'x-forwarded-proto': 'javascript' } })
  );
  assert.equal(res.statusCode, 200);
  const body = res.body();
  assert.ok(body.includes("style-src 'self'"));
});

test('createPreviewMiddleware: the wrapped index still renders an invalid bundle, it is never replaced by a block page', async () => {
  await withPreviewConfig(
    {
      bundleDir: 'reference',
      defaultLocale: 'pt-BR',
      displayName: { 'pt-BR': 'A'.repeat(91), 'en-US': 'Example Pay' },
    },
    async () => {
      const res = await invokeMiddleware(makeReq(''));
      assert.equal(res.statusCode, 200);
      assert.match(res.body(), /Content-Security-Policy/);
      assert.ok(!res.body().includes('Template validation failed'));
    }
  );
});
