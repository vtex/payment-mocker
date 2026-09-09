'use strict';

const { validate } = require('@vtex/payment-templates-validator');
const { loadBundleForValidation } = require('../lib/load-bundle');
const { readPreviewConfig } = require('../lib/preview-config');
const { buildValidationInput } = require('../lib/validation-input');

async function main() {
  const config = readPreviewConfig();
  const template = loadBundleForValidation(config.bundlePath, config.defaultLocale);
  const input = buildValidationInput(config, template);

  const result = await validate(input);

  if (result.ok) {
    console.log('validate: ok — template at template/' + config.bundleDir + ' passed all applicable rules.');
    const warnings = (result.errors || []).filter((finding) => finding.severity === 'warning');
    for (const finding of warnings) {
      const ref = finding.ref ? ' (' + finding.ref.file + ')' : '';
      console.warn('  [' + finding.rule + '] ' + finding.message + ref);
    }
    process.exit(0);
  }

  console.error('validate: failed');
  for (const finding of result.errors) {
    const ref = finding.ref ? ' (' + finding.ref.file + ')' : '';
    console.error('  [' + finding.rule + '] ' + finding.message + ref);
  }
  process.exit(1);
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
