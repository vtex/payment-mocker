'use strict';

const { validate } = require('@vtex/payment-templates-core');
const { loadBundleForValidation } = require('../lib/load-bundle');
const { readPreviewConfig } = require('../lib/preview-config');
const { buildValidationInput } = require('../lib/validation-input');
const { printValidationResult } = require('../lib/format-validation-output');

async function main() {
  const json = process.argv.indexOf('--json') !== -1;
  const config = readPreviewConfig();
  const template = loadBundleForValidation(config.bundlePath, config.defaultLocale);
  const input = buildValidationInput(config, template);

  const result = await validate(input);

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
