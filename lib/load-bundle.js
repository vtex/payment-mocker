'use strict';

const fs = require('fs');
const path = require('path');

function readFileEntry(dir, name) {
  const filePath = path.join(dir, name);
  const buffer = fs.readFileSync(filePath);
  return {
    name,
    size: buffer.byteLength,
    buffer: new Uint8Array(buffer),
    text: buffer.toString('utf8'),
  };
}

function loadBundle(bundleDir) {
  const html = readFileEntry(bundleDir, 'index.html');
  const css = readFileEntry(bundleDir, 'style.css');
  const i18n = {};
  const assets = [];

  for (const entry of fs.readdirSync(bundleDir)) {
    const i18nMatch = /^i18n-([a-z]{2}-[A-Z]{2})\.json$/.exec(entry);
    if (i18nMatch) {
      i18n[i18nMatch[1]] = readFileEntry(bundleDir, entry);
      continue;
    }
    if (entry.startsWith('asset-')) {
      assets.push(readFileEntry(bundleDir, entry));
    }
  }

  if (Object.keys(i18n).length === 0) {
    throw new Error(`No i18n-{locale}.json files found in ${bundleDir}`);
  }

  return { html, css, i18n, assets };
}

function loadBundleForValidation(bundleDir, defaultLocale) {
  const bundle = loadBundle(bundleDir);
  const i18nEntries = {};
  for (const [locale, file] of Object.entries(bundle.i18n)) {
    i18nEntries[locale] = {
      name: file.name,
      size: file.size,
      buffer: file.buffer,
    };
  }

  return {
    html: { name: bundle.html.name, size: bundle.html.size, buffer: bundle.html.buffer },
    css: { name: bundle.css.name, size: bundle.css.size, buffer: bundle.css.buffer },
    i18n: i18nEntries,
    assets: bundle.assets.map((asset) => ({
      name: asset.name,
      size: asset.size,
      buffer: asset.buffer,
    })),
    defaultLocale,
  };
}

module.exports = {
  loadBundle,
  loadBundleForValidation,
};
