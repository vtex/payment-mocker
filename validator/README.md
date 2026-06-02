# Squad B — payment-template-validator

> Bem-vindos. Esta pasta é o **ponto de partida do Squad B** no dojo de Dynamic Payment Templates.

## Em 30 segundos

Hoje há um CLI rudimentar de validação aqui em `validator/cli.js`, com uma única rule (`maxFileSize`). O `payment-templates-handler` (Squad A) **não** roda validação — é fonte de bug se evoluirmos assim.

**A missão de vocês:** extrair a validação pra uma **biblioteca standalone** (`@vtex/payment-template-validator`) consumida por DOIS clientes:

- O CLI atual (`npm run validate -- src/`) — parceiro roda local
- O `payment-templates-handler` (Squad A) — server-side, bloqueia uploads ruins

E implementar regras **novas** que pegam bugs reais que humano não pega no review:

- `i18nKeyConsistency` — todos locales têm o mesmo set de chaves
- `htmlSafety` — bloqueia `<script>` malicioso, `eval`, `onclick=` inline
- `noExternalRefs` — sem URLs externas em HTML/CSS (privacy + reliability + supply chain)
- (e mais adicionais — ver SPEC)

Vocês escolhem **3 obrigatórias + 0-1 adicional**. Leiam `SPEC.md` pro menu completo.

## Como rodar (estado atual)

```bash
# CLI atual com a rule única que já existe
node validator/cli.js src/

# ou via npm
npm run validate -- src/
```

Esperado: ✓ verde (o template default do payment-mocker passa em `maxFileSize`).

## Como criar um caso de erro pra testar

```bash
dd if=/dev/urandom of=src/big-asset.bin bs=1024 count=200    # 200KB
node validator/cli.js src/
# deve retornar exit 1 e mostrar o erro de maxFileSize
rm src/big-asset.bin
```

## Estrutura proposta (a construir no dojo)

```
payment-mocker/
└── packages/
    └── validator/                    ← NOVO: módulo standalone
        ├── package.json              (name: "@vtex/payment-template-validator")
        ├── src/
        │   ├── index.js              (export { validate, rules })
        │   ├── runner.js
        │   ├── walkFiles.js          (já existe, migrar)
        │   └── rules/
        │       ├── index.js
        │       ├── maxFileSize.js    (já existe, migrar/refinar)
        │       └── ...               (rules novas)
        └── cli.js                    (consumido por `npm run validate`)
```

## O que o discovery considera como "template"

O `payment-mocker` é um boilerplate de **dev environment** — tem
arquivos que só servem pra renderizar o template no browser local
(uma página HTML wrapper, libs do Angular, o CSS base do checkout
mockado). Esses arquivos NÃO seriam enviados pelo parceiro pra VTEX,
então o validator **ignora**:

| Path | Por quê |
|---|---|
| `index.html` (root) | Página wrapper do dev environment |
| `checkout-style.css` | Mock do CSS base do checkout |
| `assets/libs/` | angular.min.js, i18n.js (libs do mocker) |
| `assets/css/sass/` | Scaffolding vazio |
| `assets/css/less/style.less` | Source do CSS — só o `.css` compilado entra no template |

Essa lista está em `IGNORED_PATHS` no `cli.js`. Quando migrarem pra
a lib, mantenham (ou virem opção `opts.ignore`).

## Onde mexer

Procure `TODO Squad B:` no código:

```bash
grep -rn "TODO Squad B:" validator/
```

## Arquivos importantes

| Arquivo | O que faz |
|---|---|
| `validator/cli.js` | Entry point atual — vai virar consumidor da lib que vocês vão extrair |
| `validator/rules/index.js` | Registry de rules (atual) |
| `validator/rules/maxFileSize.js` | Rule única que existe hoje — migrar pra lib |
| `SPEC.md` | Spec SDD do squad — menu de rules, pontos de integração com Squad A |

## Contrato com Squad A

Squad A consome `validate()` no `POST /upload`. **A interface precisa ser definida no design contract (0:10–0:15).** Sugestão de assinatura inicial (revisar com A):

```ts
async function validate(
  templateDir: string,
  opts?: { rules?: string[], ignore?: string[], maxFileSize?: number }
): Promise<{ ok: boolean, errors: ValidationError[] }>

type ValidationError = {
  rule: string;
  message: string;
  file?: string;
  severity?: "error" | "warning";
}
```

Squad A pode mockar `validate() → {ok: true}` no início e plugar a real depois — assim vocês não bloqueiam uns aos outros.
