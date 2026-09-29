'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

test('src/index.html disables livereload-js\'s smart CSS/image reload before <head> closes', () => {
  // livereload-js reads window.LiveReloadOptions once, before it connects —
  // see its dist/livereload.js: `if ('LiveReloadOptions' in window) ...`. Its
  // default smart reload for .css/.png/.jpg/.jpeg only patches <link>/<img>
  // tags in this document, and the payment template being edited lives
  // inside the sandboxed #payment-template-iframe instead, a separate
  // document that script can never reach. Without this, editing
  // template/**/style.css or a raster asset silently does nothing.
  const headEnd = INDEX_HTML.indexOf('</head>');
  const optionsIndex = INDEX_HTML.indexOf('window.LiveReloadOptions');
  assert.ok(optionsIndex !== -1, 'window.LiveReloadOptions must be set somewhere in the document');
  assert.ok(optionsIndex < headEnd, 'it must be set before </head>, ahead of the injected livereload snippet');
  assert.match(INDEX_HTML, /window\.LiveReloadOptions\s*=\s*\{\s*liveCSS:\s*false,\s*liveImg:\s*false\s*\}/);
});
