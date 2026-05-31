# Squad B — payment-mocker / validator

> Bem-vindos. Esta pasta é o **ponto de partida do Squad B** no dojo de Dynamic Payment Templates.

## Em 30 segundos

Vocês vão construir uma **CLI de validação** que os parceiros vão rodar localmente, ANTES de enviar o template pra VTEX, pra pegar erros sem precisar abrir ticket. As mesmas rules rodam também no `payment-templates-handler` (Squad A) — vocês precisam manter as 2 cópias em sincronia.

## Como rodar

```bash
# A CLI já funciona com a rule de exemplo (maxFileSize)
node validator/cli.js src/

# ou via npm
npm run validate -- src/
```

Esperado: ✓ verde (o template default do payment-mocker é pequenininho, passa em maxFileSize).

## Como criar um caso de erro pra testar

Cria um arquivo grandão dentro de `src/`:

```bash
dd if=/dev/urandom of=src/big-asset.bin bs=1024 count=200    # 200KB
node validator/cli.js src/
# deve retornar exit 1 e mostrar o erro de maxFileSize
rm src/big-asset.bin
```

## O que o discovery considera como "template"

O `payment-mocker` é um boilerplate de **dev environment** — tem arquivos
que só servem pra renderizar o template no browser local (uma página HTML
wrapper, libs do Angular, o CSS base do checkout mockado). Esses arquivos
NÃO seriam enviados pelo parceiro pra VTEX, então o validator **ignora**:

| Path | Por quê |
|---|---|
| `index.html` (root) | Página wrapper do dev environment |
| `checkout-style.css` | Mock do CSS base do checkout |
| `assets/libs/` | angular.min.js, i18n.js (libs do mocker) |
| `assets/css/sass/` | Scaffolding vazio |
| `assets/css/less/style.less` | Source do CSS — só o `.css` compilado entra no template |

Essa lista está em `IGNORED_PATHS` no `cli.js`. **TODO Squad B:** decidir
se mantém hardcoded, se vira `.validatorignore`, ou se vira flag
`--ignore-glob`.

Tudo fora dessa lista (incluindo arquivos no root de `src/`, em `partials/`,
`assets/img/`, `i18n/`, etc.) entra na conta da `maxFileSize` e em qualquer
outra rule futura.

## Onde mexer

Procure `TODO Squad B:` no código:

```bash
grep -rn "TODO Squad B:" validator/
```

## Arquivos importantes

| Arquivo | O que faz |
|---|---|
| `validator/cli.js` | Entry point — lê args, descobre arquivos, roda rules, formata output |
| `validator/rules/index.js` | Registry de rules (adicione novas aqui) |
| `validator/rules/maxFileSize.js` | Implementação de referência (cópia espelhada do Squad A) |
| `SPEC.md` | Spec SDD do squad (preencher Section 1-2 no dojo) |

## Contrato com Squad A

O Squad A (`payment-templates-handler`) tem uma cópia das MESMAS rules. **A interface `ValidationError` precisa ser idêntica:**

```js
{
  rule: string,         // ex: "maxFileSize"
  message: string,      // human-readable, pt-BR
  file: string?,        // opcional
}
```

**Cross-squad sync (0:20–0:22 do dojo):** alinhem se vão sincronizar manualmente as 2 cópias durante o dojo, ou se vão extrair pra módulo compartilhado pós-dojo.
