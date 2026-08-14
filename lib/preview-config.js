'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATE_ROOT = path.join(__dirname, '..', 'template');
const CONFIG_PATH = path.join(TEMPLATE_ROOT, 'preview.config.json');

function readPreviewConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);
  if (!config.bundleDir || !config.defaultLocale) {
    throw new Error('preview.config.json requires bundleDir and defaultLocale.');
  }
  config.bundlePath = path.join(TEMPLATE_ROOT, config.bundleDir);
  return config;
}

module.exports = {
  TEMPLATE_ROOT,
  CONFIG_PATH,
  readPreviewConfig,
};
