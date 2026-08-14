'use strict';

const { readPreviewConfig } = require('./preview-config');
const { validateBundle } = require('./validate-bundle');

const VALIDATION_PATH = '/validation.json';

function createValidationMiddleware() {
  return function validationMiddleware(req, res, next) {
    if (!req.url || req.url.split('?')[0] !== VALIDATION_PATH) {
      next();
      return;
    }

    let config;
    try {
      config = readPreviewConfig();
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, errors: [], message: error.message }));
      return;
    }

    validateBundle(config)
      .then(function (result) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(JSON.stringify(result));
      })
      .catch(function (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, errors: [], message: error.message }));
      });
  };
}

module.exports = {
  VALIDATION_PATH,
  createValidationMiddleware,
};
