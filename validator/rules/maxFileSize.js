// Rule: maxFileSize
// Soma o tamanho de todos os arquivos enviados e falha se passar de 128KB.
//
// TODO Squad B: migrar essa rule pra @vtex/payment-template-validator
// (packages/validator/src/rules/), pra ser consumida tanto por esta
// CLI quanto pelo payment-templates-handler (Squad A) — fonte única
// de verdade. Alinhar interface com Squad A no design contract.

const MAX_TOTAL_BYTES = 128 * 1024; // 128KB

module.exports = function maxFileSize(template) {
  const total = (template.assets || [])
    .concat([template.html, template.css, template.i18n, template.icon].filter(Boolean))
    .reduce((sum, file) => sum + (file.size || 0), 0);

  if (total > MAX_TOTAL_BYTES) {
    return [{
      rule: 'maxFileSize',
      message: `Tamanho total ${total} bytes excede o limite de ${MAX_TOTAL_BYTES} bytes (128KB)`,
    }];
  }
  return [];
};
