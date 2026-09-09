'use strict';

const fs = require('fs');
const path = require('path');
const { isPathContained } = require('./path-contained');
const { isValidLocaleTag } = require('./locale-tag');

// The real, git-tracked template/ directory. Tests that need to point at a
// disposable temp directory instead (so they never mutate this real one) pass
// their own `templateRoot` explicitly into readPreviewConfig() below, rather
// than overriding this constant — see test/preview-middleware.test.js,
// test/preview-config.test.js and test/validation-input.test.js.
const TEMPLATE_ROOT = path.join(__dirname, '..', 'template');
const CONFIG_PATH = path.join(TEMPLATE_ROOT, 'preview.config.json');

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
  return isPathContained(resolvedRoot, resolvedTarget);
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
  readPreviewConfig,
};
