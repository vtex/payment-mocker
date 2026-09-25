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

module.exports = { isPathContained };
