/*!
 * VTEX Payment Mocker — Grunt dev server
 */

'use strict';

var path = require('path');
var LIVERELOAD_PORT = 35729;
var lrSnippet = require('connect-livereload')({
  port: LIVERELOAD_PORT,
  // hostname: '127.0.0.1', not left to connect-livereload's own default —
  // without it, the injected <script> tag's host comes from
  // `req.headers.host.split(':')[0]` (connect-livereload's index.js), which
  // breaks for the bracketed IPv6 form isLocalHostname accepts
  // (lib/preview-middleware.js): splitting 'Host: [::1]:8080' on ':' gives
  // '[' as the "host", producing the broken `<script src="//[:35729/...">`.
  // A literal IP instead of the name 'localhost': Node's own `.listen(port,
  // 'localhost')` resolves that name to a single address — on some
  // systems/setups, IPv6's `::1` — and binds only that one, so a browser
  // whose own 'localhost' resolution picks the other family could fail to
  // connect at all rather than just falling back. Pointing this at literally
  // whatever address the livereload server itself binds (`host: '127.0.0.1'`
  // in watch.livereload.options.livereload below) removes that ambiguity
  // entirely instead of relying on both resolving the name the same way.
  hostname: '127.0.0.1'
});

var mountFolder = function(connect, dir) {
  return require('serve-static')(require('path').resolve(dir));
};

var previewMiddleware = require('./lib/preview-middleware').createPreviewMiddleware;

module.exports = function(grunt) {

  require('load-grunt-tasks')(grunt);

  grunt.initConfig({
    connect: {
      options: {
        port: 8080,
        // hostname: '127.0.0.1', not '*' (every interface): this server
        // hands out the partner's own unpublished bundle, icon and
        // validator findings with no authentication of any kind, and
        // lib/preview-middleware.js's own Host-header allow-list
        // (isLocalHostname) only ever closed DNS rebinding — it can't stop a
        // non-browser client on the LAN from setting Host: localhost itself,
        // since Host is just a request header, not a property of which
        // interface the connection actually arrived on. Binding the socket
        // itself to loopback is what actually keeps such a client out; it
        // also means previewing from another device (e.g. a phone) on the
        // same network no longer works, but that already didn't work once
        // the Host allow-list shipped — every route the previewed page
        // depends on already rejected that device's own real Host header.
        //
        // A literal IP, not the name 'localhost': `.listen(port,
        // 'localhost')` resolves that name to a single address before
        // binding — confirmed against a real server on this machine, it came
        // back as IPv6's `::1` only, leaving `http://127.0.0.1:8080/`
        // (an address plenty of tooling and muscle memory reaches for)
        // unable to connect at all rather than merely not preferred. Pinning
        // the literal address sidesteps whatever a given OS/Node version
        // happens to resolve the name to.
        hostname: '127.0.0.1'
      },
      livereload: {
        options: {
          middleware: function(connect) {
            return [
              previewMiddleware(),
              lrSnippet,
              mountFolder(connect, 'src')
            ];
          }
        }
      }
    },
    watch: {
      validate: {
        options: {
          // nocase: true — lib/load-bundle.js's ASSET_FILE_PATTERN accepts an
          // asset's extension case-insensitively (production decides an
          // asset's type by its bytes, never its name), but grunt-contrib-watch
          // hands this whole options object straight to Gaze, which matches a
          // changed file against `files` below via globule/minimatch — case-
          // sensitively by default. Without this, saving `asset-logo.PNG` on
          // a case-sensitive filesystem (Linux; not macOS's default
          // case-insensitive one, which never reproduces this) matched
          // nothing, so neither this task nor the livereload target below
          // ever noticed the save.
          nocase: true
        },
        files: [
          'template/**/*.{html,css,json,png,jpg,jpeg,webp}',
          'lib/**/*.js'
        ],
        tasks: ['validate']
      },
      livereload: {
        options: {
          // nocase: true — see watch.validate.options' own copy of this
          // comment just above; same gap, same fix, for the same set of file
          // extensions in the `files` list below.
          nocase: true,
          // liveCSS/liveImg: false — not just the port — because
          // grunt-contrib-watch forwards this whole object straight to
          // tiny-lr's constructor (see its lib/livereload.js), which stores
          // it and includes `liveCSS`/`liveImg` in every reload message it
          // broadcasts (tiny-lr's lib/client.js). livereload.js's browser
          // client then honors whatever the message says (its own
          // performReload only defaults to true when the field is missing
          // entirely), which is what makes a .css/.png/.jpg/.jpeg change
          // fall through to a full page reload instead of livereload's
          // built-in "smart" swap — the only thing that reaches the payment
          // template, since it lives inside the sandboxed
          // #payment-template-iframe, a document that swap can never patch
          // (it only ever touches <link>/<img> tags in the checkout shell's
          // own document). This is a server-side setting for exactly that
          // reason: a client-side `window.LiveReloadOptions` override was
          // tried first and reverted — livereload.js only reads the
          // <script src="//host:port/...livereload.js"> tag's own host/port
          // when that global is absent, so setting it broke every reload,
          // not just the CSS/image ones (the socket connected to
          // `ws://null:35729`, since nothing there is what it extracts host
          // from).
          // host: '127.0.0.1' — tiny-lr (which this object is forwarded to
          // wholesale) defaults its own `host` to '*' independently of
          // connect's own hostname above, and otherwise broadcasts every
          // saved file's path to any websocket client that connects to this
          // port from the LAN. A literal IP, not 'localhost': same reasoning
          // as connect.options.hostname's own copy of this comment above —
          // and lrSnippet's `hostname` (this file, near the top) is pinned to
          // this exact address so the injected <script> tag always points at
          // whatever this is actually bound to.
          livereload: { port: LIVERELOAD_PORT, host: '127.0.0.1', liveCSS: false, liveImg: false }
        },
        files: [
          'src/{,*/}*.html',
          'src/**/*.css',
          'src/**/*.{png,jpg,jpeg,gif,webp,svg,js}',
          'template/**/*.{html,css,json,png,jpg,jpeg,webp}',
          'lib/**/*.js'
        ]
      }
    }
  });

  grunt.registerTask('validate', function() {
    var done = this.async();
    var script = path.join(__dirname, 'scripts', 'validate-reference.js');
    var result = require('child_process').spawnSync(process.execPath, [script], {
      stdio: 'inherit'
    });

    // Never fatal: grunt.fail.fatal kills the whole process before `connect`
    // and `watch` ever run, so an invalid bundle meant no server at all —
    // no preview and no error banner either. The same task is re-run by
    // watch on every save, so it would also tear down an already-running
    // server the moment a file was saved mid-edit. The browser-facing
    // /template-validation.json + banner (lib/preview-middleware.js,
    // src/assets/libs/template-host.js) is the dev-facing report of these
    // findings, and it is deliberately non-blocking; this task only logs.
    if (result.status !== 0) {
      grunt.log.error('Template validation failed. The preview will still start; fix the bundle to clear the banner.');
    }

    done();
  });

  grunt.registerTask('default', [
    'validate',
    'connect',
    'watch'
  ]);

};
