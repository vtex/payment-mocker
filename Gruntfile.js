/*!
 * VTEX Payment Mocker — Grunt dev server
 */

'use strict';

var path = require('path');
var LIVERELOAD_PORT = 35729;
var lrSnippet = require('connect-livereload')({
  port: LIVERELOAD_PORT
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
        hostname: '*'
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
        files: [
          'template/**/*.{html,css,json,png,jpg,jpeg,webp}',
          'lib/**/*.js'
        ],
        tasks: ['validate']
      },
      livereload: {
        options: {
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
          livereload: { port: LIVERELOAD_PORT, liveCSS: false, liveImg: false }
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
