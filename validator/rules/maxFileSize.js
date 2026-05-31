// Rule: maxFileSize
// Soma o tamanho de todos os arquivos enviados e falha se passar de 128KB.
//
// IMPORTANTE: este arquivo é uma CÓPIA do que está no
// payment-templates-handler (Squad A). Os 2 squads precisam manter
// as rules em sincronia — qualquer mudança aqui deve refletir lá.
// (Discussão no cross-squad sync: extrair pra módulo compartilhado pós-dojo)

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
