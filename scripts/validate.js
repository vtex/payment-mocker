'use strict';

const { validateBundle } = require('../lib/validate-bundle');
const { printValidationResult } = require('../lib/format-validation-output');
const { readPreviewConfig } = require('../lib/preview-config');

async function main() {
  const json = process.argv.indexOf('--json') !== -1;
  const config = readPreviewConfig();
  const result = await validateBundle(config);

  printValidationResult(result, {
    json: json,
    suffix: ' — template at template/' + config.bundleDir,
  });

  process.exit(result.ok ? 0 : 1);
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
