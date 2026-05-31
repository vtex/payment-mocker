#!/usr/bin/env node
// CLI de validação de templates pra parceiros.
//
// Uso:
//   node validator/cli.js <path-do-template>
//   npm run validate -- <path-do-template>
//
// O objetivo é dar pro parceiro o MESMO validador que roda no
// payment-templates-handler (Squad A), pra ele pegar erros ANTES
// de mandar o ticket pra VTEX.

const fs = require('fs');
const path = require('path');
const rules = require('./rules');

// =============================================================================
// CLI args
// =============================================================================
const args = process.argv.slice(2);
const templateDir = args[0];

if (!templateDir) {
  console.error('Uso: node validator/cli.js <path-do-template>');
  console.error('Exemplo: node validator/cli.js ./src/');
  process.exit(2);
}

const resolvedDir = path.resolve(templateDir);
if (!fs.existsSync(resolvedDir)) {
  console.error(`Diretório não encontrado: ${resolvedDir}`);
  process.exit(2);
}

// =============================================================================
// Read template files
// =============================================================================
// Slots conhecidos (html, css, i18n, icon) usam paths fixos compatíveis com
// a estrutura do payment-mocker. Qualquer OUTRO arquivo no template é tratado
// como asset e vai pro array assets.
//
// IMPORTANTE: o payment-mocker é um boilerplate de DEV environment — tem
// arquivos que servem só pra renderizar o template no browser local (a página
// wrapper, libs, o CSS base do checkout mockado). Esses arquivos NÃO são
// parte do template que o parceiro envia pra VTEX, então não entram na
// validação. A lista IGNORED_PATHS abaixo encapsula essa convenção.
//
// TODO Squad B: refinar a convenção
//   - aceitar --layout pra trocar mapping de paths
//   - aceitar --ignore-glob pra adicionar excludes via CLI
//   - permitir um .validatorignore na raiz do template

const IGNORED_NAMES = new Set(['.DS_Store', '.git', 'node_modules']);

// Paths relativos à raiz do template que NÃO fazem parte do que seria
// enviado pra VTEX. Tudo aqui é ignorado pelo discovery.
const IGNORED_PATHS = new Set([
  'index.html',                  // página wrapper do dev environment
  'checkout-style.css',          // CSS base do checkout (mock pro dev)
  'assets/libs',                 // angular.min.js, i18n.js do dev (diretório inteiro)
  'assets/css/sass',             // não usado (sass scaffolding vazio)
  'assets/css/less/style.less',  // source do CSS — só o .css compilado vai pro template
]);

function isIgnoredPath(absolutePath, rootDir) {
  const rel = path.relative(rootDir, absolutePath);
  if (IGNORED_PATHS.has(rel)) return true;
  // qualquer ancestral também ignorado (ex.: assets/libs/angular.min.js)
  for (const ignored of IGNORED_PATHS) {
    if (rel === ignored || rel.startsWith(ignored + path.sep)) return true;
  }
  return false;
}

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

function walkFiles(dir, rootDir = dir) {
  const out = [];
  const visit = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (isIgnoredPath(full, rootDir)) continue;
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        out.push({ path: full, size: stat.size });
      }
    }
  };
  visit(dir);
  return out;
}

function readTemplate(dir) {
  const html = readSlot(dir, 'partials/payment.html', 'payment.html', 'index.html');
  const css = readSlot(dir, 'assets/css/less/style.css', 'style.css');
  const i18n = readSlot(dir, 'i18n/pt-BR.json', 'i18n.json');
  const icon = readSlot(dir, 'assets/img/icon.png', 'icon.png');

  // Tudo que não é um slot conhecido vira asset.
  const known = new Set([html, css, i18n, icon].filter(Boolean).map(f => f.path));
  const assets = walkFiles(dir).filter(f => !known.has(f.path));

  return { html, css, i18n, icon, assets };
}

// =============================================================================
// Run validations
// =============================================================================
const template = readTemplate(resolvedDir);

if (!template.html) {
  console.error(`\x1b[31m✗ não achei o HTML do template em ${resolvedDir}\x1b[0m`);
  console.error('  esperado em: partials/payment.html, payment.html ou index.html');
  process.exit(1);
}

const allErrors = rules.flatMap(rule => rule(template));

// =============================================================================
// Output
// =============================================================================
const useJson = args.includes('--json');

if (useJson) {
  console.log(JSON.stringify({
    ok: allErrors.length === 0,
    errors: allErrors,
  }, null, 2));
} else {
  if (allErrors.length === 0) {
    console.log(`\x1b[32m✓ template em ${resolvedDir} passou em todas as validações\x1b[0m`);
  } else {
    console.log(`\x1b[31m✗ ${allErrors.length} erro(s) encontrado(s):\x1b[0m`);
    allErrors.forEach(e => {
      console.log(`  \x1b[31m✗\x1b[0m ${e.rule}: ${e.message}`);
    });
  }
}

process.exit(allErrors.length === 0 ? 0 : 1);
