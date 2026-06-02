function i18nKeyConsistency(template) {
  const files = template.i18nFiles;
  if (!files || files.length < 2) return [];

  const base = files[0];
  let baseKeys;
  try {
    baseKeys = new Set(Object.keys(JSON.parse(base.content)));
  } catch {
    return [{
      rule: 'i18nKeyConsistency',
      message: `JSON inválido em ${base.name}`,
      file: base.path,
    }];
  }

  const errors = [];
  for (const file of files.slice(1)) {
    let fileKeys;
    try {
      fileKeys = new Set(Object.keys(JSON.parse(file.content)));
    } catch {
      errors.push({
        rule: 'i18nKeyConsistency',
        message: `JSON inválido em ${file.name}`,
        file: file.path,
      });
      continue;
    }

    for (const key of baseKeys) {
      if (!fileKeys.has(key)) {
        errors.push({
          rule: 'i18nKeyConsistency',
          message: `${file.name} não tem a chave '${key}' que existe em ${base.name}`,
          file: file.path,
        });
      }
    }
    for (const key of fileKeys) {
      if (!baseKeys.has(key)) {
        errors.push({
          rule: 'i18nKeyConsistency',
          message: `${file.name} tem a chave extra '${key}' que não existe em ${base.name}`,
          file: file.path,
        });
      }
    }
  }

  return errors;
}

i18nKeyConsistency.ruleName = 'i18nKeyConsistency';
i18nKeyConsistency.describe = function(template) {
  const files = template.i18nFiles || [];
  if (files.length === 0) return 'nenhum arquivo i18n encontrado';
  try {
    const keys = Object.keys(JSON.parse(files[0].content)).length;
    return `${files.length} locale(s), ${keys} chave(s)`;
  } catch {
    return `${files.length} locale(s)`;
  }
};
module.exports = i18nKeyConsistency;
