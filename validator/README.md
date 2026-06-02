# payment-template-validator

CLI e biblioteca de validação de templates de pagamento para o VTEX Smart Checkout.

## Como rodar

```bash
# da raiz do repositório
node validator/cli.js src/

# ou via npm
npm run validate -- src/
```

Saída esperada para template válido:

```
Validando /caminho/para/src...

  ✓ maxFileSize            (10 arquivo(s), 29 KB)
  ✓ i18nKeyConsistency     (4 locale(s), 10 chave(s))
  ✓ htmlSafety             (payment.html)
  ✓ noExternalRefs         (HTML + CSS)

✓ template passou em todas as validações
```

## Flags

| Flag | Efeito |
|---|---|
| `--json` | Output JSON `{ ok, errors }` para CI/CD |

Exit codes: `0` = válido, `1` = erros de validação, `2` = uso incorreto (dir não encontrado, etc).

## Estrutura

```
validator/
└── cli.js                          ← entry point (cliente fino da lib)

packages/validator/src/
├── index.js                        ← validate(dir, opts) → Promise<{ok, errors, details}>
├── runner.js                       ← orquestra discovery + execução das rules
├── walkFiles.js                    ← varre arquivos, respeita IGNORED_PATHS
└── rules/
    ├── index.js                    ← registry de rules ativas
    ├── maxFileSize.js
    ├── i18nKeyConsistency.js
    ├── htmlSafety.js
    └── noExternalRefs.js
```

## Rules ativas

| Rule | O que valida |
|---|---|
| `maxFileSize` | Soma total dos arquivos ≤ 128 KB |
| `i18nKeyConsistency` | Todos os `i18n/*.json` têm o mesmo set de chaves |
| `htmlSafety` | Sem `<script>`, `eval()` ou atributos `on*=` inline |
| `noExternalRefs` | Sem URLs `http://`/`https://` em HTML ou CSS |

## API da lib (Squad A / server-side)

```js
const { validate } = require('./packages/validator/src');

const { ok, errors } = await validate('./caminho/do/template', {
  maxFileSize: 256 * 1024,  // override do limite (opcional)
});

if (!ok) {
  // errors: [{ rule, message, file?, severity? }]
}
```

## Adicionar uma rule nova

Veja `.claude/skills/add-validator-rule.md` ou siga os passos:

1. Crie `packages/validator/src/rules/<nome>.js` com a assinatura padrão
2. Registre em `packages/validator/src/rules/index.js`
3. Crie os testes em `packages/validator/src/tests/<nome>.test.js`
4. Rode `npm test` para confirmar

## Testes

```bash
npm test
```

## Casos de erro para teste manual

```bash
# template com arquivo grande
node validator/cli.js examples/bad-templates/max-file-size

# i18n com chaves inconsistentes
node validator/cli.js examples/bad-templates/i18n-inconsistente

# HTML com script e handlers inline
node validator/cli.js examples/bad-templates/html-unsafe

# URLs externas em HTML e CSS
node validator/cli.js examples/bad-templates/external-refs

# todos os erros juntos
node validator/cli.js examples/bad-templates/tudo-errado
```
