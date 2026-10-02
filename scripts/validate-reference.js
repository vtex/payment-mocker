'use strict';

const { readPreviewConfig } = require('../lib/preview-config');
const { loadFailureResult, runTemplateValidation } = require('../lib/preview-middleware');
const { printUnrunnableResult, printValidationResult } = require('../lib/format-validation-output');

const json = process.argv.indexOf('--json') !== -1;

// A reader that stops early (`-- --json | head`) closes the pipe while a
// result bigger than its buffer (~64 KB) is still being written, and the
// raw process.stdout.write of `--json` then fails: EPIPE on a pipe, or
// ENOTCONN when stdout is the socket a Node parent's spawn() hands its child
// on macOS. Unhandled, that error crashes the process with a stack on stderr
// and exit 1 — even for an `ok` result. A reader that left is not a
// validation failure: ignore it so the exit code set below keeps reporting
// the validation result. Any other write error still surfaces. Only stdout
// needs this: everything this script sends to stderr goes through
// console.error/console.warn, and Node's console already ignores errors on
// the stream it writes to (a closed `2>&1 | head` never crashes it).
const READER_GONE_CODES = new Set(['EPIPE', 'ENOTCONN']);
process.stdout.on('error', (error) => {
  if (!READER_GONE_CODES.has(error.code)) throw error;
});

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
    process.exitCode = 1;
    return;
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

  // process.exitCode, not process.exit(): exit() right after a large write to
  // a pipe (`-- --json | jq`, a CI capture) discards whatever didn't fit in
  // the pipe's buffer (~64 KB) and the JSON arrives truncated. Nothing here
  // holds the process open, so it ends on its own once stdout has drained.
  process.exitCode = result.ok ? 0 : 1;
}

main().catch(function (error) {
  // Only reached for something runTemplateValidation itself doesn't expect
  // (it resolves every load/validate failure as a finding). Still reported
  // as a finding, without the stack; the fixed result covers the sanitizer
  // itself throwing, in the same shape (and on the same streams, so
  // `--json` stays parseable) as any other failure.
  try {
    printFailure(loadFailureResult(error));
  } catch (secondError) {
    printUnrunnableResult({ json: json });
  }
  process.exitCode = 1;
});
