'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Gruntfile.js is a plain config script, not a module built to be required
 * elsewhere — but requiring it with a stub `grunt` is what actually executes
 * its `grunt.initConfig({...})` call and hands back the real config object,
 * which is a far stronger check than a regex over the file's source text.
 * `load-grunt-tasks` only needs `grunt.loadNpmTasks`, a no-op here since
 * nothing downstream of this test ever runs a registered task.
 */
function captureGruntConfig() {
  const captured = {};
  const fakeGrunt = {
    loadNpmTasks: function () {},
    initConfig: function (config) {
      captured.config = config;
    },
    registerTask: function () {},
    log: { error: function () {}, verbose: { writeln: function () {} } },
    fail: { fatal: function () {} },
  };
  const gruntfilePath = path.join(__dirname, '..', 'Gruntfile.js');
  delete require.cache[require.resolve(gruntfilePath)];
  require(gruntfilePath)(fakeGrunt);
  return captured.config;
}

test('Gruntfile.js\'s livereload server declares liveCSS/liveImg: false', () => {
  // grunt-contrib-watch's LR() forwards this whole object straight into
  // tiny-lr's constructor (see its tasks/lib/livereload.js), which stores it
  // and includes `liveCSS`/`liveImg` in every reload message it broadcasts
  // (tiny-lr's lib/client.js, `Client.prototype.reload`). livereload.js's
  // browser client honors whatever the message says — its own
  // `performReload` only defaults those to `true` when the field is missing
  // — which is what makes a .css/.png/.jpg/.jpeg change under
  // watch.livereload.files fall through to a full page reload instead of
  // livereload's built-in "smart" swap. That swap only ever patches
  // <link>/<img> tags in the checkout shell's own document
  // (src/index.html), and can never reach the payment template being
  // edited, which renders inside the sandboxed #payment-template-iframe — a
  // separate document it has no way to touch.
  const config = captureGruntConfig();
  assert.deepEqual(config.watch.livereload.options.livereload, {
    port: 35729,
    liveCSS: false,
    liveImg: false,
  });
});

test('Gruntfile.js\'s watch targets match file extensions case-insensitively', () => {
  // lib/load-bundle.js's ASSET_FILE_PATTERN matches an asset's extension
  // case-insensitively (production decides an asset's type by its bytes,
  // never its name), but grunt-contrib-watch hands this whole options object
  // straight to Gaze (`new Gaze(patterns, target.options, cb)` in its own
  // tasks/watch.js), which matches a changed file against `files` via
  // globule/minimatch — case-sensitively unless told otherwise. Verified
  // directly against the installed globule (gaze's own matcher) outside this
  // test file, since globule/gaze are transitive dependencies this suite
  // shouldn't require on its own: `globule.isMatch(['**/*.png'],
  // 'asset-logo.PNG', {})` is false, `{ nocase: true }` is true. Without
  // this option, saving `asset-logo.PNG` on a case-sensitive filesystem
  // (Linux; not macOS's default case-insensitive one, which never reproduces
  // this) matched neither watch target, so nothing here ever noticed the
  // save.
  const config = captureGruntConfig();
  assert.equal(config.watch.validate.options.nocase, true);
  assert.equal(config.watch.livereload.options.nocase, true);
});

function invokeConnectLivereloadSnippet(hostHeader) {
  const config = captureGruntConfig();
  const middlewareStack = config.connect.livereload.options.middleware(null);
  const lrSnippet = middlewareStack[1]; // [previewMiddleware(), lrSnippet, mountFolder(...)]
  const res = {
    headersSent: false,
    setHeader: function () {},
    getHeader: function () {},
    removeHeader: function () {},
    end: function (body) {
      this.body = body;
    },
    write: function () {
      return true;
    },
    writeHead: function () {},
  };
  const req = { headers: { host: hostHeader, accept: 'text/html' }, url: '/' };
  lrSnippet(req, res, function next() {});
  res.end('<html><body></body></html>');
  return res.body;
}

test('the injected livereload <script> tag is valid for every Host isLocalHostname accepts, including bracketed IPv6', () => {
  // connect-livereload's own index.js derives the injected script's host from
  // `opt.hostname || req.headers.host.split(':')[0]` — without `hostname` set
  // (Gruntfile.js's lrSnippet), a bracketed IPv6 Host like '[::1]:8080' splits
  // on ':' to '[' (the first fragment), producing the broken
  // `<script src="//[:35729/...">` — a URL the browser can never load,
  // meaning livereload silently never connects at all when reached via
  // '[::1]'. Reproduced directly against the real, installed
  // connect-livereload before fixing: confirmed the broken output for the
  // no-hostname-option config, and this output for the fixed one.
  for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080']) {
    const body = invokeConnectLivereloadSnippet(host);
    assert.match(
      body,
      /<script src="\/\/localhost:35729\/livereload\.js\?snipver=1"/,
      'Host ' + host + ' must produce a loadable livereload <script> src'
    );
  }
});

test('src/index.html does not set window.LiveReloadOptions', () => {
  // A prior attempt at the fix above set this client-side instead. It broke
  // livereload outright: livereload.js only reads the injected
  // <script src="//host:port/...livereload.js"> tag's own host and port
  // (via Options.extract) when window.LiveReloadOptions is absent — with it
  // set, host stays its uninitialized `null`, and the client tries to
  // connect to the literal address `ws://null:35729`, which never connects,
  // for every file, not just CSS/images. Regression guard against
  // reintroducing that specific shape of fix.
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  assert.ok(!indexHtml.includes('LiveReloadOptions'), 'must not set window.LiveReloadOptions client-side');
});
