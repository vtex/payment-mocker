function htmlSafety(template) {
  if (!template.html) return [];

  const content = template.html.content;
  const errors = [];

  if (/<script\b/i.test(content)) {
    errors.push({
      rule: 'htmlSafety',
      message: 'Tag <script> não é permitida no template',
      file: template.html.path,
    });
  }

  if (/\beval\s*\(/.test(content)) {
    errors.push({
      rule: 'htmlSafety',
      message: 'Uso de eval() não é permitido no template',
      file: template.html.path,
    });
  }

  const inlineHandlerMatch = content.match(/\bon\w+\s*=/i);
  if (inlineHandlerMatch) {
    errors.push({
      rule: 'htmlSafety',
      message: `Atributo de evento inline não é permitido: ${inlineHandlerMatch[0].trim()}`,
      file: template.html.path,
    });
  }

  return errors;
}

htmlSafety.ruleName = 'htmlSafety';
htmlSafety.describe = function(template) {
  return template.html ? path.basename(template.html.path) : 'sem HTML';
};
const path = require('path');
module.exports = htmlSafety;
