# Spec: payment-template-validator (Squad B)

> **Squad:** B — Shared Validation Library
> **Owner técnico do squad:** _<a definir no dojo>_
> **Owners de produto/UX/CX do squad:** _<a definir no dojo>_
> **Tempo de spec:** 15 min · **Tempo de impl:** 35 min

---

## 1. Business Context
*(2-4 frases. PM/CX/Designer lideram. Por que isso existe?)*

> **Seed (substitua/expanda):**
> Hoje o parceiro só descobre que o template falhou validação DEPOIS de abrir ticket pra VTEX. Cada ciclo de erro/correção adiciona 5–10 dias úteis ao tempo de release.
> Validação precisa rodar em DOIS lugares (CLI local do parceiro + handler no servidor da VTEX) — e precisa ser a MESMA validação. Hoje, se forem duplicadas em código, divergem em semanas e parceiro descobre só em produção.
> Esta entrega elimina a duplicação criando uma **biblioteca única** consumida pelos dois clientes.

## 2. Architecture Decisions
*(3-5 bullets. EM/SWE lideram. Decisões fundamentais e escopo.)*

- **`payment-template-validator` como módulo standalone** dentro do `payment-mocker/packages/validator/`, com `package.json` próprio. Em produção viraria pacote publicável (`@vtex/payment-template-validator`). No dojo, consumido via path relativo pelos dois clientes.
- **Duas interfaces públicas:**
  - **Lib:** `validate(templateDir, opts) → Promise<{ok, errors}>` — consumida pelo handler (Squad A)
  - **CLI:** `npx ptv validate <dir>` ou `npm run validate -- src/` — consumida pelo parceiro (e replicável no GitHub Actions deles)
- **Rules são plugáveis.** Cada rule é um módulo em `rules/`, com assinatura padronizada — Squad B pode focar em escrever rules novas sem mexer no runner.
- **Output em duas formas:** humano por padrão (cores ANSI), `--json` pra CI. Exit code 0/1 pra integração em pipelines.
- **FORA DO ESCOPO MVP:**
  - Publicação real no npm
  - Auto-fix (sugestão + apply)
  - Watch mode
  - Configuração via `.validatorrc`
  - i18n nas mensagens de erro (tudo em pt-BR por enquanto)

## 3. Technical Contract

### Estrutura proposta

```
payment-mocker/
└── packages/
    └── validator/                    ← NOVO: módulo standalone
        ├── package.json              (name: "@vtex/payment-template-validator")
        ├── src/
        │   ├── index.js              (export { validate, rules })
        │   ├── runner.js             (orquestra discovery + rules)
        │   ├── walkFiles.js          (recursivo, respeita IGNORED_PATHS)
        │   └── rules/
        │       ├── index.js          (registry)
        │       ├── maxFileSize.js    (já existe — migrar/refinar)
        │       └── ...               (rules novas)
        └── cli.js                    (CLI consumida por `npm run validate`)
```

### API pública da lib

```ts
type ValidationError = {
  rule: string;          // ex: "maxFileSize"
  message: string;       // human-readable, pt-BR
  file?: string;         // qual arquivo causou (opcional)
  severity?: "error" | "warning";  // default: "error"
}

type ValidateOptions = {
  rules?: string[];          // opcional: rodar só subset
  ignore?: string[];         // override do IGNORED_PATHS
  maxFileSize?: number;      // override do default 128KB
}

function validate(
  templateDir: string,
  opts?: ValidateOptions
): Promise<{ ok: boolean, errors: ValidationError[] }>
```

### CLI

```bash
# default: humano colorido, exit code 0/1
npx ptv validate ./src/

# máquina-legível pra CI
npx ptv validate ./src/ --json
```

### Dependencies on other squads
- **Squad A (`payment-templates-handler`)** consome `validate()` no `POST /upload`. **Squad A precisa receber a interface antes de Squad B terminar a implementação** — combinem no design contract (0:10–0:15). Squad A pode mockar `validate() → {ok: true}` no início e plugar a real depois.

---

## Menu de MVP — escolham 3 obrigatórias + 0-1 adicional

### Obrigatórias (cobrem os bugs reais de produção)

- [ ] **`i18nKeyConsistency`** — todos os `i18n/*.json` precisam ter o mesmo set de chaves
  *Por que crítico:* sem isso, checkout em `es` vai cair pra `pt-BR` em algumas labels (UX quebrado em produção). Pega bug que humano só percebe com 4 locales abertos lado a lado.
  Pseudocódigo:
  ```js
  const locales = readAllLocaleFiles(dir);
  const baseKeys = new Set(Object.keys(locales[0].content));
  for (const loc of locales.slice(1)) {
    const diff = symDiff(baseKeys, Object.keys(loc.content));
    if (diff.size) errors.push({rule: "i18nKeyConsistency", ...});
  }
  ```

- [ ] **`htmlSafety`** — bloqueia `<script>` fora do whitelist, `eval`, `onclick=` inline e outros handlers `on*`
  *Por que crítico:* template é código de terceiro renderizado em iframe. Sem regra, parceiro malicioso (ou descuidado) injeta JS arbitrário.
  *Vínculo histórico:* esta rule absorve o `allowedTags` da proposta original — em vez de só listar tags permitidas, ela mira no risco concreto (execução de JS arbitrário). Implementação pode usar whitelist de tags + atributos como mecanismo interno.

- [ ] **`noExternalRefs`** — bloqueia URLs externas em HTML e CSS
  *Por que crítico:* cobre 3 riscos ao mesmo tempo:
  - **Privacy:** `<img src="https://partner-cdn.com/pixel.gif">` que rastreia clientes
  - **Reliability:** CDN externo do parceiro cai → template quebra em todos os lojistas
  - **Supply chain:** `<script src="https://partner.com/lib.js">` → parceiro comprometido injeta código em N checkouts da VTEX

  Detecta em HTML (`src`/`href` em `<img>`, `<script>`, `<link>`, `<a>`, `<iframe>`) e em CSS (`url(...)`, `@import`). Permitidos: paths relativos (`./X`, `X.png`) e `data:` URIs.

### Adicional (escolham 0-1, se a banda permitir)

- [ ] **`assetsReferenced`** — todo asset uploadado é referenciado pelo HTML/CSS, e vice-versa
  *Pega:* asset órfão (ocupa espaço sem ser servido), typo de path (`<img src="logoo.png">` que vai dar 404), drift entre dev env e produção.
  ⚠️ **A mais cara de implementar** das adicionais — exige parser de HTML + CSS pra coletar todas as referências e cruzar com a árvore de arquivos. Escolham se sentirem confiança no tempo.

- [ ] **`iconDimensions`** — ícone tem dimensão entre `[min, max]` (ex: 40-200px)
  *Pega:* parceiro envia ícone 4000x4000 que estoura o layout do checkout.

- [ ] **`cssScope`** — CSS não escapa do escopo `[data-payment-template]`
  *Pega:* parceiro usa `body { background: red }` e quebra o checkout inteiro.

- [ ] **`requiredFiles`** — `html` + `i18n/{default}.json` + `icon` precisam estar presentes
  *Pega:* upload incompleto sem mensagem útil. Trivial de implementar.

- [ ] **Refinar `maxFileSize`** já existente:
  - Configurável via opts
  - Pega diferença entre "tamanho do arquivo individual" vs "soma total"
  - Mensagem aponta o ofensor

## Stretch (se sobrar tempo)

- [ ] Migrar o CLI `cli.js` existente pra usar a nova lib (em vez de chamar rules diretamente)
- [ ] Squad A consome a lib de verdade no `POST /upload` (substituir mock)
- [ ] Modo `--samples` que valida 1 template "bom" + 1 "ruim" pra cada rule (test fixture)
- [ ] Sugestão de fix na mensagem de erro ("seu i18n.es.json não tem `paymentData.title` que existe em pt-BR")
- [ ] Output `--sarif` (formato padrão de GitHub Code Scanning)

---

## Pontos de integração (alinhar no design contract — 0:10–0:15)

| Com quem | O que negociar |
|---|---|
| **Squad A** | Assinatura final de `validate()`. Síncrono ou async? Quais opts são essenciais pro MVP? Como Squad A consome (require relativo? symlink? cópia)? |
| **Squad A** | Qual rule é obrigatório no upload (bloqueante) vs warning (loga e deixa subir)? |

---

## Armadilhas já conhecidas (descobertas na validação prévia)

Vocês NÃO vão precisar consertar nada disso — só pra contexto:

- ⚠️ **CSS do parceiro usa `url('../../img/...')`.** Esses paths funcionam quando servidos pelo grunt do payment-mocker, mas quebram quando o handler serve do `mock-s3-bucket/`. Decisão de design: vira rule (`noRelativeBacktrack`) ou é responsabilidade do handler reescrever? Hoje, handler reescreve — vale documentar a decisão.
- ⚠️ **Dev environment vs template.** O payment-mocker é boilerplate de dev — tem `index.html` wrapper, `angular.min.js`, `checkout-style.css` mockado. Sem filtro, esses ~315KB de coisa-de-dev-env entram na conta da `maxFileSize` e falsificam o resultado. O `cli.js` atual tem uma lista `IGNORED_PATHS` — quando migrarem pra lib, mantenham (ou virem opção configurável).
- ⚠️ **Convenção de estrutura de pastas.** O payment-mocker tem `src/partials/payment.html`, mas cada parceiro pode organizar diferente. A lib precisa aceitar ou várias convenções, OU exigir uma fixa (e documentar). Hoje aceita várias — vale revisitar se isso vale a pena.
