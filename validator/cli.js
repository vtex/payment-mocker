#!/usr/bin/env node
// CLI de validação de templates pra parceiros.
//
// Uso:
//   node validator/cli.js <path-do-template>
//   npm run validate -- <path-do-template>

const fs = require('fs');
const path = require('path');
const { validate } = require('../packages/validator/src');

const args = process.argv.slice(2);
const templateDir = args[0];
const useJson = args.includes('--json');

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

validate(resolvedDir).then(({ ok, errors }) => {
  if (useJson) {
    console.log(JSON.stringify({ ok, errors }, null, 2));
  } else {
    if (ok) {
      console.log(`\x1b[32m✓ template em ${resolvedDir} passou em todas as validações\x1b[0m`);
    } else {
      console.log(`\x1b[31m✗ ${errors.length} erro(s) encontrado(s):\x1b[0m`);
      errors.forEach(e => {
        console.log(`  \x1b[31m✗\x1b[0m ${e.rule}: ${e.message}`);
      });
    }
  }
  process.exit(ok ? 0 : 1);
});
