function noRelativeBacktrack(template) {
  if (!template.css) return [];
  const errors = [];
  const pattern = /url\s*\(\s*['"]?(\.\.)/gi;
  let match;
  while ((match = pattern.exec(template.css.content)) !== null) {
    const start = match.index;
    const excerpt = template.css.content.slice(start, start + 60).replace(/\n/g, ' ');
    errors.push({
      rule: 'noRelativeBacktrack',
      message: `Path com ../ bloqueado em CSS — quebra quando servido pelo handler: ${excerpt.trim()}`,
      file: template.css.path,
    });
  }
  return errors;
}

noRelativeBacktrack.ruleName = 'noRelativeBacktrack';
noRelativeBacktrack.describe = function(template) {
  return template.css ? 'CSS' : 'sem CSS';
};
module.exports = noRelativeBacktrack;
