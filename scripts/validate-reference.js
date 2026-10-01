'use strict';

const { readPreviewConfig } = require('../lib/preview-config');
const { loadFailureResult, runTemplateValidation } = require('../lib/preview-middleware');

function printFinding(print, finding) {
  const ref = finding.ref ? ' (' + finding.ref.file + ')' : '';
  print('  [' + finding.rule + '] ' + finding.message + ref);
}

function printFailure(result) {
  console.error('validate: failed');
  for (const finding of result.errors) printFinding(console.error, finding);
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

  if (result.ok) {
    console.log('validate: ok — template at template/' + config.bundleDir + ' passed all applicable rules.');
    const warnings = (result.errors || []).filter((finding) => finding.severity === 'warning');
    for (const finding of warnings) printFinding(console.warn, finding);
    process.exit(0);
  }

  printFailure(result);
  process.exit(1);
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
    console.error('  [load] Validation could not run.');
  }
  process.exit(1);
});
