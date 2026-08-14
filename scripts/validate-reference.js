'use strict';

const { validate } = require('@vtex/payment-templates-validator');
const { loadBundleForValidation } = require('../lib/load-bundle');
const { readPreviewConfig } = require('../lib/preview-config');

async function main() {
  const config = readPreviewConfig();
  const template = loadBundleForValidation(config.bundlePath, config.defaultLocale);

  const result = await validate({ template });

  if (result.ok) {
    console.log('validate: ok — template at template/' + config.bundleDir + ' passed all applicable rules.');
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
