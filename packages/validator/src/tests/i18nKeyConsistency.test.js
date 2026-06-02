const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const i18nKeyConsistency = require('../rules/i18nKeyConsistency');

function makeI18nFiles(dir, locales) {
  const i18nDir = path.join(dir, 'i18n');
  fs.mkdirSync(i18nDir, { recursive: true });
  return Object.entries(locales).map(([name, data]) => {
    const filePath = path.join(i18nDir, name);
    const content = JSON.stringify(data);
    fs.writeFileSync(filePath, content);
    return {
      name,
      path: filePath,
      size: content.length,
      get content() { return fs.readFileSync(this.path, 'utf8'); },
    };
  });
}

test('i18nKeyConsistency — passa quando todos os locales têm as mesmas chaves', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-'));
  const i18nFiles = makeI18nFiles(tmpDir, {
    'pt-BR.json': { a: '1', b: '2' },
    'en-US.json': { a: 'A', b: 'B' },
    'es.json':    { a: 'Alpha', b: 'Beta' },
  });
  const template = { i18nFiles };
  const errors = i18nKeyConsistency(template);
  assert.equal(errors.length, 0);
});

test('i18nKeyConsistency — falha quando locale está faltando uma chave', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-'));
  const i18nFiles = makeI18nFiles(tmpDir, {
    'pt-BR.json': { a: '1', b: '2', c: '3' },
    'es.json':    { a: 'Alpha', b: 'Beta' },
  });
  const template = { i18nFiles };
  const errors = i18nKeyConsistency(template);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'i18nKeyConsistency');
  assert.match(errors[0].message, /es\.json.*não tem a chave 'c'/);
});

test('i18nKeyConsistency — falha quando locale tem chave extra', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-'));
  const i18nFiles = makeI18nFiles(tmpDir, {
    'pt-BR.json': { a: '1' },
    'es.json':    { a: 'Alpha', extra: 'X' },
  });
  const template = { i18nFiles };
  const errors = i18nKeyConsistency(template);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /chave extra 'extra'/);
});

test('i18nKeyConsistency — retorna vazio quando há menos de 2 arquivos', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-'));
  const i18nFiles = makeI18nFiles(tmpDir, { 'pt-BR.json': { a: '1' } });
  const template = { i18nFiles };
  const errors = i18nKeyConsistency(template);
  assert.equal(errors.length, 0);
});

test('i18nKeyConsistency — retorna vazio quando i18nFiles está ausente', () => {
  const template = { i18nFiles: [] };
  const errors = i18nKeyConsistency(template);
  assert.equal(errors.length, 0);
});
