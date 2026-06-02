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
const YELLOW = s => `\x1b[33m${s}\x1b[0m`;
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

  const warnings = errors.filter(e => e.severity === 'warning');
  const hardErrors = errors.filter(e => !e.severity || e.severity === 'error');

  for (const d of details) {
    const hasHardError = d.errors.some(e => !e.severity || e.severity === 'error');
    const hasWarning   = d.errors.some(e => e.severity === 'warning');
    const icon = hasHardError ? RED('✗') : hasWarning ? YELLOW('⚠') : GREEN('✓');
    const desc = d.description ? DIM(`(${d.description})`) : '';
    console.log(`  ${icon} ${d.rule.padEnd(22)} ${desc}`);
    for (const e of d.errors) {
      const arrow = e.severity === 'warning' ? YELLOW('→') : RED('→');
      console.log(`       ${arrow} ${e.message}`);
    }
  }

  console.log('');
  if (ok && warnings.length > 0) {
    console.log(GREEN('✓ template passou') + ` ${YELLOW(`(${warnings.length} aviso(s))`)}`);
  } else if (ok) {
    console.log(GREEN('✓ template passou em todas as validações'));
  } else {
    console.log(RED(`✗ ${hardErrors.length} erro(s) encontrado(s)`) + (warnings.length ? ` ${YELLOW(`(${warnings.length} aviso(s))`)}` : ''));
  }
  console.log('');

  process.exit(ok ? 0 : 1);
});
