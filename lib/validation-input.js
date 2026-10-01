'use strict';

const fs = require('fs');
const path = require('path');
const { TEMPLATE_ROOT, isAllowedIconFilename } = require('./preview-config');
const { isPathContained } = require('./path-contained');
const {
  MAX_VALIDATION_BYTES,
  TRUNCATED_PREFIX_LENGTH,
  readFilePrefix,
  toValidationFileEntry,
} = require('./load-bundle');

// Mirrors template/CONTRACT.md's icon size limit — see lib/load-bundle.js's
// own copy of this reasoning for why it's a local constant rather than one
// imported from @vtex/payment-templates-core. Like load-bundle.js's caps for
// images (the icon is one), it is a read cap, not a rejection: see
// readIconEntry below. Unlike text files, which load-bundle.js reads whole up
// to its 4 MB MAX_VALIDATION_BYTES, an image over its cap is only ever read
// up to it — validate() only looks at an image's header.
const MAX_ICON_BYTES = 50 * 1024;

// The rule name our own icon findings carry. Not one of validate()'s rule
// names: these are problems that stop the icon from being handed to
// validate() at all (see resolveIconPath), so no validator rule ever sees it.
const ICON_RULE = 'icon';

/**
 * Same shape as a validate() finding — `{ rule, severity, message }`, the
 * fields src/assets/libs/template-host.js's banner and
 * scripts/validate-reference.js both print. No `ref`: every message below
 * already names `config.icon` itself, and the banner/CLI would only print it
 * a second time in parentheses.
 */
function iconFinding(message) {
  return { rule: ICON_RULE, severity: 'error', message };
}

/**
 * Resolves `config.icon` against `templateRoot` (defaulting to the real,
 * git-tracked template/ directory) — not bundlePath. Per CONTRACT.md the icon
 * is "stored separately from the versioned bundle", so it lives alongside
 * (not inside) the bundle directory. The same realpathSync + isPathContained
 * containment check used for bundle files applies here too, so a `../../`
 * icon path can't read a file outside template/.
 *
 * Returns `{ resolvedPath, size }` for an icon that can be read, or
 * `{ finding }` for one that can't. Every problem with the icon ITSELF is a
 * finding, never a throw: a throw here used to surface as the single `load`
 * finding that replaced validate()'s whole list, so one misnamed icon hid
 * every other problem in the bundle. Specifically:
 *
 * - not found (or any other realpath failure on the icon path): a finding —
 *   an author's typo in preview.config.json, nothing wrong with the bundle;
 * - escaping template/ (`../secret.png`, or a symlink out): a finding too,
 *   still clearly worded. The security property is that the file outside
 *   template/ is never read, and returning here — before the stat and the
 *   read below — keeps that exactly as before; failing the whole run on top
 *   of that protected nothing further;
 * - a name outside CONTRACT.md's rule (subfolder, non-image extension): a
 *   finding;
 * - not a regular file (a directory, a FIFO — which would hang the read): a
 *   finding, and never read.
 *
 * The one hard failure left is `templateRoot` itself not resolving: that is
 * the preview's own setup being broken, not a problem with the icon, and
 * there is no bundle to report findings on either.
 *
 * Oversize is NOT one of these: see buildValidationInput.
 */
function resolveIconPath(icon, templateRoot) {
  const root = templateRoot || TEMPLATE_ROOT;
  const resolvedRoot = fs.realpathSync(root);
  let resolvedTarget;
  try {
    resolvedTarget = fs.realpathSync(path.join(root, icon));
  } catch (error) {
    return { finding: iconFinding('preview.config.json icon file not found: ' + icon) };
  }

  if (!isPathContained(resolvedRoot, resolvedTarget)) {
    return { finding: iconFinding('preview.config.json icon must stay inside template/: ' + icon) };
  }

  // The same name check the icon route applies (see isAllowedIconFilename in
  // lib/preview-config.js): without it, an icon in a subfolder or with a
  // non-image extension passed validation and the banner while the preview
  // itself 404'd on it. Checked after containment, not first, so a `../`
  // path keeps getting the more specific "stay inside template/" message —
  // the same precedence the route gives its 403 — but still before the stat
  // and read below ever touch the file itself.
  if (!isAllowedIconFilename(icon)) {
    return {
      finding: iconFinding(
        'preview.config.json icon must be a .png, .jpg, .jpeg or .webp file placed directly under template/: ' + icon
      ),
    };
  }

  // statSync, not lstatSync: resolvedTarget is already realpath'd above, so
  // there's no symlink component left to distinguish — but it can still name
  // something that was never a regular file at all. A FIFO/named pipe in
  // particular would make the read in buildValidationInput below hang
  // indefinitely waiting for a writer that will never arrive, since nothing
  // upstream of this ever checked the icon is an ordinary file before
  // reading it.
  let stat;
  try {
    stat = fs.statSync(resolvedTarget);
  } catch (error) {
    // Vanished (or became inaccessible) between the realpathSync above and
    // here — the same "not found" the realpath failure reports.
    return { finding: iconFinding('preview.config.json icon file not found: ' + icon) };
  }
  if (!stat.isFile()) {
    return { finding: iconFinding('preview.config.json icon must be a regular file: ' + icon) };
  }

  return { resolvedPath: resolvedTarget, size: stat.size };
}

/**
 * Reads the resolved icon into a validate() FileEntry. An icon over
 * MAX_ICON_BYTES is not rejected here (it used to throw, hiding every other
 * finding): like an oversized asset in lib/load-bundle.js, only its
 * first MAX_ICON_BYTES bytes are read — never the whole file — and the entry
 * keeps the real, stat'd size, so validate()'s own maxFileSize rule reports
 * it (and counts it towards the whole-bundle total). toValidationFileEntry
 * zero-pads that prefix back out to the real size, which validate() requires;
 * see its docblock — including why a JPEG icon whose frame header lies past
 * the cap would get a false "could not read the pixel dimensions" finding,
 * which withoutTruncationArtifacts below removes again.
 *
 * Returns `{ entry }` or `{ finding }`: an icon that can't be read at all
 * (EACCES, ...) or is past toValidationFileEntry's padding ceiling is still
 * an icon problem, reported as one rather than failing the run.
 *
 * The padding-ceiling case is checked here, before any read, and gets its
 * own wording instead of the generic "could not read" one it used to fall
 * into (toValidationFileEntry's throw, caught below): such an icon is
 * perfectly readable — the icon route serves it to the preview with a 200 —
 * it is just over the size limit by so much that the local validator
 * doesn't inspect it at all, and saying it "could not be read" sent the
 * author looking for a permissions problem that isn't there.
 */
function readIconEntry(icon, resolvedPath, size) {
  if (size > MAX_VALIDATION_BYTES) {
    return {
      finding: iconFinding(
        'preview.config.json icon ' +
          icon +
          ' is ' +
          size +
          ' bytes, over the ' +
          MAX_ICON_BYTES +
          '-byte size limit for the icon and too large for the local validator to inspect (it only checks icons up to ' +
          MAX_VALIDATION_BYTES +
          ' bytes) — shrink it under the limit to see its type and dimension findings.'
      ),
    };
  }
  try {
    if (size <= MAX_ICON_BYTES) {
      const buffer = fs.readFileSync(resolvedPath);
      return { entry: { name: icon, size: buffer.byteLength, buffer: new Uint8Array(buffer) } };
    }
    const prefix = readFilePrefix(resolvedPath, MAX_ICON_BYTES);
    const truncated = { name: icon, size, buffer: new Uint8Array(prefix), truncated: true };
    return { entry: toValidationFileEntry(truncated, false, 'icon') };
  } catch (error) {
    const reason = error && error.code ? error.code : error && error.message ? error.message : String(error);
    return { finding: iconFinding('preview.config.json icon could not be read: ' + icon + ' (' + reason + ')') };
  }
}

/**
 * Assembles the `@vtex/payment-templates-core` input (template + the
 * optional icon read from disk + the optional displayName) from a preview
 * config and an already-loaded validation-shaped template. `templateRoot` is
 * optional and defaults to the real template/ directory; callers that need to
 * point at a disposable temp directory (tests) pass it explicitly.
 *
 * Returns `{ input, findings }`: `input` is what to hand validate(), and
 * `findings` is this module's own icon findings (see resolveIconPath and
 * readIconEntry) — empty unless the icon couldn't be handed to validate() at
 * all, in which case it is left out of `input` so the rest of the bundle is
 * still validated in full. Merge the two with withExtraFindings below.
 *
 * Called from lib/preview-middleware.js's runTemplateValidation, the one
 * pipeline both the preview's validation route and
 * scripts/validate-reference.js run, so both validate the exact same shape —
 * previously the preview route only sent
 * `{ template }`, so it would approve bundles with invalid icon/displayName
 * that `npm run validate:reference` would reject.
 */
function buildValidationInput(config, template, templateRoot) {
  const input = { template };
  const findings = [];

  if (config.icon) {
    const resolved = resolveIconPath(config.icon, templateRoot);
    const read = resolved.finding ? resolved : readIconEntry(config.icon, resolved.resolvedPath, resolved.size);
    if (read.finding) {
      findings.push(read.finding);
    } else {
      input.icon = read.entry;
    }
  }

  if (config.displayName) {
    input.displayName = config.displayName;
  }

  return { input, findings };
}

/**
 * Folds buildValidationInput's own `findings` into a validate() result,
 * keeping validate()'s `{ ok, errors }` shape and its meaning of `ok` (no
 * finding with severity 'error'). Appended at the end, after every one of
 * validate()'s own findings, so validate()'s own stable ordering is left
 * untouched.
 */
function withExtraFindings(result, extraFindings) {
  if (!extraFindings || extraFindings.length === 0) return result;
  const errors = (result.errors || []).concat(extraFindings);
  return {
    ok: !!result.ok && !extraFindings.some((finding) => finding.severity === 'error'),
    errors,
  };
}

function isJpegSofMarker(marker) {
  if (marker < 0xc0 || marker > 0xcf) return false;
  // 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC) are not frame headers.
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * True when reading a JPEG's pixel dimensions from `prefix` — the bytes of a
 * truncated file that were actually read — needs bytes PAST the prefix, i.e.
 * the answer depends on the unread part of the file. False when the prefix
 * alone already settles it (a frame header read in full, or a marker walk
 * that stops for good inside the prefix: an EOI/SOS before any SOF, a
 * segment length under 2).
 *
 * Mirrors, step for step, readJpegSize in @vtex/payment-templates-core
 * 1.0.0's dist/internal/bytes.js (not importable: the package's `exports`
 * map only exposes its public entry points) — except that where the core
 * would read on into what, for a truncated entry, is zero padding, this
 * reports "ran past the prefix" instead. Over zero padding the core's walk
 * always ends in `null` (a zero byte is never a marker, and a zero segment
 * length stops it), which is exactly the false finding this is used to
 * identify.
 */
function jpegDimensionsNeedUnreadBytes(prefix) {
  const length = prefix.byteLength;
  let offset = 2; // skip SOI
  while (offset + 1 < length) {
    if (prefix[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = prefix[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    // EOI / start of scan with no SOF before it: the file's own problem.
    if (marker === 0xd9 || marker === 0xda) return false;
    if (offset + 3 >= length) return true; // segment length cut off
    const segmentLength = (prefix[offset + 2] << 8) | prefix[offset + 3];
    if (segmentLength < 2) return false;
    if (!isJpegSofMarker(marker)) {
      offset += 2 + segmentLength;
      continue;
    }
    // A SOF: the core reads height/width at offset+5..offset+8.
    return offset + 8 >= length;
  }
  return true; // walked off the end of the prefix without a verdict
}

// Where each non-JPEG header the core reads the dimensions from ends — see
// readPngSize/readWebpSize in the same core file. Both far inside any cap,
// so in practice a truncated PNG/WebP never qualifies; kept so the check
// below asks the same question of every type instead of assuming.
const HEADER_BYTES = { PNG: 24, WEBP: 30 };

function dimensionsNeedUnreadBytes(prefix, type) {
  if (type === 'JPEG') return jpegDimensionsNeedUnreadBytes(prefix);
  return prefix.byteLength < HEADER_BYTES[type];
}

// validate()'s own message for an image whose header it can't decode —
// imageSafety's `Could not read the pixel dimensions of ${file} from its
// ${type.toUpperCase()} header.` in core 1.0.0, matched whole so a reworded
// message in a later core version simply stops matching (and the finding is
// kept) rather than something else being dropped by mistake.
const UNREADABLE_DIMENSIONS_PATTERN = /^Could not read the pixel dimensions of ([\s\S]+) from its (PNG|JPEG|WEBP) header\.$/;

/**
 * Removes from a validate() result the one finding that exists only because
 * a truncated image was zero-padded (see toValidationFileEntry's docblock in
 * lib/load-bundle.js): imageSafety's "Could not read the pixel dimensions of
 * <name> from its JPEG header" for an image whose frame header lies past the
 * read cap. That file's maxFileSize finding is still there and already tells
 * the author what to do; the dropped one was false (the real file may well
 * have a readable 160x160 header) and would outlive a fix to everything else
 * it claims.
 *
 * A finding is dropped only if ALL of these hold, so nothing real can go
 * with it:
 * - it is exactly that finding: rule `imageSafety`, the message matched whole
 *   (UNREADABLE_DIMENSIONS_PATTERN), and its `ref.file` naming the entry;
 * - that entry was truncated (it carries TRUNCATED_PREFIX_LENGTH) — an
 *   in-cap image was read whole, so the same finding on one is real;
 * - re-walking the bytes actually read (dimensionsNeedUnreadBytes) confirms
 *   the header parse really did run past them. A JPEG whose own prefix
 *   already ends the walk (an SOS/EOI before any SOF, a bad segment length)
 *   keeps its finding: that is a real defect, cut-off or not;
 * - no other image entry in the input has the same name (an icon and an
 *   asset can: `template/asset-x.png` and `template/reference/asset-x.png`),
 *   since `ref.file` alone could not tell whose finding it is.
 *
 * Every other imageSafety finding on a truncated entry — "is not a PNG, JPEG
 * or WebP image", "is an SVG" — is decided from its first bytes, always
 * inside the prefix, and is never touched. Checked for every truncated image
 * entry (icon and assets alike), although core 1.0.0 only reads the icon's
 * pixel geometry: the same rule for every image means an asset-geometry check
 * in a later core version gets the same treatment rather than the same bug.
 *
 * Known residual, not handled: a SOF whose 7-byte frame header straddles the
 * cut exactly would be read by the core half from the file and half from the
 * padding — either a "could not read" finding (dropped here, correctly) or,
 * if the half that was read is non-zero, bogus dimensions reported as a
 * bounding-box/min-side finding, which is left alone. Hitting that needs the
 * frame header to land on one specific handful of byte offsets, beside a
 * maxFileSize finding that already says to shrink the file.
 *
 * `ok` is recomputed the way validate() defines it (no finding with severity
 * 'error'); for a truncated entry the maxFileSize error keeps it false anyway.
 */
function withoutTruncationArtifacts(result, input) {
  const images = [];
  if (input && input.icon) images.push(input.icon);
  if (input && input.template && Array.isArray(input.template.assets)) {
    for (const asset of input.template.assets) images.push(asset);
  }
  const truncatedByName = new Map();
  const nameCounts = new Map();
  for (const entry of images) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) || 0) + 1);
    if (typeof entry[TRUNCATED_PREFIX_LENGTH] === 'number') truncatedByName.set(entry.name, entry);
  }
  if (truncatedByName.size === 0 || !result || !Array.isArray(result.errors)) return result;

  const errors = result.errors.filter(function (finding) {
    if (!finding || finding.rule !== 'imageSafety' || !finding.ref) return true;
    const entry = truncatedByName.get(finding.ref.file);
    if (!entry || nameCounts.get(entry.name) !== 1) return true;
    const match = UNREADABLE_DIMENSIONS_PATTERN.exec(String(finding.message));
    if (!match || match[1] !== entry.name) return true;
    const prefix = entry.buffer.subarray(0, entry[TRUNCATED_PREFIX_LENGTH]);
    return !dimensionsNeedUnreadBytes(prefix, match[2]);
  });
  if (errors.length === result.errors.length) return result;
  return { ok: !errors.some((finding) => finding.severity === 'error'), errors };
}

/**
 * The one way lib/preview-middleware.js's runTemplateValidation — run by both
 * the /template-validation.json route and scripts/validate-reference.js —
 * turns validate()'s raw result into what they report: first drop the truncation
 * artifact above (it needs `input`, the exact object handed to validate(),
 * to know which entries were truncated), then append buildValidationInput's
 * own `extraFindings` with withExtraFindings. Sharing it is what keeps the
 * banner and `npm run validate:reference` from ever disagreeing on the same
 * bundle.
 */
function finishValidationResult(result, input, extraFindings) {
  return withExtraFindings(withoutTruncationArtifacts(result, input), extraFindings);
}

module.exports = {
  buildValidationInput,
  finishValidationResult,
  jpegDimensionsNeedUnreadBytes,
  withExtraFindings,
  withoutTruncationArtifacts,
};
