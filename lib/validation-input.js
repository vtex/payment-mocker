'use strict';

const fs = require('fs');
const path = require('path');
const { TEMPLATE_ROOT } = require('./preview-config');
const { isPathContained } = require('./path-contained');

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

  return resolvedTarget;
}

/**
 * Assembles the `@vtex/payment-templates-validator` input (template + the
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
