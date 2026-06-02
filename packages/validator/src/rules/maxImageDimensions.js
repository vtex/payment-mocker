const DEFAULT_MAX = 2000;

function readPngDimensions(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function maxImageDimensions(template, opts = {}) {
  const max = (opts && opts.maxImageDimension) || DEFAULT_MAX;
  const errors = [];

  for (const asset of (template.assets || [])) {
    if (!asset.path.toLowerCase().endsWith('.png')) continue;
    let buf;
    try {
      buf = require('fs').readFileSync(asset.path);
    } catch {
      continue;
    }
    const dims = readPngDimensions(buf);
    if (!dims) continue;
    const { width, height } = dims;
    if (width > max || height > max) {
      errors.push({
        rule: 'maxImageDimensions',
        message: `${require('path').basename(asset.path)}: ${width}×${height}px excede o máximo de ${max}px`,
        file: asset.path,
      });
    }
  }
  return errors;
}

maxImageDimensions.ruleName = 'maxImageDimensions';
maxImageDimensions.describe = function(template) {
  const pngs = (template.assets || []).filter(a => a.path.toLowerCase().endsWith('.png')).length;
  return `${pngs} imagem(ns) PNG`;
};
module.exports = maxImageDimensions;
