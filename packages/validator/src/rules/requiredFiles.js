function requiredFiles(template) {
  const errors = [];

  if (!template.html) {
    errors.push({
      rule: 'requiredFiles',
      message: 'payment.html não encontrado (esperado em partials/payment.html ou payment.html)',
      severity: 'error',
    });
  }

  if (!template.i18n) {
    errors.push({
      rule: 'requiredFiles',
      message: 'i18n/pt-BR.json não encontrado',
      severity: 'error',
    });
  }

  if (!template.icon) {
    errors.push({
      rule: 'requiredFiles',
      message: 'ícone não encontrado (esperado em assets/img/icon.png ou icon.png)',
      severity: 'warning',
    });
  }

  return errors;
}

requiredFiles.ruleName = 'requiredFiles';
requiredFiles.describe = function(template) {
  const present = ['html', 'i18n', 'icon'].filter(k => template[k]).length;
  return `${present}/3 arquivos obrigatórios`;
};
module.exports = requiredFiles;
