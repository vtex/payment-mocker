'use strict';

const fs = require('fs');
const path = require('path');
const { TEMPLATE_ROOT, isAllowedIconFilename } = require('./preview-config');
const { isPathContained } = require('./path-contained');

// Mirrors template/CONTRACT.md's icon size limit — see lib/load-bundle.js's
// own copy of this reasoning for why it's a local constant rather than one
// imported from @vtex/payment-templates-core.
const MAX_ICON_BYTES = 50 * 1024;

/**
 * Resolves `config.icon` against `templateRoot` (defaulting to the real,
 * git-tracked template/ directory) — not bundlePath. Per CONTRACT.md the icon
 * is "stored separately from the versioned bundle", so it lives alongside
 * (not inside) the bundle directory. The same realpathSync + isPathContained
 * containment check used for bundle files applies here too, so a `../../`
 * icon path can't read a file outside template/.
 */
function resolveIconPath(icon, templateRoot) {
  const root = templateRoot || TEMPLATE_ROOT;
  const resolvedRoot = fs.realpathSync(root);
  let resolvedTarget;
  try {
    resolvedTarget = fs.realpathSync(path.join(root, icon));
  } catch (error) {
    throw new Error('preview.config.json icon file not found: ' + icon);
  }

  if (!isPathContained(resolvedRoot, resolvedTarget)) {
    throw new Error('preview.config.json icon must stay inside template/.');
  }

  // The same name check the icon route applies (see isAllowedIconFilename in
  // lib/preview-config.js): without it, an icon in a subfolder or with a
  // non-image extension passed validation and the banner while the preview
  // itself 404'd on it. Checked after containment, not first, so a `../`
  // path keeps getting the more specific "stay inside template/" message —
  // the same precedence the route gives its 403 — but still before the stat
  // and read below ever touch the file itself.
  if (!isAllowedIconFilename(icon)) {
    throw new Error(
      'preview.config.json icon must be a .png, .jpg, .jpeg or .webp file placed directly under template/: ' + icon
    );
  }

  // statSync, not lstatSync: resolvedTarget is already realpath'd above, so
  // there's no symlink component left to distinguish — but it can still name
  // something that was never a regular file at all. A FIFO/named pipe in
  // particular would make buildValidationInput's fs.readFileSync below hang
  // indefinitely waiting for a writer that will never arrive, since nothing
  // upstream of this ever checked the icon is an ordinary file before
  // reading it. The size check is the same early-rejection reasoning
  // lib/load-bundle.js's readFileEntry uses: reject via a cheap stat before
  // reading a possibly-large file into memory in full.
  const stat = fs.statSync(resolvedTarget);
  if (!stat.isFile()) {
    throw new Error('preview.config.json icon must be a regular file: ' + icon);
  }
  if (stat.size > MAX_ICON_BYTES) {
    throw new Error(
      `preview.config.json icon "${icon}" is ${stat.size} bytes, over the ${MAX_ICON_BYTES}-byte limit for the icon — see template/CONTRACT.md's size limits.`
    );
  }

  return resolvedTarget;
}

/**
 * Assembles the `@vtex/payment-templates-core` input (template + the
 * optional icon read from disk + the optional displayName) from a preview
 * config and an already-loaded validation-shaped template. `templateRoot` is
 * optional and defaults to the real template/ directory; callers that need to
 * point at a disposable temp directory (tests) pass it explicitly.
 *
 * Shared by scripts/validate-reference.js and lib/preview-middleware.js so
 * both validate the exact same shape — previously the preview route only sent
 * `{ template }`, so it would approve bundles with invalid icon/displayName
 * that `npm run validate:reference` would reject.
 */
function buildValidationInput(config, template, templateRoot) {
  const input = { template };

  if (config.icon) {
    const iconPath = resolveIconPath(config.icon, templateRoot);
    const buffer = fs.readFileSync(iconPath);
    input.icon = {
      name: config.icon,
      size: buffer.byteLength,
      buffer: new Uint8Array(buffer),
    };
  }

  if (config.displayName) {
    input.displayName = config.displayName;
  }

  return input;
}

module.exports = { buildValidationInput };
