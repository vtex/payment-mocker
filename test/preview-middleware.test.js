'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const {
  normalizeIndexPath,
  createPreviewMiddleware,
  sanitizeErrorMessage,
  _sanitizeErrorMessageForRoot,
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

// The one exception to "every call in this file uses the disposable temp
// copy": invokeMiddlewareWithDefaultRoot below deliberately exercises
// createPreviewMiddleware()'s real, zero-argument production default, which
// resolves to this exact path — there's no way to hit that code path without
// touching the real, checked-in reference bundle. The stray-file tests that
// use it write here and remove it again in a `finally`, but a run killed hard
// enough to skip that (SIGKILL, a crash) would leave it behind and break
// `loadBundle`/`validate:reference` on the real bundle for good. Removing any
// leftover copy before the suite starts makes that self-healing instead of a
// permanent breakage the next run (or `npm run validate:reference`) hits.
const REAL_STRAY_FILE_PATH = path.join(REAL_TEMPLATE_ROOT, 'reference', 'notes.txt');

test.before(() => {
  fs.rmSync(REAL_STRAY_FILE_PATH, { force: true });

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
  // except invokeMiddlewareWithDefaultRoot, see REAL_STRAY_FILE_PATH above —
  // so this never touches the real, checked-in template/ directory otherwise.
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
    // All three variants normalize (path.normalize, then a case-insensitive
    // compare against 'index.html') to the bundle's own index, so the only
    // correct response is the canonical redirect — pin that exactly, rather
    // than accepting 403/301/200 as equally valid. A regression that instead
    // served the wrapped document directly at this non-canonical URL (a 200,
    // with the CSP meta tag intact) used to pass this test, even though it's
    // exactly the wrong-base-URL breakage the canonical redirect exists to
    // prevent: relative asset/script URLs inside the wrapped document resolve
    // against the URL that served it, not BUNDLE_PREFIX + 'index.html'.
    assert.equal(res.statusCode, 301, 'expected a canonical redirect for ' + variant);
    assert.equal(res.headers['Location'], BUNDLE_PREFIX + 'index.html');
  }
});

test('createPreviewMiddleware: a percent-encoded `..`-escape that resolves back to the bundle index is never served as a raw fragment', async () => {
  const res = await invokeMiddleware(makeReq('..%2Freference%2Findex.html', { url: BUNDLE_PREFIX + '%2e%2e/reference/index.html' }));
  // Same reasoning as the plain (non-percent-encoded) variants above: this
  // decodes and normalizes to the bundle's own index, so the canonical
  // redirect is the one correct response — pin it exactly.
  assert.equal(res.statusCode, 301, 'expected a canonical redirect');
  assert.equal(res.headers['Location'], BUNDLE_PREFIX + 'index.html');
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

test('createPreviewMiddleware: a bundle file whose name is outside the template contract responds 404 even though it exists and is contained', async () => {
  // Containment says where a file may live, never what it may be called. This
  // route never consults lib/load-bundle.js for the individual file it is
  // about to stream, so before the fix a stray `evil.html` physically present
  // in the bundle dir was served raw as text/html — at the preview server's
  // own origin, outside the sandbox the wrapped index.html runs in.
  const config = readPreviewConfig(tempTemplateRoot);
  const strayPath = path.join(config.bundlePath, 'evil.html');
  fs.writeFileSync(strayPath, '<script>document.title = "pwned"</script>');
  try {
    const res = await invokeMiddleware(makeReq('evil.html'));
    assert.equal(res.statusCode, 404);
    assert.equal(res.body(), 'Not Found');
    assert.ok(!res.body().includes('pwned'), 'the file contents must never be streamed');
  } finally {
    fs.rmSync(strayPath, { force: true });
  }
});

test('createPreviewMiddleware: a contract-shaped asset inside the bundle is still served', async () => {
  // The other half of the filename check above: it must reject only names
  // outside the contract, not the assets the template legitimately references.
  const res = await invokeMiddleware(makeReq('asset-logo.png'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/png');
});

test('createPreviewMiddleware: a bundle asset does NOT set Cross-Origin-Resource-Policy (it must stay loadable by the sandboxed iframe)', async () => {
  // A previous round set `Cross-Origin-Resource-Policy: same-origin` here to
  // close a cross-site <img>/<link> embed of this route (the Host allow-list
  // only checks the header's value, not which page is asking, so it didn't
  // cover that). It looked right on paper and broke the preview outright:
  // the wrapped template document that fetches this route runs inside
  // `<iframe sandbox="allow-scripts">` with no `allow-same-origin`, which
  // gives it a unique **opaque** origin — one that never equals anything,
  // not even itself. `same-origin` CORP blocks every such fetch
  // unconditionally. Confirmed against a real, launched Chromium (via
  // Playwright) before reverting this: style.css, both /lib/ scripts, and
  // every bundle asset all failed with
  // `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`, and the template rendered
  // with no styles, no runtime, no locale switching, no height sizing — the
  // whole feature this repo exists for, silently broken.
  //
  // The header stays on the icon route (see the icon-route test below),
  // which is fetched by the top-level checkout shell page itself — an
  // ordinary same-origin document, not this one.
  const res = await invokeMiddleware(makeReq('asset-logo.png'));
  assert.equal(res.headers['Cross-Origin-Resource-Policy'], undefined);
});

test('createPreviewMiddleware: an asset-prefixed file with a non-image extension responds 404', async () => {
  // The `asset-` prefix alone used to be enough to pass the contract check —
  // extension wasn't considered — so a stray `asset-x.html` was served raw as
  // text/html, sandbox and CSP-free, same class of bug as evil.html above.
  const config = readPreviewConfig(tempTemplateRoot);
  const strayPath = path.join(config.bundlePath, 'asset-x.html');
  fs.writeFileSync(strayPath, '<script>document.title = "pwned"</script>');
  try {
    const res = await invokeMiddleware(makeReq('asset-x.html'));
    assert.equal(res.statusCode, 404);
    assert.equal(res.body(), 'Not Found');
    assert.ok(!res.body().includes('pwned'), 'the file contents must never be streamed');
  } finally {
    fs.rmSync(strayPath, { force: true });
  }
});

test('createPreviewMiddleware: an index.html nested in a subdirectory responds 404 instead of being served unwrapped', async () => {
  // The contract check used to run against path.basename(normalizedPath), so
  // `old/index.html` read as the allowed bare name `index.html` and was
  // streamed raw by this route — the one name that must never reach a
  // shopper without the wrap/CSP the canonical index.html route applies.
  const config = readPreviewConfig(tempTemplateRoot);
  const nestedDir = path.join(config.bundlePath, 'old');
  const nestedIndex = path.join(nestedDir, 'index.html');
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(nestedIndex, '<script>document.title = "pwned"</script>');
  try {
    const res = await invokeMiddleware(makeReq('old/index.html'));
    assert.equal(res.statusCode, 404);
    assert.equal(res.body(), 'Not Found');
    assert.ok(!res.body().includes('pwned'), 'the file contents must never be streamed');
  } finally {
    fs.rmSync(nestedDir, { recursive: true, force: true });
  }
});

test('createPreviewMiddleware: a contract-shaped asset that is a symlink to an HTML file is served with the asset\'s own content type, not the symlink target\'s', async () => {
  // Containment alone doesn't catch this: the symlink's target is still
  // inside the bundle, and its *name* (asset-x.png) still passes the
  // contract check — only the bytes on disk are HTML. Before the fix,
  // Content-Type was sniffed from the resolved (post-symlink) file, so this
  // would have gone out as text/html and executed as a document if opened
  // directly. Deriving the header from the requested name instead means the
  // browser is told (correctly, per what was actually asked for) that this
  // is an image, regardless of what the symlink actually points to.
  const config = readPreviewConfig(tempTemplateRoot);
  const evilPath = path.join(config.bundlePath, 'evil-target.html');
  const assetPath = path.join(config.bundlePath, 'asset-x.png');
  fs.writeFileSync(evilPath, '<script>document.title = "pwned"</script>');
  fs.symlinkSync(evilPath, assetPath);
  try {
    const res = await invokeMiddleware(makeReq('asset-x.png'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');
  } finally {
    fs.rmSync(assetPath, { force: true });
    fs.rmSync(evilPath, { force: true });
  }
});

test('createPreviewMiddleware (icon route): an icon configured with a subdirectory responds 404', async () => {
  await withPreviewConfig({ bundleDir: 'reference', defaultLocale: 'pt-BR', icon: 'reference/index.html' }, async () => {
    const res = await invokeMiddleware(makeIconReq('reference/index.html'));
    assert.equal(res.statusCode, 404);
    assert.equal(res.body(), 'Not Found');
  });
});

test('createPreviewMiddleware (icon route): a flat, non-image icon filename responds 404 — exercising the extension check, not just the no-subdirectory one', async () => {
  // The subdirectory test above (icon: 'reference/index.html') is rejected by
  // ICON_FILENAME_PATTERN's `[^/\\]+` before its extension arm is ever
  // reached, so it can't tell the extension check apart from a regression
  // that dropped it. This one has no `/` at all: CONTRACT.md limits the icon
  // to a raster file directly under template/, but nothing enforced that
  // shape before — pointing `icon` straight at a flat .html file served it as
  // text/html, no subdirectory or symlink needed.
  const evilIconPath = path.join(tempTemplateRoot, 'evil.html');
  fs.writeFileSync(evilIconPath, '<script>document.title = "pwned"</script>');
  try {
    await withPreviewConfig({ bundleDir: 'reference', defaultLocale: 'pt-BR', icon: 'evil.html' }, async () => {
      const res = await invokeMiddleware(makeIconReq('evil.html'));
      assert.equal(res.statusCode, 404);
      assert.equal(res.body(), 'Not Found');
    });
  } finally {
    fs.rmSync(evilIconPath, { force: true });
  }
});

test('createPreviewMiddleware (icon route): an icon that is a symlink to an HTML file is served with the icon\'s own content type, not the symlink target\'s', async () => {
  // The bundle-route equivalent of this (asset-x.png symlinked to evil.html)
  // is covered above; the icon route went through the exact same
  // resolvedFile-vs-declared-name fix in the same commit but had no test of
  // its own — a regression back to streamFile(resolvedFile, res) with no
  // explicit content type here would not have failed anything.
  const evilTargetPath = path.join(tempTemplateRoot, 'evil-icon-target.html');
  const iconLinkPath = path.join(tempTemplateRoot, 'icon-link.png');
  fs.writeFileSync(evilTargetPath, '<script>document.title = "pwned"</script>');
  fs.symlinkSync(evilTargetPath, iconLinkPath);
  try {
    await withPreviewConfig({ bundleDir: 'reference', defaultLocale: 'pt-BR', icon: 'icon-link.png' }, async () => {
      const res = await invokeMiddleware(makeIconReq('icon-link.png'));
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Content-Type'], 'image/png');
    });
  } finally {
    fs.rmSync(iconLinkPath, { force: true });
    fs.rmSync(evilTargetPath, { force: true });
  }
});

// mkfifo has no Node API and no Windows equivalent; these are skipped where
// it isn't available rather than failing.
function canMakeFifo() {
  return process.platform !== 'win32';
}

test(
  'createPreviewMiddleware (icon route): a FIFO named as the icon is rejected, not streamed (would hang fs.createReadStream)',
  { skip: !canMakeFifo() && 'mkfifo is not available on this platform' },
  async () => {
    // Without the isFile() check, streamFile's fs.createReadStream would call
    // open() on this FIFO, which blocks (in a libuv threadpool worker,
    // per-request) waiting for a writer that this test never provides —
    // exactly the same hang lib/validation-input.js's own isFile() check
    // already guards the separate icon-for-validation read against. This
    // proves the icon *route* (what the browser actually requests on every
    // page load) has the same guard, not just the read validate() triggers.
    const fifoPath = path.join(tempTemplateRoot, 'icon-fifo.png');
    execFileSync('mkfifo', [fifoPath]);
    try {
      await withPreviewConfig({ bundleDir: 'reference', defaultLocale: 'pt-BR', icon: 'icon-fifo.png' }, async () => {
        const res = await invokeMiddleware(makeIconReq('icon-fifo.png'));
        assert.equal(res.statusCode, 403);
      });
    } finally {
      fs.rmSync(fifoPath, { force: true });
    }
  }
);

test(
  'createPreviewMiddleware: a FIFO named as a bundle asset is deferred to next(), not streamed (would hang fs.createReadStream)',
  { skip: !canMakeFifo() && 'mkfifo is not available on this platform' },
  async () => {
    // Same treatment as a directory at this route (see the next() branch
    // this reuses): the fake res stand-in is untouched (still its default
    // 200) when next() runs instead of a route handler actually responding —
    // the real server's next() falls through to the static src/ mount, which
    // 404s a /template-bundle/asset-fifo.png path itself.
    const config = readPreviewConfig(tempTemplateRoot);
    const fifoPath = path.join(config.bundlePath, 'asset-fifo.png');
    execFileSync('mkfifo', [fifoPath]);
    try {
      const res = await invokeMiddleware(makeReq('asset-fifo.png'));
      assert.equal(res.statusCode, 200, 'next() must have been called, not a route handler responding directly');
    } finally {
      fs.rmSync(fifoPath, { force: true });
    }
  }
);

test('createPreviewMiddleware: sanitizeErrorMessage does not corrupt a URL quoted in a message (scheme:// looks like an absolute path)', async () => {
  // ABSOLUTE_PATH_PATTERN is deliberately generic, so a URL's `//` after the
  // scheme used to read as an absolute path starting mid-string, collapsing
  // the whole thing down to its last segment (http://host/a/b.html ->
  // http:b.html). Rare in this codebase's own error messages, but the fix is
  // a couple of lookbehind characters, cheap enough to close as found.
  const message = 'error at http://localhost:8080/template-bundle/index.html failed to load';
  const sanitized = sanitizeErrorMessage(message);
  assert.equal(sanitized, message, 'a URL must survive sanitization completely untouched');
});

test('sanitizeErrorMessage redacts a Windows-style path containing a space, same as the Unix pattern does', async () => {
  // WINDOWS_PATH_PATTERN was fixed to allow the Unix pattern's Mobile-
  // Documents-shaped space, but the equivalent fix was never mirrored onto
  // the Windows pattern next to it — a Windows username with a space
  // (`Jane Doe`, a completely ordinary Windows display name) still leaked
  // past the point where the old pattern's `[^\s'"()\\]+` stopped at the
  // space.
  const message = 'Bundle at C:\\Users\\Jane Doe\\project\\template\\reference contains files outside the template contract: evil.html';
  const sanitized = sanitizeErrorMessage(message);
  assert.ok(!sanitized.includes('C:\\Users\\Jane Doe'), 'the space-containing Windows path must be fully stripped');
  assert.ok(!sanitized.includes('project'), 'no intermediate directory should survive');
  assert.ok(sanitized.includes('Bundle at reference contains'), 'only the basename should remain in place');
});

test('sanitizeErrorMessage redacts a path whose second word starts with an accented uppercase letter, on both Unix and Windows', () => {
  // The `Jane Doe`-shaped test above only proves the space-tolerance lookahead
  // accepts ASCII uppercase. `[A-Z]` alone missed this: "Á" is uppercase but
  // outside that range, so a name like `João Ávila` used to leak everything
  // from "Ávila" onward. `\p{Lu}` (Unicode uppercase-letter category) is what
  // closes this without reopening the ordinary-lowercase-prose problem the
  // lookahead exists to avoid in the first place.
  const windowsMessage = 'Bundle at C:\\Users\\João Ávila\\proj\\template\\reference contains files';
  assert.equal(sanitizeErrorMessage(windowsMessage), 'Bundle at reference contains files');

  const unixMessage = 'Bundle at /Users/João Ávila/proj/template/reference contains files';
  assert.equal(sanitizeErrorMessage(unixMessage), 'Bundle at reference contains files');
});

// KNOWN, ACCEPTED LIMITATION of the generic pattern — not a regression to
// fix reflexively: a real folder/user name whose second word starts with a
// LOWERCASE letter (`jane doe`, an entirely ordinary display name) is
// indistinguishable, character by character, from resumed lowercase prose
// ("... contains files ..."), so the match still stops at that space and a
// path fragment past it can still reach the client. sanitizeErrorMessage's
// known-path pass (see the o'brien/Projects(old)x tests further down) now
// closes this for any path under the repository root or the bundle; this
// pins what's left — a path under neither,
// which only the generic pattern ever sees — so a future change to that
// regex either improves it consciously or is caught updating this
// assertion, rather than silently drifting.
test('sanitizeErrorMessage: a lowercase-starting second word is a known gap, not silently worse or better', () => {
  const message = 'Bundle at C:\\Users\\jane doe\\project\\reference contains files';
  const sanitized = sanitizeErrorMessage(message);
  assert.equal(sanitized, 'Bundle at jane doe\\project\\reference contains files');
  // ...and closed once that path is a known one.
  assert.equal(
    sanitizeErrorMessage(message, ['C:\\Users\\jane doe\\project\\reference']),
    'Bundle at reference contains files'
  );
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

test('createPreviewMiddleware (icon route): sets Cross-Origin-Resource-Policy: same-origin, closing a cross-site <img> embed', async () => {
  const res = await invokeMiddleware(makeIconReq('icon.png'));
  assert.equal(res.headers['Cross-Origin-Resource-Policy'], 'same-origin');
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

test('invalidateWrapCache does not leak Module objects into preview-middleware.js\'s own module.children on every request', async () => {
  // require() unconditionally pushes every freshly loaded module onto its
  // parent's module.children, with no dedup — invalidateWrapCache's
  // delete-from-require.cache-then-require-again cycle (needed so an author
  // editing load-bundle.js/preview-config.js/path-contained.js/validation-
  // input.js — the four modules it names, NOT this file itself, which
  // Gruntfile.js only ever requires once at startup and has no equivalent
  // reload hook for — while grunt is running sees the change without a
  // restart) used to leave one more orphaned Module object here per call,
  // forever, since nothing ever removed the stale entry it replaced. This
  // runs on nearly every request (the config route alone triggers it via
  // both readPreviewConfig and, for availableLocales, loadBundle), so a
  // long-running dev server's heap grew without bound. require.cache is a
  // process-global registry, so this file can inspect preview-middleware.js's
  // own module entry directly.
  //
  // A single request already calls invalidateWrapCache() more than once
  // (readPreviewConfig, then loadBundle for availableLocales), which — by
  // design — deletes and does not always re-require every one of the four
  // wrapped modules by the time the response is sent; which ones remain
  // cached at rest is an implementation detail this test doesn't pin down.
  // What it does pin down is the actual leak signature: no duplicate `id`
  // ever appears in the list, and the list stops growing once it's warm.
  const previewMiddlewareModule = require.cache[require.resolve('../lib/preview-middleware')];
  assert.ok(previewMiddlewareModule, 'preview-middleware.js must already be in the cache');

  function childIds() {
    return previewMiddlewareModule.children.map((child) => child.id);
  }

  await invokeMiddleware(makeConfigReq()); // warm up once before measuring
  const warmLength = childIds().length;

  for (let i = 0; i < 5; i++) {
    await invokeMiddleware(makeConfigReq());
  }

  const ids = childIds();
  assert.equal(new Set(ids).size, ids.length, 'module.children must never contain the same module id twice');
  assert.equal(ids.length, warmLength, 'module.children must not keep growing once warm');
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
  const strayFilePath = REAL_STRAY_FILE_PATH;
  assert.equal(strayFilePath, path.join(config.bundlePath, 'notes.txt'));
  // Belt-and-suspenders alongside the `finally` below: this file lives inside
  // the real, checked-in reference bundle (see REAL_STRAY_FILE_PATH above), so
  // a process kill between the write and the `finally` would otherwise leave
  // it behind permanently. `process.on('exit', ...)` still fires on a normal
  // SIGINT (Ctrl+C) — only a SIGKILL or hard crash skips it too, and
  // test.before's own cleanup is the backstop for that remaining case.
  const removeStrayFile = () => fs.rmSync(strayFilePath, { force: true });
  process.on('exit', removeStrayFile);
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
    removeStrayFile();
    process.removeListener('exit', removeStrayFile);
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
  // Stands in for `require('@vtex/payment-templates-core')` failing because
  // the dependency isn't installed — a realistic incomplete-`npm i` scenario.
  // Node's real message for this also quotes the bare specifier
  // '@vtex/payment-templates-core' verbatim, which is not itself a filesystem
  // path and must survive untouched. The require-stack path below is a
  // generic stand-in, not a real machine's home directory: this test is
  // exercising the sanitizer, not documenting anyone's actual username.
  const message =
    "Cannot find module '@vtex/payment-templates-core'\nRequire stack:\n- /home/user/project/payment-mocker/lib/preview-middleware.js";
  const sanitized = sanitizeErrorMessage(message);
  assert.ok(!sanitized.includes('/home/user'), 'the absolute require-stack path must be stripped');
  assert.ok(sanitized.includes('preview-middleware.js'), 'the actionable filename must survive');
  assert.ok(sanitized.includes("'@vtex/payment-templates-core'"), 'the bare module specifier is not a path and must be left alone');
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
  // The known-path pass sanitizeErrorMessage does now IS a prefix
  // substitution again, so it only replaces at a path boundary (never from
  // the middle of `/private/var/...`) and also tries each known path's
  // realpath'd spelling; the unresolved `/var/...` form is passed as a known
  // path here to prove it can't splice into the resolved one.
  const message = "ENOENT: no such file or directory, open '/private/var/folders/xy/T/payment-mocker-template-abc123/template/icon.png'";
  const sanitized = sanitizeErrorMessage(message, ['/var/folders/xy/T/payment-mocker-template-abc123/template']);
  assert.ok(!sanitized.includes('/private/var'), 'no resolved-symlink path fragment should leak');
  assert.ok(!sanitized.includes('privatetemplate'), 'must never merge into a mangled, non-existent path');
  assert.ok(sanitized.includes('icon.png'), 'the actionable filename must survive');
});

test('sanitizeErrorMessage redacts a Unix path containing a space (e.g. "Mobile Documents"), without swallowing the prose that follows it', () => {
  // A real folder name with a space in it ("Mobile Documents", "My Projects",
  // "Program Files", ...) used to stop the match right at the space, leaving
  // everything past it — more of the path, and the OS username in it —
  // unredacted. The fix must also not overcorrect: ordinary prose after the
  // path resumes in lowercase, so it must survive untouched rather than get
  // swallowed into what the sanitizer thinks is still "the path".
  const message =
    'Bundle at /Users/dev/Library/Mobile Documents/com~apple~CloudDocs/template/reference contains files outside the template contract: evil.html.';
  const sanitized = sanitizeErrorMessage(message);
  assert.ok(!sanitized.includes('/Users/dev'), 'the absolute path, space and all, must be stripped');
  assert.ok(!sanitized.includes('Mobile Documents'), 'the space-containing segment must not survive');
  assert.equal(
    sanitized,
    'Bundle at reference contains files outside the template contract: evil.html.',
    'only the basename should remain, and the prose after the path must be untouched'
  );
});

test('sanitizeErrorMessage redacts a Windows-style absolute path, which the Unix pattern cannot see at all', () => {
  // A Windows path contains no forward slash, so ABSOLUTE_PATH_PATTERN never
  // matches one and the whole string — OS username included — used to reach
  // the client verbatim through /template-validation.json. Note this runs on
  // POSIX here: the redaction has to use path.win32.basename, since the
  // platform-default path.basename does not treat `\` as a separator and
  // would return the entire string unchanged, failing this test.
  const message =
    'Bundle at C:\\Users\\alice\\project\\template\\reference contains files outside the template contract: evil.html';
  const sanitized = sanitizeErrorMessage(message);
  assert.ok(!sanitized.includes('C:\\Users\\alice'), 'the absolute Windows path must be stripped');
  assert.ok(!sanitized.includes('project'), 'no intermediate directory should survive');
  assert.ok(sanitized.includes('Bundle at reference contains'), 'only the basename should remain in place');
  assert.ok(sanitized.includes('evil.html'), 'the actionable filename must survive');
});

test('sanitizeErrorMessage redacts a UNC path and leaves Unix redaction intact in the same message', () => {
  const message =
    "ENOENT: no such file or directory, open '\\\\buildserver\\share\\payment-mocker\\template\\icon.png' (mirrored at /srv/payment-mocker/template/icon.png)";
  const sanitized = sanitizeErrorMessage(message);
  assert.ok(!sanitized.includes('buildserver'), 'the UNC host and share must be stripped');
  assert.ok(!sanitized.includes('/srv/payment-mocker'), 'the Unix path must still be stripped too');
  assert.ok(sanitized.includes('icon.png'), 'the actionable filename must survive');
});

test('createPreviewMiddleware (validation route): a non-GET/HEAD method responds 405', async () => {
  const res = await invokeMiddleware(makeValidationReq({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Allow'], 'GET, HEAD');
});

test('createPreviewMiddleware (validation route): a malformed preview.config.json responds 200 with ok:false, not a 500, so the banner still renders', async () => {
  await withPreviewConfig({ bundleDir: 'reference' }, async () => {
    // Missing defaultLocale — readPreviewConfig() throws synchronously, the
    // same failure mode already covered for the config route above, but here
    // exercised through the validation route's own readPreviewConfig() call.
    //
    // This route's contract is `{ ok, errors }` JSON — the checkout shell
    // mock's banner only renders on a 2xx response (see
    // src/assets/libs/template-host.js's loadTemplateValidation). Before the
    // fix, this responded with the same plain-text 500 the config route uses,
    // which meant exactly the mistakes an author is most likely to make while
    // editing (a bad defaultLocale, a missing bundleDir, ...) showed no
    // banner at all.
    const res = await invokeMiddleware(makeValidationReq());
    assert.equal(res.statusCode, 200);
    const rawBody = res.body();
    const body = JSON.parse(rawBody);
    assert.equal(body.ok, false);
    assert.equal(body.errors[0].rule, 'load');
  });
});

test('createPreviewMiddleware (validation route): a missing preview.config.json responds 200 with ok:false and never leaks the server filesystem path', async () => {
  // Unlike the malformed-JSON case above (a fixed message with no path in
  // it, so a "must not leak the path" assertion there can never actually
  // fail), a missing preview.config.json makes readPreviewConfig's own
  // fs.readFileSync throw a raw ENOENT whose message embeds the absolute
  // configPath verbatim — a real instance of the thing sanitizeErrorMessage
  // exists to strip, and the one this test actually needs to exercise that.
  const originalContent = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.rmSync(CONFIG_PATH);
  try {
    const res = await invokeMiddleware(makeValidationReq());
    assert.equal(res.statusCode, 200);
    const rawBody = res.body();
    const body = JSON.parse(rawBody);
    assert.equal(body.ok, false);
    assert.equal(body.errors[0].rule, 'load');
    assert.match(body.errors[0].message, /ENOENT/);
    assert.ok(!rawBody.includes(tempTemplateRoot), 'must not leak the server filesystem path');
  } finally {
    fs.writeFileSync(CONFIG_PATH, originalContent);
  }
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

test('createPreviewMiddleware (resolve-locale script route): GET serves the real resolve-locale.js file, byte for byte', async () => {
  // Same reasoning as the template-runtime route test below: a substring
  // match would still pass on a truncated or otherwise corrupted file, since
  // it never actually compares against the file this route claims to serve.
  // This route is what vcs.checkout-ui vendors from, so compare byte for byte
  // against the file on disk, same as the sibling route.
  const res = await invokeMiddleware({
    url: RESOLVE_LOCALE_SCRIPT_PATH,
    headers: { host: 'localhost:8080' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/javascript; charset=utf-8');
  const onDisk = fs.readFileSync(require.resolve('@vtex/payment-templates-core/wrap/resolve-locale.js'), 'utf8');
  assert.equal(res.body(), onDisk);
});

test('createPreviewMiddleware (resolve-locale script route): does NOT set Cross-Origin-Resource-Policy (loaded by the sandboxed, opaque-origin iframe)', async () => {
  // Same reasoning as the bundle-asset test above: this script is one of the
  // two <script src> tags the wrapped template document itself loads, and
  // that document's opaque origin (from `sandbox="allow-scripts"` with no
  // `allow-same-origin`) makes `same-origin` CORP block it unconditionally.
  const res = await invokeMiddleware({
    url: RESOLVE_LOCALE_SCRIPT_PATH,
    headers: { host: 'localhost:8080' },
  });
  assert.equal(res.headers['Cross-Origin-Resource-Policy'], undefined);
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

test('createPreviewMiddleware (template-runtime script route): GET serves the real @vtex/payment-templates-core/wrap/template-runtime.js file, byte for byte', async () => {
  // Same reasoning as the resolve-locale route test above: a status-code-only
  // assertion would pass on an empty body or the wrong file. This route is
  // what vcs.checkout-ui vendors from, so compare against the file on disk.
  const res = await invokeMiddleware({
    url: TEMPLATE_RUNTIME_SCRIPT_PATH,
    headers: { host: 'localhost:8080' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/javascript; charset=utf-8');
  const onDisk = fs.readFileSync(require.resolve('@vtex/payment-templates-core/wrap/template-runtime.js'), 'utf8');
  assert.equal(res.body(), onDisk);
});

test('createPreviewMiddleware (template-runtime script route): does NOT set Cross-Origin-Resource-Policy (loaded by the sandboxed, opaque-origin iframe)', async () => {
  // Same reasoning as the resolve-locale route test above.
  const res = await invokeMiddleware({
    url: TEMPLATE_RUNTIME_SCRIPT_PATH,
    headers: { host: 'localhost:8080' },
  });
  assert.equal(res.headers['Cross-Origin-Resource-Policy'], undefined);
});

// Gruntfile.js binds hostname: '127.0.0.1' (loopback only), and none of this
// middleware's routes require auth — they hand out the
// partner's own unpublished bundle, icon and validator findings. A non-local
// Host header is rejected uniformly, before any route-specific handler runs,
// which also closes a DNS-rebinding path: a browser page whose hostname a DNS
// answer later points at this machine sends that hostname, not 'localhost',
// as its Host header, while still reaching this server over the route that
// answer resolved to.
for (const route of ['config', 'validation', 'bundle', 'icon', 'resolve-locale', 'template-runtime']) {
  test('createPreviewMiddleware (' + route + ' route): a non-local Host header responds 403, before the route runs', async () => {
    const url = {
      config: PREVIEW_CONFIG_PATH,
      validation: TEMPLATE_VALIDATION_PATH,
      bundle: BUNDLE_PREFIX + 'index.html',
      icon: ICON_PREFIX + 'icon.png',
      'resolve-locale': RESOLVE_LOCALE_SCRIPT_PATH,
      'template-runtime': TEMPLATE_RUNTIME_SCRIPT_PATH,
    }[route];
    const res = await invokeMiddleware({ url, headers: { host: 'attacker.example' } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body(), 'Forbidden');
  });
}

test('createPreviewMiddleware: a request with no Host header at all responds 403', async () => {
  const res = await invokeMiddleware({ url: PREVIEW_CONFIG_PATH, headers: {} });
  assert.equal(res.statusCode, 403);
});

for (const host of ['localhost:8080', 'localhost', '127.0.0.1:8080', '[::1]:8080', 'LOCALHOST:8080']) {
  test('createPreviewMiddleware: Host ' + host + ' is treated as local and reaches the route', async () => {
    const res = await invokeMiddleware({ url: PREVIEW_CONFIG_PATH, headers: { host } });
    assert.equal(res.statusCode, 200);
  });
}


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
  // The hostname portion must be 'localhost' (or another allowed loopback
  // name) to get past isLocalHostname's own Host allow-list first — see that
  // function's docblock — so the hostile part is placed after the first `:`,
  // in the position a port would occupy. ORIGIN_PATTERN independently rejects
  // this as a whole (`evil"><script>alert(1)</script>` is not `\d{1,5}`), so
  // this still exercises the CSP-injection fallback this test is actually
  // about, not the separate Host-allow-list gate.
  const res = await invokeMiddleware(
    makeReq('', { headers: { host: 'localhost:evil"><script>alert(1)</script>' } })
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

test('createPreviewMiddleware: the wrapped index sets a sandbox CSP header, independent of the iframe attribute', () => {
  // The wrapped document's real isolation normally comes from the parent
  // checkout shell's `<iframe sandbox="allow-scripts">` attribute
  // (src/assets/libs/template-host.js), which only applies while this
  // response is loaded *as* that iframe. The same URL is also reachable
  // directly, as a top-level navigation — Grunt now binds loopback only
  // (Gruntfile.js), but that still includes every browser tab and local
  // process on this machine, none of which goes through the iframe
  // attribute above. A `sandbox` directive can only be delivered via this
  // header (the wrapped document's own <meta> CSP, asserted on above, cannot
  // carry it), so this is the one thing that still confines it in that case.
  return invokeMiddleware(makeReq('')).then((res) => {
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Security-Policy'], 'sandbox allow-scripts');
  });
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

// An oversized bundle file used to make loadBundle throw, which took the whole
// preview down over it: 500 on the wrapped index, a lone `load` finding on
// /template-validation.json in place of validate()'s own list, and an empty
// locale switcher — contradicting README.md/CONTRACT.md's "a failing bundle
// still previews". loadBundle now reads at most each file's cap and keeps its
// real size, so validate()'s own maxFileSize rule reports it. Each case below
// also sets an over-long displayName (a displayNameSafety error that has
// nothing to do with file size) to prove the size finding arrives ALONGSIDE
// the rest of validate()'s list rather than replacing it.
const OVERLONG_DISPLAY_NAME_CONFIG = {
  bundleDir: 'reference',
  defaultLocale: 'pt-BR',
  displayName: { 'pt-BR': 'A'.repeat(91), 'en-US': 'Example Pay' },
};

/**
 * Temporarily replaces `name` in the temp bundle with `makeContents(original)`
 * for the duration of `fn`, restoring the original bytes afterwards.
 */
async function withBundleFileReplaced(name, makeContents, fn) {
  const filePath = path.join(readPreviewConfig(tempTemplateRoot).bundlePath, name);
  const original = fs.readFileSync(filePath);
  fs.writeFileSync(filePath, makeContents(original));
  try {
    await fn();
  } finally {
    fs.writeFileSync(filePath, original);
  }
}

async function assertOversizeFileStillPreviews(oversizeName) {
  const indexRes = await invokeMiddleware(makeReq('index.html'));
  assert.equal(indexRes.statusCode, 200, 'the wrapped index must still render');
  assert.match(indexRes.body(), /payment-template-i18n/, 'the body must be the wrap, not an error page');

  const validationRes = await invokeMiddleware(makeValidationReq());
  assert.equal(validationRes.statusCode, 200);
  const validation = JSON.parse(validationRes.body());
  assert.equal(validation.ok, false);
  const rules = validation.errors.map((finding) => finding.rule);
  assert.ok(!rules.includes('load'), 'must not collapse into a single load finding: ' + JSON.stringify(validation.errors));
  assert.ok(
    validation.errors.some((finding) => finding.rule === 'maxFileSize' && finding.ref && finding.ref.file === oversizeName),
    'validate()\'s own maxFileSize rule must report ' + oversizeName + ': ' + JSON.stringify(validation.errors)
  );
  assert.ok(rules.includes('displayNameSafety'), 'the unrelated displayName finding must still be reported alongside it');

  const configRes = await invokeMiddleware(makeConfigReq());
  assert.equal(configRes.statusCode, 200);
  assert.deepEqual(JSON.parse(configRes.body()).availableLocales, ['en-US', 'pt-BR']);
}

test('createPreviewMiddleware: an asset one byte over its 256 KB cap still previews, is reported by maxFileSize alongside other findings, and keeps its locales', async () => {
  await withPreviewConfig(OVERLONG_DISPLAY_NAME_CONFIG, async () => {
    await withBundleFileReplaced(
      'asset-logo.png',
      (original) => Buffer.concat([original, Buffer.alloc(262145 - original.byteLength)]),
      () => assertOversizeFileStillPreviews('asset-logo.png')
    );
  });
});

test('createPreviewMiddleware: an index.html over its 128 KB cap still previews, is reported by maxFileSize alongside other findings, and keeps its locales', async () => {
  await withPreviewConfig(OVERLONG_DISPLAY_NAME_CONFIG, async () => {
    await withBundleFileReplaced(
      'index.html',
      (original) => Buffer.concat([original, Buffer.from(' '.repeat(128 * 1024))]),
      () => assertOversizeFileStillPreviews('index.html')
    );
  });
});

// Problems with the configured icon used to throw out of
// buildValidationInput and become the single `load` finding, hiding every
// other finding in the bundle. Now each is an `icon` finding merged into
// validate()'s own list (see lib/validation-input.js's resolveIconPath).
test('createPreviewMiddleware (validation route): a misnamed icon and an unrelated bundle error are both reported', async () => {
  const iconDir = path.join(tempTemplateRoot, 'img');
  fs.mkdirSync(iconDir, { recursive: true });
  fs.copyFileSync(path.join(tempTemplateRoot, 'icon.png'), path.join(iconDir, 'icon.png'));
  try {
    await withPreviewConfig(Object.assign({}, OVERLONG_DISPLAY_NAME_CONFIG, { icon: 'img/icon.png' }), async () => {
      const res = await invokeMiddleware(makeValidationReq());
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body());
      assert.equal(body.ok, false);
      const rules = body.errors.map((finding) => finding.rule);
      assert.ok(!rules.includes('load'), JSON.stringify(body.errors));
      assert.ok(rules.includes('displayNameSafety'), 'the unrelated bundle finding must survive: ' + JSON.stringify(body.errors));
      const iconFinding = body.errors.find((finding) => finding.rule === 'icon');
      assert.ok(iconFinding, 'the icon problem must be its own finding');
      assert.equal(iconFinding.severity, 'error');
      assert.match(iconFinding.message, /placed directly under template\/: img\/icon\.png/);
    });
  } finally {
    fs.rmSync(iconDir, { recursive: true, force: true });
  }
});

test('createPreviewMiddleware (validation route): an icon finding\'s message is sanitized like a load failure\'s', async () => {
  // path.join(root, '/abs/...') keeps the icon inside template/, so this is
  // a not-found finding — whose message quotes config.icon verbatim, an
  // absolute path including the server's own directory structure.
  const absoluteIcon = path.join(tempTemplateRoot, 'nowhere', 'icon.png');
  await withPreviewConfig({ bundleDir: 'reference', defaultLocale: 'pt-BR', icon: absoluteIcon }, async () => {
    const res = await invokeMiddleware(makeValidationReq());
    const rawBody = res.body();
    const iconFinding = JSON.parse(rawBody).errors.find((finding) => finding.rule === 'icon');
    assert.ok(iconFinding, rawBody);
    assert.ok(!rawBody.includes(tempTemplateRoot), 'must not leak the server filesystem path: ' + rawBody);
    assert.ok(!rawBody.includes(tempContainer), 'must not leak the server filesystem path: ' + rawBody);
  });
});

test('createPreviewMiddleware (validation route): an oversized icon is reported by the core\'s own maxFileSize rule, alongside other findings', async () => {
  const bigIconPath = path.join(tempTemplateRoot, 'big-icon.png');
  const realIcon = fs.readFileSync(path.join(tempTemplateRoot, 'icon.png'));
  fs.writeFileSync(bigIconPath, Buffer.concat([realIcon, Buffer.alloc(50 * 1024 + 1 - realIcon.byteLength)]));
  try {
    await withPreviewConfig(Object.assign({}, OVERLONG_DISPLAY_NAME_CONFIG, { icon: 'big-icon.png' }), async () => {
      const res = await invokeMiddleware(makeValidationReq());
      const body = JSON.parse(res.body());
      const rules = body.errors.map((finding) => finding.rule);
      assert.ok(!rules.includes('load') && !rules.includes('icon'), JSON.stringify(body.errors));
      assert.ok(
        body.errors.some((finding) => finding.rule === 'maxFileSize' && /big-icon\.png is 51201 bytes, over the 51200-byte limit for each icon/.test(finding.message)),
        JSON.stringify(body.errors)
      );
      assert.ok(rules.includes('displayNameSafety'), JSON.stringify(body.errors));
    });
  } finally {
    fs.rmSync(bigIconPath, { force: true });
  }
});

// A JPEG icon over its 50 KB cap whose SOF (100x100 px) lies behind a
// 60000-byte APP1 segment — past the cap, so only zero padding stands where
// validate() looks for the frame header.
function jpegIconWithLateSof() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, (60002 >> 8) & 0xff, 60002 & 0xff]),
    Buffer.alloc(60000, 0x41),
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x64, 0x00, 0x64, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]),
  ]);
}

test('createPreviewMiddleware (validation route): an oversized JPEG icon with its frame header past the read cap gets maxFileSize only, no false dimension finding', async () => {
  const iconPath = path.join(tempTemplateRoot, 'late-sof.jpg');
  fs.writeFileSync(iconPath, jpegIconWithLateSof());
  try {
    await withPreviewConfig({ bundleDir: 'reference', defaultLocale: 'pt-BR', icon: 'late-sof.jpg' }, async () => {
      const body = JSON.parse((await invokeMiddleware(makeValidationReq())).body());
      assert.equal(body.ok, false);
      assert.ok(
        body.errors.some((finding) => finding.rule === 'maxFileSize' && /late-sof\.jpg is 60021 bytes, over the 51200-byte limit for each icon/.test(finding.message)),
        JSON.stringify(body.errors)
      );
      assert.ok(!body.errors.some((finding) => /Could not read the pixel dimensions/.test(finding.message)), JSON.stringify(body.errors));
    });
  } finally {
    fs.rmSync(iconPath, { force: true });
  }
});

test('createPreviewMiddleware (validation route): a truncated icon that is not an image at all keeps its real imageSafety finding', async () => {
  const iconPath = path.join(tempTemplateRoot, 'big-text.png');
  fs.writeFileSync(iconPath, Buffer.alloc(60000, 0x41));
  try {
    await withPreviewConfig({ bundleDir: 'reference', defaultLocale: 'pt-BR', icon: 'big-text.png' }, async () => {
      const body = JSON.parse((await invokeMiddleware(makeValidationReq())).body());
      assert.ok(
        body.errors.some((finding) => finding.rule === 'imageSafety' && /big-text\.png is not a PNG, JPEG or WebP image/.test(finding.message)),
        JSON.stringify(body.errors)
      );
      assert.ok(body.errors.some((finding) => finding.rule === 'maxFileSize'), JSON.stringify(body.errors));
    });
  } finally {
    fs.rmSync(iconPath, { force: true });
  }
});

// ABSOLUTE_PATH_PATTERN's segment stops at the first quote or paren, so a
// real name containing one used to leave everything after it un-redacted.
// sanitizeErrorMessage now strips the server's KNOWN absolute paths (the
// optional second argument, plus the repository root always) by literal
// substring first. The paths below lie outside the repository, so they keep
// the older last-segment replacement (see knownPathReplacements).
test('sanitizeErrorMessage strips a known path containing an apostrophe whole (o\'brien)', () => {
  const bundlePath = "/Users/o'brien/Documents/payment-mocker/template/reference";
  assert.equal(
    sanitizeErrorMessage('Bundle at ' + bundlePath + ' has x', [bundlePath]),
    'Bundle at reference has x'
  );
  assert.equal(
    sanitizeErrorMessage("ENOENT: no such file or directory, open '" + bundlePath + "/index.html'", [bundlePath]),
    "ENOENT: no such file or directory, open 'reference/index.html'"
  );
});

test('sanitizeErrorMessage strips a known path containing parentheses whole (Projects(old)x)', () => {
  const templateRoot = '/Users/me/Projects(old)x/template';
  assert.equal(sanitizeErrorMessage('Bundle at ' + templateRoot + ' has x', [templateRoot]), 'Bundle at template has x');
  // A replacement ending in `)` must not let the generic pattern then eat
  // the relative tail after it (`/index.html` right after `)` looks like an
  // absolute path to it) — see KNOWN_PATH_TOKEN_PATTERN.
  assert.equal(
    sanitizeErrorMessage("open '/srv/ref(1)/index.html'", ['/srv/ref(1)']),
    "open 'ref(1)/index.html'"
  );
});

test('sanitizeErrorMessage strips a known Windows path in either separator spelling', () => {
  const bundlePath = "C:\\Users\\o'brien\\proj\\template\\reference";
  assert.equal(sanitizeErrorMessage('Bundle at ' + bundlePath + ' has x', [bundlePath]), 'Bundle at reference has x');
  assert.equal(
    sanitizeErrorMessage("Bundle at C:/Users/o'brien/proj/template/reference has x", [bundlePath]),
    'Bundle at reference has x'
  );
});

// There used to be a test here pinning os.homedir() -> `~`. That special
// case is gone on purpose (see knownPathReplacements in
// lib/preview-middleware.js): the one always-known root is now the
// repository itself, rewritten to repo-relative paths, and a path elsewhere
// under the home directory is an ordinary outside-the-repository path for the
// generic pattern. What that pattern still guarantees for such a path — the
// username is gone — is pinned here instead, together with the o'brien case
// it can't handle (the same documented gap as `jane doe` above), so a change
// to either is a conscious one.
test('sanitizeErrorMessage: a path outside the repository (e.g. elsewhere under the home directory) still loses its username', () => {
  assert.equal(sanitizeErrorMessage('Cannot read /Users/alice/.npmrc (Projects(old)x)'), 'Cannot read .npmrc (Projects(old)x)');
  assert.equal(sanitizeErrorMessage('Cannot read C:\\Users\\alice\\.npmrc now'), 'Cannot read .npmrc now');
  // Known gap, outside the repository only: the segment stops at the `'`.
  assert.equal(sanitizeErrorMessage("Cannot read /Users/o'brien/.npmrc"), "Cannot read o'brien/.npmrc");
});

// The repository root is the one always-known path: everything under it is
// rewritten RELATIVE to it, whole. These use the real root (TEMPLATE_ROOT's
// parent, the same thing the function derives), so they exercise exactly
// what the running server does.
const REAL_REPO_ROOT = path.dirname(REAL_TEMPLATE_ROOT);

test('sanitizeErrorMessage rewrites a path under the repository root to a repo-relative one', () => {
  assert.equal(
    sanitizeErrorMessage('Bundle at ' + path.join(REAL_REPO_ROOT, 'template', 'reference') + ' contains files outside the template contract: notes.txt.'),
    'Bundle at template/reference contains files outside the template contract: notes.txt.'
  );
  assert.equal(
    sanitizeErrorMessage("Cannot find module '" + path.join(REAL_REPO_ROOT, 'node_modules', '@vtex', 'x', 'index.js') + "'"),
    "Cannot find module 'node_modules/@vtex/x/index.js'"
  );
  // The root itself, even at the end of a sentence, is the repository
  // folder's name — never `.`, which would read `..` there.
  assert.equal(sanitizeErrorMessage('Running in ' + REAL_REPO_ROOT + '.'), 'Running in ' + path.basename(REAL_REPO_ROOT) + '.');
  // Boundary semantics kept: a sibling that merely starts with the root's
  // spelling, or a longer path that ends with it, is not under it.
  assert.equal(sanitizeErrorMessage('open ' + REAL_REPO_ROOT + '2/a/b.js'), 'open b.js');
  assert.equal(sanitizeErrorMessage('open /private' + REAL_REPO_ROOT + '/a/b.js'), 'open b.js');
});

test('sanitizeErrorMessage protects the whole rest of an in-repository path from the generic pattern', () => {
  // Before: only the known prefix was held back, so the generic pattern saw
  // the rest — `/x/y.png` right after `)` or `-` — as a fresh absolute path
  // and collapsed it onto what was before (`ref(1)y.png`, `a-c`).
  assert.equal(
    sanitizeErrorMessage("open '" + REAL_REPO_ROOT + "/template/ref(1)/x/y.png'"),
    "open 'template/ref(1)/x/y.png'"
  );
  assert.equal(sanitizeErrorMessage('open ' + REAL_REPO_ROOT + '/a-/b/c'), 'open a-/b/c');
  // Finder's duplicate-folder shape, space and all.
  assert.equal(
    sanitizeErrorMessage("open '" + REAL_REPO_ROOT + "/template/foo (1)/x/y.png'"),
    "open 'template/foo (1)/x/y.png'"
  );
});

test('sanitizeErrorMessage leaves prose punctuation and a :line:column suffix outside the protected path', () => {
  assert.equal(sanitizeErrorMessage('at ' + REAL_REPO_ROOT + '/lib/x.js:12:3'), 'at lib/x.js:12:3');
  assert.equal(sanitizeErrorMessage('at fn (' + REAL_REPO_ROOT + '/lib/x.js:12:3)'), 'at fn (lib/x.js:12:3)');
  assert.equal(sanitizeErrorMessage('(see ' + REAL_REPO_ROOT + '/lib/x.js)'), '(see lib/x.js)');
  assert.equal(sanitizeErrorMessage('failed: ' + REAL_REPO_ROOT + '/lib/x.js, then stopped.'), 'failed: lib/x.js, then stopped.');
  assert.equal(sanitizeErrorMessage(REAL_REPO_ROOT + '/lib/x.js (see above)'), 'lib/x.js (see above)');
});

// A repository root spelled with the very characters the generic pattern
// cuts at. Through the test-only seam that takes the root as an argument
// (rather than mocking os/fs or moving the checkout); sanitizeErrorMessage
// itself is that same function with the real root.
test("sanitizeErrorMessage handles a repository root containing an apostrophe or parentheses (o'brien, Projects(old)x)", () => {
  const obrien = "/Users/o'brien/Documents/payment-mocker";
  assert.equal(
    _sanitizeErrorMessageForRoot("ENOENT: no such file or directory, open '" + obrien + "/template/reference/index.html'", [], obrien),
    "ENOENT: no such file or directory, open 'template/reference/index.html'"
  );
  const projects = '/Users/me/Projects(old)x/payment-mocker';
  assert.equal(
    _sanitizeErrorMessageForRoot('Bundle at ' + projects + '/template/reference has x', [projects + '/template/reference'], projects),
    'Bundle at template/reference has x'
  );
  assert.equal(
    _sanitizeErrorMessageForRoot('at (' + projects + '/lib/x.js:1:2) and ' + projects + '.', [], projects),
    'at (lib/x.js:1:2) and payment-mocker.'
  );
  // Windows spellings of the same root, either separator.
  const windowsRoot = "C:\\Users\\o'brien\\payment-mocker";
  assert.equal(_sanitizeErrorMessageForRoot('open ' + windowsRoot + '\\lib\\x.js now', [], windowsRoot), 'open lib\\x.js now');
  assert.equal(_sanitizeErrorMessageForRoot("open C:/Users/o'brien/payment-mocker/lib/x.js now", [], windowsRoot), 'open lib/x.js now');
});

test('sanitizeErrorMessage only replaces a known path at a path boundary, never from the middle of a longer one', () => {
  // `/Users/me` must not be cut out of `/Users/meg/...` (which would leave a
  // relative `~g/...`), nor `/var/x` out of `/private/var/x/...` — those fall
  // through to the generic pattern, which reduces them to their basename.
  assert.equal(sanitizeErrorMessage('open /Users/meg/proj/a.js', ['/Users/me']), 'open a.js');
  assert.equal(sanitizeErrorMessage('open /private/var/x/template/a.png', ['/var/x/template']), 'open a.png');
  // A relative "known path" is ignored outright: it would match prose.
  assert.equal(sanitizeErrorMessage('the template is broken', ['template']), 'the template is broken');
});
