'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isPathContained } = require('../lib/path-contained');

test('isPathContained accepts a target nested inside root', () => {
  const root = path.resolve('/tmp/bundle-root');
  const target = path.join(root, 'sub', 'file.png');
  assert.equal(isPathContained(root, target), true);
});

test('isPathContained accepts the root itself', () => {
  const root = path.resolve('/tmp/bundle-root');
  assert.equal(isPathContained(root, root), true);
});

test('isPathContained rejects a sibling path with a shared prefix', () => {
  const root = path.resolve('/tmp/bundle-root');
  const target = path.resolve('/tmp/bundle-root-evil/file.png');
  assert.equal(isPathContained(root, target), false);
});

test('isPathContained rejects a path outside root entirely', () => {
  const root = path.resolve('/tmp/bundle-root');
  const target = path.resolve('/etc/passwd');
  assert.equal(isPathContained(root, target), false);
});
