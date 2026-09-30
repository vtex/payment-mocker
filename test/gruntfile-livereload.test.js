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
