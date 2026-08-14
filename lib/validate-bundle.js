'use strict';

const { validate } = require('@vtex/payment-templates-validator');
const { readPreviewConfig } = require('./preview-config');
const { buildValidationInput } = require('./build-validation-input');

/**
 * Runs the shared validator against the configured preview bundle.
 * Returns ValidateResult { ok, errors } — identical to server-side output.
 */
async function validateBundle(config) {
  const resolvedConfig = config || readPreviewConfig();
  const input = buildValidationInput(resolvedConfig);
  return validate(input);
}

module.exports = {
  buildValidationInput,
  validateBundle,
};
