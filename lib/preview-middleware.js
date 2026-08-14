'use strict';

const fs = require('fs');
const path = require('path');
const { loadBundle } = require('./load-bundle');
const { readPreviewConfig } = require('./preview-config');

const BUNDLE_PREFIX = '/template-bundle/';

function invalidateWrapCache() {
  ['./wrap-template.js', './wrapper-runtime.js'].forEach(function (modulePath) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch (error) {
      // Module may not be loaded yet.
    }
  });
}

function wrapTemplate(bundle, defaultLocale) {
  invalidateWrapCache();
  return require('./wrap-template').wrapTemplate(bundle, defaultLocale);
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function createPreviewMiddleware() {
  return function previewMiddleware(req, res, next) {
    if (!req.url || req.url.indexOf(BUNDLE_PREFIX) !== 0) {
      next();
      return;
    }

    let config;
    try {
      config = readPreviewConfig();
    } catch (error) {
      res.statusCode = 500;
      res.end('Invalid preview.config.json: ' + error.message);
      return;
    }

    const relativePath = decodeURIComponent(req.url.slice(BUNDLE_PREFIX.length).split('?')[0]);

    if (relativePath === '' || relativePath === 'index.html') {
      try {
        const bundle = loadBundle(config.bundlePath);
        const html = wrapTemplate(bundle, config.defaultLocale);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(html);
      } catch (error) {
        res.statusCode = 500;
        res.end('Failed to wrap template: ' + error.message);
      }
      return;
    }

    const filePath = path.join(config.bundlePath, relativePath);
    const normalizedRoot = path.resolve(config.bundlePath) + path.sep;
    if (!path.resolve(filePath).startsWith(normalizedRoot)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      next();
      return;
    }

    res.setHeader('Content-Type', contentType(filePath));
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(filePath).pipe(res);
  };
}

module.exports = {
  BUNDLE_PREFIX,
  createPreviewMiddleware,
};
