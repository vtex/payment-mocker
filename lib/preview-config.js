'use strict';

const fs = require('fs');
const path = require('path');
const { isPathContained, normalizeIndexPath } = require('./path-contained');
const { isValidLocaleTag, THEME_TOKEN_NAMES } = require('@vtex/payment-templates-core/wrap');

// The real, git-tracked template/ directory. Tests that need to point at a
// disposable temp directory instead (so they never mutate this real one) pass
// their own `templateRoot` explicitly into readPreviewConfig() below, rather
// than overriding this constant — see test/preview-middleware.test.js,
// test/preview-config.test.js and test/validation-input.test.js.
const TEMPLATE_ROOT = path.join(__dirname, '..', 'template');
const CONFIG_PATH = path.join(TEMPLATE_ROOT, 'preview.config.json');

// CONTRACT.md: the icon is "any raster file placed directly under template/"
// — PNG/JPEG/WebP, no subdirectory. Nothing enforced that shape before: an
// `icon` value naming an .html file directly (no symlink needed at all) was
// served as text/html by the icon route, same failure class as an
// extension-less `asset-*` used to let through on the bundle route.
const ICON_FILENAME_PATTERN = /^[^/\\]+\.(?:png|jpe?g|webp)$/i;

/**
 * The single check both the icon route (lib/preview-middleware.js's
 * serveTemplateIcon) and the validation input (lib/validation-input.js's
 * resolveIconPath) apply to `config.icon`. It normalizes with the same
 * normalizeIndexPath the route derives its `normalizedIcon` from, so both
 * test the exact same string — previously only the route checked this at
 * all, so e.g. `img/icon.png` passed validation (and the banner) while the
 * preview itself 404'd on the icon.
 */
function isAllowedIconFilename(icon) {
  return ICON_FILENAME_PATTERN.test(normalizeIndexPath(icon));
}

function configPathFor(templateRoot) {
  return path.join(templateRoot, 'preview.config.json');
}

function realpathOrResolve(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    // Target may not exist yet (e.g. a misconfigured bundleDir); fall back to
    // the resolved-but-unlinked path so callers still get a containment
    // answer instead of a crash.
    return resolved;
  }
}

function isInsideRoot(root, target) {
  // Resolve `root` exactly once, then rebase `target` onto that already-
  // resolved root instead of independently realpath-ing both sides. Doing the
  // two realpaths separately breaks when `root` sits under a symlinked
  // ancestor (e.g. TEMPLATE_ROOT under macOS's /var -> /private/var, via
  // os.tmpdir()) and `target` doesn't exist on disk yet: `target` would then
  // fall back to its unresolved, non-symlink-collapsed form while `root`'s
  // prefix has already been collapsed, so a perfectly valid nested target
  // would no longer share `root`'s resolved prefix and would fail
  // containment for the wrong reason (masking the real, more useful error —
  // e.g. "defaultLocale has no matching i18n file" — behind a generic
  // containment error instead).
  const resolvedRoot = realpathOrResolve(root);
  const relativeFromRoot = path.relative(path.resolve(root), path.resolve(target));
  const resolvedTarget = path.resolve(resolvedRoot, relativeFromRoot);
  if (!isPathContained(resolvedRoot, resolvedTarget)) {
    return false;
  }

  // The rebase above only protects against `root` sitting under a symlinked
  // ancestor — it never follows `target` itself, so a `bundleDir` that is
  // itself a symlink pointing outside `root` would still lexically rebase to
  // somewhere under `resolvedRoot` and pass. Resolving `target`'s own realpath
  // closes that gap. Skipped when `target` doesn't exist yet, for the same
  // reason realpathOrResolve falls back instead of throwing: readPreviewConfig
  // calls this before checking the i18n file, and a merely-not-created-yet
  // bundleDir must still fail with that clearer, more specific error, not a
  // generic containment one.
  try {
    return isPathContained(resolvedRoot, fs.realpathSync(target));
  } catch (error) {
    return true;
  }
}

function readPreviewConfig(templateRoot) {
  const root = templateRoot || TEMPLATE_ROOT;
  const configPath = root === TEMPLATE_ROOT ? CONFIG_PATH : configPathFor(root);
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  if (!config.bundleDir || !config.defaultLocale) {
    throw new Error('preview.config.json requires bundleDir and defaultLocale.');
  }
  if (!isValidLocaleTag(config.defaultLocale)) {
    throw new Error('preview.config.json defaultLocale must match ^[a-z]{2}-[A-Z]{2}$.');
  }
  if (config.icon !== undefined && typeof config.icon !== 'string') {
    throw new Error('preview.config.json icon must be a string.');
  }
  if (config.displayName !== undefined) {
    const isPlainObject =
      typeof config.displayName === 'object' && config.displayName !== null && !Array.isArray(config.displayName);
    const allValuesAreStrings =
      isPlainObject && Object.values(config.displayName).every((value) => typeof value === 'string');
    if (!allValuesAreStrings) {
      throw new Error('preview.config.json displayName must be a record of strings.');
    }
  }

  if (config.themeTokens !== undefined) {
    const isPlainObject =
      typeof config.themeTokens === 'object' && config.themeTokens !== null && !Array.isArray(config.themeTokens);
    if (!isPlainObject) {
      throw new Error('preview.config.json themeTokens must be an object.');
    }
    // The token set is closed, so an unknown key is a typo the partner should
    // hear about now. buildThemeTokenStyle would silently ignore it (the right
    // behavior at runtime, where values come from a merchant's stylesheet), and
    // a silently ignored `--checkout-font-familly` in a config file the partner
    // wrote by hand looks exactly like a broken feature.
    for (const name of Object.keys(config.themeTokens)) {
      if (!THEME_TOKEN_NAMES.includes(name)) {
        throw new Error(
          'preview.config.json themeTokens has unknown token ' +
            name +
            '. Supported: ' +
            THEME_TOKEN_NAMES.join(', ') +
            '.'
        );
      }
      if (typeof config.themeTokens[name] !== 'string') {
        throw new Error('preview.config.json themeTokens values must be strings.');
      }
    }
  }

  const bundlePath = path.resolve(root, config.bundleDir);
  if (!isInsideRoot(root, bundlePath)) {
    throw new Error('preview.config.json bundleDir must stay inside template/.');
  }

  const i18nFile = path.join(bundlePath, 'i18n-' + config.defaultLocale + '.json');
  if (!fs.existsSync(i18nFile)) {
    throw new Error(
      'preview.config.json defaultLocale has no matching i18n-' + config.defaultLocale + '.json.'
    );
  }

  config.bundlePath = bundlePath;
  return config;
}

module.exports = {
  TEMPLATE_ROOT,
  CONFIG_PATH,
  configPathFor,
  isAllowedIconFilename,
  readPreviewConfig,
};
