'use strict';

const fs = require('fs');
const path = require('path');
const { LOCALE_TAG_SOURCE } = require('./locale-tag');

const I18N_FILE_PATTERN = new RegExp('^i18n-(' + LOCALE_TAG_SOURCE + ')\\.json$');

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
  const unknown = [];

  for (const dirent of fs.readdirSync(bundleDir, { withFileTypes: true })) {
    const entry = dirent.name;
    if (entry === 'index.html' || entry === 'style.css') {
      continue;
    }
    if (entry.startsWith('.')) {
      continue;
    }
    // Anything that isn't a regular file — a directory (e.g. a stray
    // `asset-icons/` folder), a symlink, a socket, ... — is reported as an
    // unknown contract violation instead of being handed to readFileEntry,
    // which calls fs.readFileSync and would throw a raw `EISDIR: illegal
    // operation on a directory, read` for a directory whose name happens to
    // match the i18n/asset pattern.
    if (!dirent.isFile()) {
      unknown.push(entry);
      continue;
    }
    const i18nMatch = I18N_FILE_PATTERN.exec(entry);
    if (i18nMatch) {
      i18n[i18nMatch[1]] = readFileEntry(bundleDir, entry);
      continue;
    }
    if (entry.startsWith('asset-')) {
      assets.push(readFileEntry(bundleDir, entry));
      continue;
    }
    unknown.push(entry);
  }

  if (Object.keys(i18n).length === 0) {
    throw new Error(`No i18n-{locale}.json files found in ${bundleDir}`);
  }

  if (unknown.length > 0) {
    throw new Error(
      `Bundle at ${bundleDir} contains files outside the template contract: ${unknown.join(
        ', '
      )}. Rename i18n files to i18n-{xx-XX}.json and assets to asset-<label>.<ext>.`
    );
  }

  return { html, css, i18n, assets };
}

/**
 * Reshapes an already-loaded bundle (as returned by `loadBundle`) into the
 * slimmer buffer-only shape the validator expects. Pure/no I/O, so callers
 * that already hold a loaded bundle (e.g. the preview middleware, which also
 * needs the full bundle to build the wrap) can reuse it instead of paying for
 * a second `loadBundle` disk read.
 */
function toValidationBundle(bundle, defaultLocale) {
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

function loadBundleForValidation(bundleDir, defaultLocale) {
  const bundle = loadBundle(bundleDir);
  return toValidationBundle(bundle, defaultLocale);
}

module.exports = {
  loadBundle,
  loadBundleForValidation,
  toValidationBundle,
};
