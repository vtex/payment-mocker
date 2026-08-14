'use strict';

/**
 * Writes minimal valid PNG files (real magic bytes and IHDR dimensions).
 * Used to generate raster assets for the reference template.
 */

const fs = require('fs');
const path = require('path');

function writeUint32BE(target, offset, value) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function pngBytes(width, height, totalSize) {
  const header = 33;
  const size = totalSize === undefined ? header : Math.max(totalSize, header);
  const bytes = Buffer.alloc(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  writeUint32BE(bytes, 8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  writeUint32BE(bytes, 16, width);
  writeUint32BE(bytes, 20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function writePng(filePath, width, height) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, pngBytes(width, height));
}

const root = path.join(__dirname, '..', 'template', 'reference');

writePng(path.join(root, 'asset-logo.png'), 120, 60);
writePng(path.join(root, 'asset-badge.png'), 80, 80);

console.log('PNG assets written to template/reference/');
