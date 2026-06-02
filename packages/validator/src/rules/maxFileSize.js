const DEFAULT_MAX_BYTES = 128 * 1024; // 128KB

function maxFileSize(template, opts = {}) {
  const limit = (opts && opts.maxFileSize) || DEFAULT_MAX_BYTES;
  const total = (template.assets || [])
    .concat([template.html, template.css, template.i18n, template.icon].filter(Boolean))
    .reduce((sum, file) => sum + (file.size || 0), 0);

  if (total > limit) {
    return [{
      rule: 'maxFileSize',
      message: `Tamanho total ${total} bytes excede o limite de ${limit} bytes (${Math.round(limit / 1024)}KB)`,
    }];
  }
  return [];
}

maxFileSize.ruleName = 'maxFileSize';
module.exports = maxFileSize;
