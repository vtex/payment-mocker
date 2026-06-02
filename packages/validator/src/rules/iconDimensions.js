const DEFAULT_MIN = 40;
const DEFAULT_MAX = 200;

function readPngDimensions(buffer) {
  if (buffer.length < 24) return null;
  // Check PNG signature
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function iconDimensions(template, opts = {}) {
  if (!template.icon) return [];

  const min = (opts && opts.iconMinDimension) || DEFAULT_MIN;
  const max = (opts && opts.iconMaxDimension) || DEFAULT_MAX;

  const dims = readPngDimensions(template.icon.buffer);
  if (!dims) return [];

  const { width, height } = dims;
  const largest = Math.max(width, height);
  const smallest = Math.min(width, height);

  if (largest > max) {
    return [{
      rule: 'iconDimensions',
      message: `Ícone ${width}×${height}px excede o máximo permitido de ${max}px — estoura o layout do checkout`,
      file: template.icon.path,
    }];
  }
  if (smallest < min) {
    return [{
      rule: 'iconDimensions',
      message: `Ícone ${width}×${height}px abaixo do mínimo de ${min}px — muito pequeno para exibição`,
      file: template.icon.path,
    }];
  }
  return [];
}

iconDimensions.ruleName = 'iconDimensions';
iconDimensions.describe = function(template) {
  if (!template.icon) return 'sem ícone';
  const dims = readPngDimensions(template.icon.buffer);
  return dims ? `${dims.width}×${dims.height}px` : 'PNG ilegível';
};
module.exports = iconDimensions;
