const fs = require('fs');
const path = require('path');

const IGNORED_NAMES = new Set(['.DS_Store', '.git', 'node_modules']);

const DEFAULT_IGNORED_PATHS = new Set([
  'index.html',
  'checkout-style.css',
  'assets/libs',
  'assets/css/sass',
  'assets/css/less/style.less',
]);

function isIgnoredPath(absolutePath, rootDir, ignoredPaths) {
  const rel = path.relative(rootDir, absolutePath);
  if (ignoredPaths.has(rel)) return true;
  for (const ignored of ignoredPaths) {
    if (rel === ignored || rel.startsWith(ignored + path.sep)) return true;
  }
  return false;
}

function walkFiles(dir, rootDir = dir, ignoredPaths = DEFAULT_IGNORED_PATHS) {
  const out = [];
  const visit = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (isIgnoredPath(full, rootDir, ignoredPaths)) continue;
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        out.push({ path: full, size: stat.size });
      }
    }
  };
  visit(dir);
  return out;
}

module.exports = { walkFiles, DEFAULT_IGNORED_PATHS, IGNORED_NAMES };
