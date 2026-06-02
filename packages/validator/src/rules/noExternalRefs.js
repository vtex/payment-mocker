function noExternalRefs(template) {
  const errors = [];

  if (template.html) {
    const content = template.html.content;
    const attrPattern = /(?:src|href)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi;
    let match;
    while ((match = attrPattern.exec(content)) !== null) {
      errors.push({
        rule: 'noExternalRefs',
        message: `URL externa bloqueada em HTML: ${match[1]}`,
        file: template.html.path,
      });
    }
  }

  if (template.css) {
    const content = template.css.content;

    const urlPattern = /url\s*\(\s*["']?(https?:\/\/[^"'\s)]+)/gi;
    let match;
    while ((match = urlPattern.exec(content)) !== null) {
      errors.push({
        rule: 'noExternalRefs',
        message: `URL externa bloqueada em CSS: ${match[1]}`,
        file: template.css.path,
      });
    }

    const importPattern = /@import\s+["'](https?:\/\/[^"']+)/gi;
    while ((match = importPattern.exec(content)) !== null) {
      errors.push({
        rule: 'noExternalRefs',
        message: `@import externo bloqueado em CSS: ${match[1]}`,
        file: template.css.path,
      });
    }
  }

  return errors;
}

noExternalRefs.ruleName = 'noExternalRefs';
module.exports = noExternalRefs;
