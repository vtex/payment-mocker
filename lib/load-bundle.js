'use strict';

const fs = require('fs');
const path = require('path');
const { LOCALE_TAG_SOURCE } = require('@vtex/payment-templates-core/wrap');

const KB = 1024;
// Mirror template/CONTRACT.md's per-file size limits. validate()
// (@vtex/payment-templates-core) is what actually enforces them — its own
// maxFileSize rule reports every file over its cap, the 1 MB whole-bundle
// total and the magic-bytes type check for images — but its byte-cap
// constants aren't exposed from the package's public entry points (only
// internally, under dist/rules/), hence these local copies.
//
// Here they are a READ cap, never a rejection: an oversized file used to make
// loadBundle throw, which took the whole preview down with it (500 on the
// wrapped index, a lone `load` finding in place of validate()'s full list, an
// empty locale switcher) — the opposite of README.md's "a failing bundle
// still gets a running preview". Now each file is fs.statSync'd first, and
// one over its cap has only its first `maxBytes` bytes read (readFilePrefix
// below), never the whole thing, while its entry keeps the REAL size from
// that stat. That real size is what lets validate() report the oversize
// file — and, because every file's real size now reaches it, the 1 MB
// whole-bundle total too — while loadBundle never reads more of any one file
// than that file's cap. See toValidationBundle for how a truncated entry is
// handed to validate(), which insists on `size === buffer.byteLength` (and
// for the separate, larger bound on the padded copy that requires).
const MAX_HTML_BYTES = 128 * KB;
const MAX_CSS_BYTES = 128 * KB;
const MAX_ASSET_BYTES = 256 * KB;
const MAX_I18N_BYTES = 64 * KB;
// Upper bound on the size a truncated entry may claim when handed to
// validate(). validate() requires `size === buffer.byteLength`, so a truncated
// entry has to be padded back out to its real size first (see
// toValidationFileEntry), and validate() then UTF-8-decodes and parses the
// whole padded buffer for text roles — measured at roughly 115 ms per MB of
// HTML on the machine this was written on, all of it synchronous on the
// preview server's single event loop. 4 MB is four times CONTRACT.md's own
// 1 MB whole-bundle cap, so any single file past it is not a borderline case,
// and keeps that cost well under a second. A file past THIS bound fails
// toValidationBundle with its own clear message instead (reported as a single
// `load` finding by the preview's validation route) — loadBundle itself, and
// with it the preview and the locale switcher, is unaffected either way.
const MAX_VALIDATION_PADDED_BYTES = 4 * 1024 * KB;

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

/**
 * Reads at most `maxBytes` bytes from the start of `filePath` — never the
 * whole file — via openSync/readSync. Loops because readSync may return fewer
 * bytes than asked for; stops early at EOF (the file may have shrunk since it
 * was stat'd). Open/read failures (EACCES, the file vanishing, ...) propagate
 * exactly as fs.readFileSync's would for a file under its cap: an unreadable
 * file is a real load failure either way, not a merely-oversized one.
 */
function readFilePrefix(filePath, maxBytes) {
  const buffer = Buffer.alloc(maxBytes);
  const fd = fs.openSync(filePath, 'r');
  let total = 0;
  try {
    while (total < maxBytes) {
      const bytesRead = fs.readSync(fd, buffer, total, maxBytes - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return buffer.subarray(0, total);
}

/**
 * Length of the longest prefix of `bytes` that ends on a complete UTF-8
 * sequence. A read cut off at an arbitrary byte count can split a multi-byte
 * character, and validate() decodes text strictly — so without trimming that
 * partial tail, an oversize file with any non-ASCII text near its cap would
 * pick up a spurious "could not read as UTF-8" finding on top of the real
 * maxFileSize one. Only looks back over the last (at most 3) bytes; anything
 * malformed earlier in the prefix is the file's own problem, left for
 * validate() to report as it would for an in-cap file.
 */
function utf8CompletePrefixLength(bytes) {
  const end = bytes.byteLength;
  for (let back = 1; back <= Math.min(3, end); back++) {
    const byte = bytes[end - back];
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: keep looking back
    let needed = 1;
    if ((byte & 0xe0) === 0xc0) needed = 2;
    else if ((byte & 0xf0) === 0xe0) needed = 3;
    else if ((byte & 0xf8) === 0xf0) needed = 4;
    return needed > back ? end - back : end;
  }
  return end;
}

function readFileEntry(dir, name, size, maxBytes) {
  const filePath = path.join(dir, name);
  if (size <= maxBytes) {
    const buffer = fs.readFileSync(filePath);
    return {
      name,
      size: buffer.byteLength,
      buffer: new Uint8Array(buffer),
      text: buffer.toString('utf8'),
    };
  }
  // Oversized: see the comment above MAX_HTML_BYTES. `size` is the real,
  // stat'd size (what validate() must report), while `buffer`/`text` hold
  // only the prefix actually read — so on a `truncated` entry, and only
  // there, `size !== buffer.byteLength`. `text` is decoded from the prefix
  // trimmed back to a complete UTF-8 sequence, so the wrapped preview renders
  // the file's first `maxBytes` bytes cleanly rather than ending on a U+FFFD.
  // (A truncated i18n file is still, necessarily, cut-off JSON: wrapTemplate
  // JSON.parses it and the wrapped index fails the same way it already does
  // for any malformed i18n file — /template-validation.json and the locale
  // switcher are unaffected.)
  const prefix = readFilePrefix(filePath, maxBytes);
  return {
    name,
    size,
    buffer: new Uint8Array(prefix),
    text: prefix.subarray(0, utf8CompletePrefixLength(prefix)).toString('utf8'),
    truncated: true,
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
function readRequiredFileEntry(dir, name, maxBytes) {
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
  return readFileEntry(dir, name, stat.size, maxBytes);
}

function loadBundle(bundleDir) {
  const html = readRequiredFileEntry(bundleDir, 'index.html', MAX_HTML_BYTES);
  const css = readRequiredFileEntry(bundleDir, 'style.css', MAX_CSS_BYTES);
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
      const size = fs.statSync(path.join(bundleDir, entry)).size;
      i18n[i18nMatch[1]] = readFileEntry(bundleDir, entry, size, MAX_I18N_BYTES);
      continue;
    }
    if (entry.startsWith('asset-')) {
      const size = fs.statSync(path.join(bundleDir, entry)).size;
      assets.push(readFileEntry(bundleDir, entry, size, MAX_ASSET_BYTES));
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

const ASCII_SPACE = 0x20;

/**
 * Turns one loaded file entry into the `{ name, size, buffer }` FileEntry
 * validate() takes. An in-cap entry passes through as-is. A `truncated` one
 * (see readFileEntry) can't: validate() throws a TypeError unless
 * `size === buffer.byteLength` (its contract makes `size` authoritative for
 * maxFileSize), so the prefix actually read is copied into a buffer of the
 * real size and the unread remainder is filled in:
 *
 * - `text` roles (HTML, CSS, i18n) are filled with ASCII spaces, after first
 *   trimming the prefix back to a complete UTF-8 sequence — whitespace is
 *   inert in all three formats and always valid UTF-8, so validate()'s
 *   strict decode and its HTML/CSS parse see "the file's first N bytes,
 *   then nothing", not a spurious encoding error. What the content rules
 *   report about that prefix can still reflect the cut: most notably a
 *   truncated i18n file is cut-off JSON, so it also gets an
 *   i18nKeyConsistency "Could not parse ... as JSON" finding (and its keys
 *   aren't compared against the other locales'); an HTML file cut
 *   mid-element can likewise get a tag-balance finding. Accepted, not
 *   filtered out: the maxFileSize finding for the same file is right beside
 *   it, both clear once the file is back under its cap, and suppressing a
 *   rule's finding here would mean second-guessing the validator.
 * - image roles (assets, icon) are left zero-filled: validate() only ever
 *   inspects their leading bytes (magic bytes, the dimensions in the image
 *   header, a 256-byte SVG sniff), all of which are inside the prefix.
 *
 * `roleLabel` only appears in the error for an entry past
 * MAX_VALIDATION_PADDED_BYTES (see that constant).
 */
function toValidationFileEntry(file, isText, roleLabel) {
  if (!file.truncated) {
    return { name: file.name, size: file.size, buffer: file.buffer };
  }
  if (file.size > MAX_VALIDATION_PADDED_BYTES) {
    throw new Error(
      `${file.name} is ${file.size} bytes, far over the size limit for each ${roleLabel} and over the ${MAX_VALIDATION_PADDED_BYTES}-byte ceiling up to which the local preview can hand an oversized file to the validator at all — shrink or remove it to see the rest of the bundle's findings.`
    );
  }
  const padded = new Uint8Array(file.size);
  if (isText) {
    const keep = utf8CompletePrefixLength(file.buffer);
    padded.set(file.buffer.subarray(0, keep));
    padded.fill(ASCII_SPACE, keep);
  } else {
    padded.set(file.buffer);
  }
  return { name: file.name, size: file.size, buffer: padded };
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
    i18nEntries[locale] = toValidationFileEntry(file, true, 'i18n file');
  }

  return {
    html: toValidationFileEntry(bundle.html, true, 'HTML file'),
    css: toValidationFileEntry(bundle.css, true, 'CSS file'),
    i18n: i18nEntries,
    assets: bundle.assets.map((asset) => toValidationFileEntry(asset, false, 'asset')),
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
  readFilePrefix,
  toValidationBundle,
  toValidationFileEntry,
};
