'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readPreviewConfig, configPathFor } = require('../lib/preview-config');

/**
 * lib/preview-config.js's isInsideRoot resolves the given templateRoot via
 * fs.realpathSync once and rebases the bundleDir target onto that already-
 * resolved root, instead of realpath-ing both sides independently. Exercising
 * the bug this guards against requires templateRoot to sit behind a symlink
 * *and* the configured bundleDir to point at something that doesn't exist yet
 * (the fallback path in realpathOrResolve). os.tmpdir() itself is such a
 * symlink on macOS (/var -> /private/var), but relying on that isn't portable
 * to every CI environment, so this test builds its own symlink instead.
 */
let container;
let tempReal;
let tempLink;

test.before(() => {
  container = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-mocker-preview-config-'));
  tempReal = path.join(container, 'real-template');
  fs.mkdirSync(tempReal, { recursive: true });
  tempLink = path.join(container, 'template-via-symlink');
  fs.symlinkSync(tempReal, tempLink, 'dir');
});

test.after(() => {
  fs.rmSync(container, { recursive: true, force: true });
});

test('readPreviewConfig: a not-yet-existing bundleDir under a symlinked templateRoot is correctly recognized as contained', () => {
  const configPath = configPathFor(tempLink);
  fs.writeFileSync(configPath, JSON.stringify({ bundleDir: 'missing-bundle', defaultLocale: 'pt-BR' }));

  // Before the fix, this incorrectly threw the generic containment error
  // ("bundleDir must stay inside template/"): the non-existent bundleDir
  // target fell back to an unresolved (still symlink-containing) path while
  // the root had already been realpath'd through the symlink, so their
  // prefixes never matched even though the bundleDir is legitimately inside
  // templateRoot. The fix must let this reach the *real* failure instead —
  // no i18n file matching defaultLocale, since `missing-bundle` doesn't
  // exist on disk at all.
  assert.throws(() => readPreviewConfig(tempLink), /defaultLocale has no matching i18n-pt-BR\.json/);
});

test('readPreviewConfig: a bundleDir that actually escapes a symlinked templateRoot is still rejected', () => {
  const configPath = configPathFor(tempLink);
  fs.writeFileSync(configPath, JSON.stringify({ bundleDir: '../escaped-bundle', defaultLocale: 'pt-BR' }));

  // Confirms the fix didn't just relax containment across the board: a
  // bundleDir that genuinely resolves outside templateRoot (symlinked or
  // not) must still be rejected.
  assert.throws(() => readPreviewConfig(tempLink), /bundleDir must stay inside template\//);
});
