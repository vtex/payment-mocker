# Skill: add-validator-rule

Cria uma nova rule de validação no `payment-template-validator`.

## Uso

```
/add-validator-rule <nome-da-rule> — <descrição curta do que ela valida>
```

Exemplo:
```
/add-validator-rule requiredFiles — garante que payment.html, i18n/pt-BR.json e icon estão presentes
```

---

## O que o skill faz

1. Cria `packages/validator/src/rules/<nome>.js` com a assinatura padrão
2. Registra a rule em `packages/validator/src/rules/index.js`
3. Cria `packages/validator/src/tests/<nome>.test.js` com testes para o happy path e pelo menos um caso de erro
4. Roda `npm test` para confirmar que tudo passa
5. Mostra o output da CLI contra `src/` para confirmar que o template default continua passando

---

## Contrato de uma rule

Toda rule é um arquivo em `packages/validator/src/rules/` que exporta uma função com esta assinatura:

```js
function nomeDaRule(template, opts = {}) {
  // template: { html, css, i18n, i18nFiles, icon, assets, templateDir }
  // opts: ValidateOptions passado pelo chamador
  // retorna: ValidationError[] — vazio se passar, com erros se falhar
}

// Nome da rule (usado no registry e nas mensagens de erro)
nomeDaRule.ruleName = 'nomeDaRule';

// Contexto exibido na CLI ao lado do ✓/✗ (opcional mas recomendado)
nomeDaRule.describe = function(template) {
  return 'descrição curta do que foi verificado';
};

module.exports = nomeDaRule;
```

## Tipo ValidationError

```js
{
  rule: string,               // nome da rule (igual a ruleName)
  message: string,            // mensagem em pt-BR, clara o suficiente para o parceiro corrigir
  file?: string,              // path do arquivo que causou o erro (quando aplicável)
  severity?: 'error' | 'warning',  // default: 'error'
}
```

## Objeto template

| Campo | Tipo | O que contém |
|---|---|---|
| `html` | `FileSlot\|null` | `partials/payment.html` ou `payment.html` |
| `css` | `FileSlot\|null` | `assets/css/less/style.css` ou `style.css` |
| `i18n` | `FileSlot\|null` | `i18n/pt-BR.json` (slot principal) |
| `i18nFiles` | `FileSlot[]` | todos os `i18n/*.json` ordenados |
| `icon` | `FileSlot\|null` | `assets/img/icon.png` |
| `assets` | `FileRef[]` | demais arquivos não-slot |
| `templateDir` | `string` | path absoluto da raiz do template |

`FileSlot` tem `.path`, `.size`, `.content` (string utf-8, lazy) e `.buffer` (Buffer, lazy).  
`FileRef` tem só `.path` e `.size`.

## Registrar no index

Após criar o arquivo da rule, adicione no `packages/validator/src/rules/index.js`:

```js
module.exports = [
  require('./maxFileSize'),
  require('./i18nKeyConsistency'),
  require('./htmlSafety'),
  require('./noExternalRefs'),
  require('./<nomeDaRule>'),   // ← adicionar aqui
];
```

## Template de teste

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const nomeDaRule = require('../rules/nomeDaRule');

test('nomeDaRule — passa quando [condição válida]', () => {
  const template = { /* montar o template mínimo necessário */ };
  assert.equal(nomeDaRule(template).length, 0);
});

test('nomeDaRule — falha quando [condição de erro]', () => {
  const template = { /* montar template com o problema */ };
  const errors = nomeDaRule(template);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'nomeDaRule');
  assert.match(errors[0].message, /texto esperado/);
});
```

## Checklist de entrega

- [ ] Arquivo da rule criado com `ruleName` e `describe` definidos
- [ ] Rule registrada em `rules/index.js`
- [ ] Testes cobrindo happy path + pelo menos 1 erro + edge case (template sem o campo relevante)
- [ ] `npm test` passando (37+ testes)
- [ ] `node validator/cli.js src/` retorna exit 0 (template default não quebra com a nova rule)
