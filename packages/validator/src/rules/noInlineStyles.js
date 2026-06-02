function noInlineStyles(template) {
  if (!template.html) return [];
  if (!/\bstyle\s*=/i.test(template.html.content)) return [];
  return [{
    rule: 'noInlineStyles',
    message: 'Atributo style= inline não é permitido — use classes CSS no arquivo de estilos',
    file: template.html.path,
  }];
}

noInlineStyles.ruleName = 'noInlineStyles';
noInlineStyles.describe = function(template) {
  return template.html ? path.basename(template.html.path) : 'sem HTML';
};
const path = require('path');
module.exports = noInlineStyles;
