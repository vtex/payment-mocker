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

const GREEN  = s => `\x1b[32m${s}\x1b[0m`;
const RED    = s => `\x1b[31m${s}\x1b[0m`;
const DIM    = s => `\x1b[2m${s}\x1b[0m`;

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

validate(resolvedDir).then(({ ok, errors, details }) => {
  if (useJson) {
    console.log(JSON.stringify({ ok, errors }, null, 2));
    process.exit(ok ? 0 : 1);
    return;
  }

  console.log(`\nValidando ${resolvedDir}...\n`);

  for (const d of details) {
    const icon = d.ok ? GREEN('✓') : RED('✗');
    const desc = d.description ? DIM(`(${d.description})`) : '';
    console.log(`  ${icon} ${d.rule.padEnd(22)} ${desc}`);
    if (!d.ok) {
      for (const e of d.errors) {
        console.log(`       ${RED('→')} ${e.message}`);
      }
    }
  }

  console.log('');
  if (ok) {
    console.log(GREEN('✓ template passou em todas as validações'));
  } else {
    console.log(RED(`✗ ${errors.length} erro(s) encontrado(s)`));
  }
  console.log('');

  process.exit(ok ? 0 : 1);
});
