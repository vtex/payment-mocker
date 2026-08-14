/*!
 * VTEX Payment Mocker — Grunt dev server
 */

'use strict';

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

  grunt.registerTask('default', [
    'connect',
    'watch:livereload'
  ]);

};
