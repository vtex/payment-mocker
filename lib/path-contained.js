'use strict';

const path = require('path');

/**
 * Pure containment check: is `target` equal to `root`, or nested inside it?
 *
 * Both arguments must already be fully resolved (e.g. via `fs.realpathSync`)
 * by the caller — this function does no filesystem I/O itself, which keeps it
 * cheap to unit test.
 */
function isPathContained(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Normalizes the path portion of a `/template-bundle/...` request URL for the
 * "is this the index?" check. `path.normalize` alone leaves edge cases like
 * `/template-bundle//index.html` (normalizes to the absolute `/index.html`)
 * and `/template-bundle/index.html/` (trailing slash preserved) unmatched
 * against the plain `'index.html'` comparison, so both used to fall through
 * to the static-file branch and serve the raw, unwrapped index.html.
 *
 * Lives here, not in lib/preview-middleware.js, because the icon route's
 * `normalizedIcon` is derived with it too, and lib/preview-config.js's
 * isAllowedIconFilename has to test that exact same string — see there.
 * Pure string manipulation, no filesystem I/O, like isPathContained above.
 */
function normalizeIndexPath(relativePath) {
  return path
    .normalize(relativePath)
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+$/, '');
}

module.exports = { isPathContained, normalizeIndexPath };
