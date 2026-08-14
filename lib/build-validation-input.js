'use strict';

const fs = require('fs');
const path = require('path');
const { loadBundleForValidation } = require('./load-bundle');

function readFileEntry(dir, name) {
  const filePath = path.join(dir, name);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    throw new Error('File not found: ' + name + ' in ' + dir);
  }

  const buffer = fs.readFileSync(filePath);
  return {
    name: path.basename(name),
    size: buffer.byteLength,
    buffer: new Uint8Array(buffer),
  };
}

/**
 * Maps preview.config.json + bundle folder into ValidationInput for
 * @vtex/payment-templates-validator — same shape the upload handler consumes.
 */
function buildValidationInput(config) {
  const template = loadBundleForValidation(config.bundlePath, config.defaultLocale);
  const input = { template };

  if (config.icon) {
    const iconName = String(config.icon).replace(/^\.\//, '');
    input.icon = readFileEntry(config.bundlePath, iconName);
  }

  if (config.displayName && typeof config.displayName === 'object') {
    input.displayName = config.displayName;
  }

  return input;
}

module.exports = {
  buildValidationInput,
  readFileEntry,
};
