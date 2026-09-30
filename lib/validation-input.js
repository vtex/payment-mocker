'use strict';

const fs = require('fs');
const path = require('path');
const { TEMPLATE_ROOT, isAllowedIconFilename } = require('./preview-config');
const { isPathContained } = require('./path-contained');
const { readFilePrefix, toValidationFileEntry } = require('./load-bundle');

// Mirrors template/CONTRACT.md's icon size limit — see lib/load-bundle.js's
// own copy of this reasoning for why it's a local constant rather than one
// imported from @vtex/payment-templates-core. Like load-bundle.js's caps, it
// is a read cap, not a rejection: see buildValidationInput below.
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
 * finding): like an oversized bundle file in lib/load-bundle.js, only its
 * first MAX_ICON_BYTES bytes are read — never the whole file — and the entry
 * keeps the real, stat'd size, so validate()'s own maxFileSize rule reports
 * it (and counts it towards the whole-bundle total). toValidationFileEntry
 * zero-pads that prefix back out to the real size, which validate() requires;
 * see its docblock.
 *
 * Returns `{ entry }` or `{ finding }`: an icon that can't be read at all
 * (EACCES, ...) or is past toValidationFileEntry's padding ceiling is still
 * an icon problem, reported as one rather than failing the run.
 */
function readIconEntry(icon, resolvedPath, size) {
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
 * Shared by scripts/validate-reference.js and lib/preview-middleware.js so
 * both validate the exact same shape — previously the preview route only sent
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

module.exports = { buildValidationInput, withExtraFindings };
