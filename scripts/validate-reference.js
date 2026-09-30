'use strict';

const { validate } = require('@vtex/payment-templates-core');
const { loadBundleForValidation } = require('../lib/load-bundle');
const { readPreviewConfig } = require('../lib/preview-config');
const { buildValidationInput, withExtraFindings } = require('../lib/validation-input');

async function main() {
  const config = readPreviewConfig();
  const template = loadBundleForValidation(config.bundlePath, config.defaultLocale);
  // `findings`: problems with the configured icon that kept it out of
  // `input` (see buildValidationInput) — merged in so they fail this run and
  // print below exactly like validate()'s own errors, while validate() still
  // reports on everything else.
  const { input, findings } = buildValidationInput(config, template);

  const result = withExtraFindings(await validate(input), findings);

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
