/*!
 * maonaroda Gruntfile
 * http://vtex.github.io/maonaroda
 * @author Augusto Barbosa
 */

'use strict';

var LIVERELOAD_PORT = 35729;
var lrSnippet = require('connect-livereload')({
  port: LIVERELOAD_PORT
});

var mountFolder = function(connect, dir) {
  return require('serve-static')(require('path').resolve(dir));
};

module.exports = function(grunt) {

  require('load-grunt-tasks')(grunt);

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    project: {
      src: 'src',
      build: 'build',
      assets: '<%= project.src %>/assets'
    },
    connect: {
      options: {
        port: 8080,
        hostname: '*'
      },
      livereload: {
        options: {
          middleware: function(connect) {
            return [lrSnippet, mountFolder(connect, 'src')];
          }
        }
      }
    },
    less: {
      dev: {
        files: {
          '<%= project.assets %>/css/less/style.css': '<%= project.assets %>/css/less/style.less'
        }
      },
      bootstrap: {
        files: {
          '<%= project.assets %>/css/bootstrap.css': '<%= project.assets %>/css/bootstrap/bootstrap.less'
        }
      }
    },
    sass: {
      dev: {
        options: {
          style: 'expanded'
        },
        files: {
          '<%= project.assets %>/css/sass/style.css': '<%= project.assets %>/css/sass/style.scss'
        }
      }
    },
    watch: {
      css: {
        files: ['<%= project.assets %>/css/less/style.less', '<%= project.assets %>/css/sass/style.scss'],
        tasks: ['less:dev', 'sass:dev']
      },
      livereload: {
        options: {
          livereload: LIVERELOAD_PORT
        },
        files: [
          '<%= project.src %>/{,*/}*.html',
          '<%= project.assets %>/css/{,*/}*.css',
          '<%= project.assets %>/js/{,*/}*.js',
          '<%= project.assets %>/{,*/}*.{png,jpg,jpeg,gif,webp,svg}'
        ]
      }
    },
    copy: {
      main: {
        expand: true,
        cwd: 'src/',
        src: ['**'],
        dest: 'build/'
      }
    },
    clean: {
      build: ['<%= project.build %>'],
      css: ['<%= project.build %>/assets/css/bootstrap', '<%= project.build %>/assets/css/**/*.less', '<%= project.build %>/assets/css/**/*.scss']
    },
    concurrent: {
      dev: {
        tasks: ['watch:css', 'watch:livereload']
      }
    },
    'gh-pages': {
      options: {
        base: 'build'
      },
      src: ['**']
    }
  });

  grunt.task.registerTask('default', [
    'less:dev',
    'sass:dev',
    'connect',
    'concurrent:dev'
  ]);

  grunt.registerTask('build', [
    'clean:build',
    'less:dev',
    'sass:dev',
    'copy',
    'clean:css'
  ]);

  grunt.registerTask('dist', [
    'build',
    'gh-pages'
  ]);

};
