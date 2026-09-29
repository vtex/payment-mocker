'use strict';

const fs = require('fs');
const path = require('path');
const { LOCALE_TAG_SOURCE } = require('@vtex/payment-templates-core/wrap');

const I18N_FILE_PATTERN = new RegExp('^i18n-(' + LOCALE_TAG_SOURCE + ')\\.json$');
// CONTRACT.md: assets are "raster images (PNG, JPEG, or WebP)" — matching the
// extension here too (not just the `asset-` prefix) is what stops a file like
// `asset-x.html` from passing this gate and being served as a document by the
// preview middleware's static-file route instead of an image.
// `[^/\\]+`, not `.+`: this same pattern is also used directly against a
// (possibly multi-segment) request path in preview-middleware.js's static
// route now, where a bare `.+` would happily match a `/` or `\` too and let
// something like `asset-sub/dir.png` — a nested path, contrary to the flat-
// folder contract — through as if it were a single flat filename.
// Case-insensitive: production's imageSafety rule decides an asset's type by
// its magic bytes, never by the extension in its name (CONTRACT.md doesn't
// require lower-case either), so a case-sensitive match here would make the
// local preview reject a file — `asset-logo.PNG` — that upload-time
// validation accepts.
const ASSET_FILE_PATTERN = /^asset-[^/\\]+\.(?:png|jpe?g|webp)$/i;

/**
 * The bundle contract's filename rule, in one place. `loadBundle` below sorts
 * entries by which arm they match, but the preview middleware's static-file
 * route only needs the yes/no answer — and taking it from here is what keeps
 * that route from growing a second, divergent copy of the same regex (the
 * reason `LOCALE_TAG_SOURCE` above and `ORIGIN_PATTERN` in preview-middleware.js
 * both come from @vtex/payment-templates-core/wrap instead of a local regex
 * apiece).
 */
function isAllowedBundleFilename(name) {
  return (
    name === 'index.html' ||
    name === 'style.css' ||
    I18N_FILE_PATTERN.test(name) ||
    ASSET_FILE_PATTERN.test(name)
  );
}

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

/**
 * Same as readFileEntry, but for index.html/style.css specifically: both are
 * required, so unlike the readdirSync loop below (which can just report an
 * unexpected directory as an unknown contract violation and move on), a
 * missing or wrong-typed one here has to fail loadBundle outright. Checking
 * first means that failure is this function's own clear message instead of
 * fs.readFileSync's raw ENOENT/EISDIR.
 */
function readRequiredFileEntry(dir, name) {
  const filePath = path.join(dir, name);
  let stat;
  try {
    // lstatSync, not statSync: a symlink must be rejected the same way the
    // readdirSync loop below already rejects one for every other bundle file
    // (dirent.isFile() is false for a symlink regardless of its target, since
    // readdirSync never follows it) — otherwise index.html/style.css alone
    // could point outside bundleDir while every other file in the same
    // bundle is held to the opposite rule.
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(`Bundle at ${dir} is missing required file ${name}.`);
  }
  if (!stat.isFile()) {
    throw new Error(`Bundle at ${dir} expects ${name} to be a regular file, not a directory or symlink.`);
  }
  return readFileEntry(dir, name);
}

function loadBundle(bundleDir) {
  const html = readRequiredFileEntry(bundleDir, 'index.html');
  const css = readRequiredFileEntry(bundleDir, 'style.css');
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
    if (!isAllowedBundleFilename(entry)) {
      unknown.push(entry);
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
  isAllowedBundleFilename,
  loadBundle,
  loadBundleForValidation,
  toValidationBundle,
};
