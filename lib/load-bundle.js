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
// Here they are never a rejection: an oversized file used to make loadBundle
// throw, which took the whole preview down with it (500 on the wrapped index,
// a lone `load` finding in place of validate()'s full list, an empty locale
// switcher) — the opposite of README.md's "a failing bundle still gets a
// running preview". Each file is fs.statSync'd first, and its entry always
// keeps the REAL size from that stat. That real size is what lets validate()
// report the oversize file — and, because every file's real size reaches it,
// the 1 MB whole-bundle total too. What happens to the CONTENT of a file over
// its cap depends on what kind of file it is:
//
// - Text files (index.html, style.css, i18n-*.json) are read WHOLE, cap or no
//   cap, up to MAX_VALIDATION_BYTES (4 MB, see there). They used to be read
//   only up to their cap, like images still are, and the unread rest was
//   padded with spaces before validate() saw it. That made validate() report
//   things that weren't true: everything past the cut was simply gone, so a
//   class or an `<img src="asset-…">` used only further down an over-128 KB
//   index.html came back as cssClassUsage "Class … is defined … but never
//   used … Remove the unused selector" and assetUsage "Asset … is never
//   referenced … Remove it from the bundle" — advice that, followed, deletes
//   something the template really uses — along with a cut-off i18n file's
//   JSON parse error, an HTML file's unclosed-element/comment finding and a
//   style.css's CSS parse error. A text file is only ever judged as a whole
//   now, so every finding on it is about the real file.
// - Images (assets here, the icon in lib/validation-input.js) over their cap
//   still have only their first `maxBytes` bytes read (readFilePrefix below),
//   never the whole thing: validate() only inspects an image's header (its
//   magic bytes, the SVG sniff, the pixel dimensions), and see
//   toValidationFileEntry for how such a `truncated` entry is padded back out
//   for validate(), which insists on `size === buffer.byteLength` — and for
//   the one false finding that padding can cause, which
//   lib/validation-input.js's withoutTruncationArtifacts removes.
// - A text file over MAX_VALIDATION_BYTES is the one text case that is still
//   read only up to its cap (so loadBundle never reads more than 4 MB of any
//   file, and only a prefix of anything bigger): toValidationBundle refuses
//   it, see there.
//
// What the preview renders follows from that. The server itself INLINES
// index.html and the i18n files into the wrapped document (wrapTemplate), so
// those two show whatever loadBundle read: the whole file up to 4 MB — an
// over-cap index.html renders in full, an over-cap i18n file parses and its
// translations apply — and past 4 MB only the first cap bytes (an i18n file
// cut off like that is invalid JSON, so the wrapped index fails with a 500
// until it shrinks, exactly as it does for any malformed i18n file).
// style.css (a `<link>` in that document) and every asset are fetched by the
// iframe through the bundle static-file route (preview-middleware.js's
// streamFile), which streams the file on disk whole at any size, so an
// over-cap CSS file or asset still renders in full in the preview while
// upload would reject it; the maxFileSize finding is how the author learns of
// that. Deliberately left that way: that route is a plain file server, and
// cutting a stylesheet or image short there would only render a broken
// preview of a file the banner already flags.
const MAX_HTML_BYTES = 128 * KB;
const MAX_CSS_BYTES = 128 * KB;
const MAX_ASSET_BYTES = 256 * KB;
const MAX_I18N_BYTES = 64 * KB;
// The largest single file the local preview hands to validate() at all, in
// either of the two ways above: a text file read whole, or a truncated image
// zero-padded back out to its real size. 4 MB is four times CONTRACT.md's own
// 1 MB whole-bundle cap, so any single file past it is not a borderline case,
// and it bounds what one request can make loadBundle read and validate()
// parse — all of it synchronous on the preview server's single event loop,
// on every /template-validation.json request. Measured on the machine this
// was written on (@vtex/payment-templates-core 1.0.0, Node 24), for one file
// of real content just under 4 MB:
//
// - index.html: roughly 400-530 ms (about 115 ms per MB, linear);
// - style.css: roughly 1.8-2.1 s for 4 MB of ordinary rules — NOT linear
//   (about 150 ms at 1 MB, 460 ms at 2 MB): nearly all of it is css-tree's
//   tokenizer inside the core, nothing this module could trim. A stylesheet
//   that size is 32 times its own 128 KB limit;
// - an i18n file: tens of milliseconds (40 ms for 1.8 MB of JSON).
//
// The bound is per file, not per bundle, and that is a known, accepted gap:
// several oversized text files just under it each add their own share (an
// HTML, a CSS and two i18n files all near 4 MB came to about 2.3 s per
// validation request, with nothing else served meanwhile). Accepted rather
// than capped at the bundle level because it only ever happens on the
// author's own machine, to the author's own preview server, for a bundle that
// is already failing maxFileSize many times over — and every one of those
// files is reported.
//
// A file past THIS bound fails toValidationBundle with its own clear message
// instead (reported as a single `load` finding by the preview's validation
// route and by scripts/validate-reference.js — the rest of the bundle's
// findings wait until it shrinks; an icon past it gets its own `icon` finding
// instead and does not hide the rest, see lib/validation-input.js's
// readIconEntry) — loadBundle itself, and with it the preview and the locale
// switcher, is unaffected either way.
const MAX_VALIDATION_BYTES = 4 * 1024 * KB;

// Marks a validate() FileEntry built from a `truncated` image entry (see
// toValidationFileEntry) with how many of its bytes were actually read — the
// rest is padding. A registry symbol (Symbol.for), not a module-local one or a
// WeakMap: preview-middleware.js drops this module from require.cache on
// nearly every request (invalidateWrapCache), so the module instance that
// padded an entry need not be the one lib/validation-input.js later asks —
// Symbol.for returns the same symbol from every instance. Defined as a
// non-enumerable property, so it is invisible to validate() (whose FileEntry
// contract is `{ name, size, buffer }`), to JSON.stringify and to
// assert.deepStrictEqual. See lib/validation-input.js's
// withoutTruncationArtifacts for its one consumer.
const TRUNCATED_PREFIX_LENGTH = Symbol.for('payment-mocker.truncatedPrefixLength');

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
 * character; used only for the preview text of a text file past
 * MAX_VALIDATION_BYTES (the one text file still read only up to its cap, see
 * readFileEntry), so the wrapped document doesn't end on a U+FFFD. Only looks
 * back over the last (at most 3) bytes; anything malformed earlier in the
 * prefix is the file's own problem.
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

/**
 * Reads one bundle file into a loaded entry. `size` is the stat'd size,
 * `maxBytes` the file's CONTRACT.md cap and `isText` whether it is one of the
 * text roles (index.html, style.css, i18n) rather than an image — see the
 * comment above MAX_HTML_BYTES for why the two are read differently:
 *
 * - read whole when `size` is within `maxBytes`, and, for a text file, also
 *   when it is over its cap but within MAX_VALIDATION_BYTES;
 * - otherwise (an image over its cap, or a text file over 4 MB) read only up
 *   to `maxBytes` and marked `truncated`.
 */
function readFileEntry(dir, name, size, maxBytes, isText) {
  const filePath = path.join(dir, name);
  if (size <= maxBytes || (isText && size <= MAX_VALIDATION_BYTES)) {
    // A file that grew between the stat and this read is read as it now is,
    // and `size` follows what was actually read — the same race an in-cap
    // file always had. Only a file deliberately rewritten mid-request could
    // hit it, and the next request reads it again anyway.
    const buffer = fs.readFileSync(filePath);
    return {
      name,
      size: buffer.byteLength,
      buffer: new Uint8Array(buffer),
      text: buffer.toString('utf8'),
    };
  }
  // Truncated. `size` is the real, stat'd size (what validate() must report),
  // while `buffer`/`text` hold only the prefix actually read — so on a
  // `truncated` entry, and only there, `size !== buffer.byteLength`. `text`
  // only matters for the one text case that gets here, a file past
  // MAX_VALIDATION_BYTES: it is decoded from the prefix trimmed back to a
  // complete UTF-8 sequence, so the wrapped preview renders the file's first
  // `maxBytes` bytes cleanly rather than ending on a U+FFFD. (An i18n file
  // that big is still, necessarily, cut-off JSON: wrapTemplate JSON.parses it
  // and the wrapped index fails the same way it already does for any
  // malformed i18n file — the locale switcher is unaffected, and
  // /template-validation.json reports the file's size as a `load` finding.)
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
function readRequiredFileEntry(dir, name, maxBytes, isText) {
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
  return readFileEntry(dir, name, stat.size, maxBytes, isText);
}

function loadBundle(bundleDir) {
  const html = readRequiredFileEntry(bundleDir, 'index.html', MAX_HTML_BYTES, true);
  const css = readRequiredFileEntry(bundleDir, 'style.css', MAX_CSS_BYTES, true);
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
      i18n[i18nMatch[1]] = readFileEntry(bundleDir, entry, size, MAX_I18N_BYTES, true);
      continue;
    }
    if (entry.startsWith('asset-')) {
      const size = fs.statSync(path.join(bundleDir, entry)).size;
      assets.push(readFileEntry(bundleDir, entry, size, MAX_ASSET_BYTES, false));
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
 * Turns one loaded file entry into the `{ name, size, buffer }` FileEntry
 * validate() takes. An entry that was read whole — every in-cap file, and
 * every text file up to MAX_VALIDATION_BYTES — passes through as-is, so
 * validate() judges the real file, all of it.
 *
 * A `truncated` entry (see readFileEntry) can't: validate() throws a
 * TypeError unless `size === buffer.byteLength` (its contract makes `size`
 * authoritative for maxFileSize). Two kinds of entry are truncated:
 *
 * - A file past MAX_VALIDATION_BYTES, of any role: refused with its own
 *   clear message (naming the file, its size and the ceiling), checked
 *   first. For a text file this is the only way to be truncated at all.
 * - An image (asset, icon) over its cap but within MAX_VALIDATION_BYTES: the
 *   prefix actually read is copied into a zero-filled buffer of the real
 *   size. Never done for text, where padding is exactly what made validate()
 *   report a class, an asset or a closing tag after the cut as missing (see
 *   the comment above MAX_HTML_BYTES). Most of what validate() checks on an
 *   image is in its first few dozen bytes and so always inside the prefix —
 *   the magic bytes, a 256-byte SVG sniff, a PNG's IHDR (bytes 12-23), a
 *   WebP's VP8/VP8L/VP8X header (the first 30 bytes) — but NOT all of it:
 *   for a JPEG it walks the marker segments from the start of the file to
 *   the first start-of-frame (SOF) marker, and a JPEG carrying large
 *   EXIF/XMP/ICC segments can put that SOF past the cap. The walk then runs
 *   into the zero padding, finds no frame header, and validate() reports
 *   "Could not read the pixel dimensions of <name> from its JPEG header" — a
 *   finding the real file doesn't deserve (the real icon may be a perfectly
 *   valid 160x160), which also takes the place of the real
 *   bounding-box/min-side checks. lib/validation-input.js's
 *   withoutTruncationArtifacts drops exactly that finding, and only after
 *   re-walking the bytes actually read to confirm the walk really did leave
 *   them; see there. Every other image finding on a truncated entry (not a
 *   raster type, an SVG) is decided inside the prefix and is kept.
 *
 * A padded entry carries its prefix length under TRUNCATED_PREFIX_LENGTH (see
 * that constant) for that check. `isText` says which kind of role `file` is;
 * `roleLabel` only appears in the error for an entry past
 * MAX_VALIDATION_BYTES.
 */
function toValidationFileEntry(file, isText, roleLabel) {
  if (!file.truncated) {
    return { name: file.name, size: file.size, buffer: file.buffer };
  }
  if (file.size > MAX_VALIDATION_BYTES) {
    throw new Error(
      `${file.name} is ${file.size} bytes, far over the size limit for each ${roleLabel} and over the ${MAX_VALIDATION_BYTES}-byte ceiling up to which the local preview can hand an oversized file to the validator at all — shrink or remove it to see the rest of the bundle's findings.`
    );
  }
  if (isText) {
    // readFileEntry reads every text file within MAX_VALIDATION_BYTES whole,
    // so this is a caller handing in an entry loadBundle never produces —
    // refused rather than padded back into the false findings above.
    throw new Error(`${file.name} was only partly read; a text file must reach the validator whole.`);
  }
  const padded = new Uint8Array(file.size);
  padded.set(file.buffer);
  const entry = { name: file.name, size: file.size, buffer: padded };
  Object.defineProperty(entry, TRUNCATED_PREFIX_LENGTH, { value: file.buffer.byteLength, enumerable: false });
  return entry;
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
  MAX_VALIDATION_BYTES,
  TRUNCATED_PREFIX_LENGTH,
  isAllowedBundleFilename,
  loadBundle,
  loadBundleForValidation,
  readFilePrefix,
  toValidationBundle,
  toValidationFileEntry,
};
