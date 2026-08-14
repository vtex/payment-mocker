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
var validationMiddleware = require('./lib/validation-middleware').createValidationMiddleware;

function runValidateTask(grunt, done, soft) {
  var validateBundle = require('./lib/validate-bundle').validateBundle;
  var printValidationResult = require('./lib/format-validation-output').printValidationResult;
  var config = require('./lib/preview-config').readPreviewConfig();

  validateBundle(config)
    .then(function(result) {
      printValidationResult(result, {
        suffix: ' — template at template/' + config.bundleDir,
      });

      if (!result.ok) {
        if (soft) {
          grunt.log.error('Template validation failed. Fix reported errors.');
          done();
          return;
        }
        grunt.fail.fatal('Template validation failed. Fix the bundle before previewing.');
      }

      done();
    })
    .catch(function(error) {
      if (soft) {
        grunt.log.error(error);
        done();
        return;
      }
      grunt.fail.fatal(error);
    });
}

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
              validationMiddleware(),
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
        tasks: ['validate:soft']
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
    runValidateTask(grunt, this.async(), false);
  });

  grunt.registerTask('validate:soft', function() {
    runValidateTask(grunt, this.async(), true);
  });

  grunt.registerTask('default', [
    'validate:soft',
    'connect',
    'watch'
  ]);

};
