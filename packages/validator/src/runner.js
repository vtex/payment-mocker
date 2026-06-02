const fs = require('fs');
const path = require('path');
const { walkFiles, DEFAULT_IGNORED_PATHS } = require('./walkFiles');

function readSlot(dir, ...candidates) {
  for (const rel of candidates) {
    const fullPath = path.join(dir, rel);
    if (!fs.existsSync(fullPath)) continue;
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;
    return {
      path: fullPath,
      size: stat.size,
      get content() { return fs.readFileSync(fullPath, 'utf8'); },
      get buffer() { return fs.readFileSync(fullPath); },
    };
  }
  return null;
}

function readTemplate(dir, opts = {}) {
  const ignoredPaths = opts.ignore ? new Set(opts.ignore) : DEFAULT_IGNORED_PATHS;

  const html = readSlot(dir, 'partials/payment.html', 'payment.html');
  const css = readSlot(dir, 'assets/css/less/style.css', 'style.css');
  const i18n = readSlot(dir, 'i18n/pt-BR.json', 'i18n.json');
  const icon = readSlot(dir, 'assets/img/icon.png', 'icon.png');

  const i18nDir = path.join(dir, 'i18n');
  const i18nFiles = fs.existsSync(i18nDir)
    ? fs.readdirSync(i18nDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .map(f => {
          const fullPath = path.join(i18nDir, f);
          return {
            path: fullPath,
            name: f,
            size: fs.statSync(fullPath).size,
            get content() { return fs.readFileSync(fullPath, 'utf8'); },
          };
        })
    : [];

  const known = new Set([html, css, i18n, icon].filter(Boolean).map(f => f.path));
  const assets = walkFiles(dir, dir, ignoredPaths).filter(f => !known.has(f.path));

  return { html, css, i18n, i18nFiles, icon, assets, templateDir: dir };
}

function run(templateDir, rules, opts = {}) {
  const template = readTemplate(templateDir, opts);

  const activeRules = opts.rules
    ? rules.filter(r => opts.rules.includes(r.ruleName))
    : rules;

  return activeRules.flatMap(rule => {
    try {
      return rule(template, opts);
    } catch (err) {
      return [{
        rule: rule.ruleName || 'unknown',
        message: `Erro interno na rule: ${err.message}`,
        severity: 'warning',
      }];
    }
  });
}

module.exports = { readTemplate, run };
