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
              lrSnippet,
              previewMiddleware(),
              mountFolder(connect, 'template'),
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
          livereload: LIVERELOAD_PORT
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

    if (result.status !== 0) {
      grunt.fail.fatal('Template validation failed. Fix the bundle before previewing.');
    }

    done();
  });

  grunt.registerTask('default', [
    'validate',
    'connect',
    'watch'
  ]);

};
