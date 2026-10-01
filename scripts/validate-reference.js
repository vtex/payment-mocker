'use strict';

const { readPreviewConfig } = require('../lib/preview-config');
const { loadFailureResult, runTemplateValidation } = require('../lib/preview-middleware');
const { printValidationResult } = require('../lib/format-validation-output');

const json = process.argv.indexOf('--json') !== -1;

function printFailure(result) {
  printValidationResult(result, { json: json });
}

async function main() {
  let config;
  try {
    config = readPreviewConfig();
  } catch (error) {
    // The same `[load]` finding the preview's validation route reports for a
    // preview.config.json it can't read, not a raw exception.
    printFailure(loadFailureResult(error));
    process.exit(1);
  }
  // runTemplateValidation is the exact pipeline the preview's
  // /template-validation.json route runs (lib/preview-middleware.js): it
  // loads the bundle, merges in the configured icon's own findings (see
  // lib/validation-input.js's buildValidationInput), drops the false "could
  // not read the pixel dimensions" finding a truncated JPEG would otherwise
  // get (withoutTruncationArtifacts), and turns a bundle that can't be
  // validated at all — one file past the 4 MB ceiling, a file outside the
  // contract — into a single sanitized `load` finding instead of rejecting.
  // So this run and the banner always agree, including on that last case,
  // which this script used to print as a raw exception and stack trace.
  const result = await runTemplateValidation(config);

  // printValidationResult (lib/format-validation-output.js) owns the output
  // shape: an error/warning count, `file:line:column` where a finding's own
  // `ref` carries one, and — with `--json` — the raw `{ ok, errors }` result
  // for CI instead of the human-readable text.
  printValidationResult(result, {
    json: json,
    suffix: ' — template at template/' + config.bundleDir,
  });

  process.exit(result.ok ? 0 : 1);
}

main().catch(function (error) {
  // Only reached for something runTemplateValidation itself doesn't expect
  // (it resolves every load/validate failure as a finding). Still reported
  // as a finding, without the stack; the fixed fallback covers the
  // sanitizer itself throwing.
  try {
    printFailure(loadFailureResult(error));
  } catch (secondError) {
    console.error('validate: failed');
    console.error('  [error] load — Validation could not run.');
  }
  process.exit(1);
});
