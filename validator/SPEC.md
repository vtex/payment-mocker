# Spec: payment-mocker / validator (Squad B)

> **Squad:** B — Partner-side Validator CLI
> **Owner técnico do squad:** _<a definir no dojo>_
> **Owners de produto/UX/CX do squad:** _<a definir no dojo>_
> **Tempo de spec:** 15 min · **Tempo de impl:** 28 min

---

## 1. Business Context
*(2-4 frases. PM/CX/Designer lideram. Por que isso existe?)*

> **Seed (substitua/expanda):**
> Hoje o parceiro só descobre que o template falhou validação DEPOIS de abrir ticket pra VTEX. Cada ciclo de erro/correção adiciona 5–10 dias úteis ao tempo de release.
> Esta CLI dá ao parceiro o MESMO validador que roda no `payment-templates-handler`, pra ele pegar erros localmente antes de enviar — eliminando os ciclos.

## 2. Architecture Decisions

- **CLI standalone** invocada via `npm run validate -- ./src/`
- **Reusa as rules do Squad A** (cópia espelhada em `validator/rules/`, com sincronização manual)
- **Output em duas formas:** humano por padrão (com cores), `--json` pra integração em CI
- **Exit code 0/1** pra encaixar em pipelines (precommit hooks, GitHub Actions)
- **FORA DO ESCOPO MVP:**
  - Auto-fix (sugere correção e aplica)
  - Watch mode (re-roda em mudanças)
  - Configuração via `.validatorrc` ou similar

## 3. Technical Contract

### Inputs
- Argumento posicional: caminho pra diretório do template
- Estrutura esperada (compatível com payment-mocker):
  - `partials/payment.html` ou `payment.html` ou `index.html` (required)
  - `assets/css/less/style.css` ou `style.css`
  - `i18n/pt-BR.json` ou `i18n.json`
  - `assets/img/icon.png` ou `icon.png`
- Flag opcional: `--json`

### Outputs
- **Default:** relatório legível com ✓/✗ por rule, em pt-BR, com cores ANSI
- **`--json`:** `{ ok: boolean, errors: ValidationError[] }` no mesmo shape do Squad A

### Errors
```ts
type ValidationError = {
  rule: string;
  message: string;
  file?: string;
}
```

### Dependencies on other squads
- **Squad A (`payment-templates-handler`)** define o shape de `ValidationError` e implementa as MESMAS rules. As 2 implementações precisam ficar idênticas no spike — pós-dojo, considerar extrair pra módulo compartilhado.
- **Squad C (`vcs.checkout-ui`)** vai rodar este CLI contra o template deles antes de uploadar (parte do showcase).

---

## MVP (must-have ao fim de 28 min)
- [x] CLI lê diretório e roda `maxFileSize` *(pronto no skeleton)*
- [x] Output legível com cores ANSI + exit code correto *(pronto)*
- [x] Suporta convenção de paths do payment-mocker *(pronto)*
- [ ] **Implementar rule `allowedTags`** (espelhar com Squad A)
- [ ] **Suporte a `--json`** com `process.exit(1)` correto

## Stretch
- [ ] Pasta `validator/samples/` com 1 template "bom" + 1 "ruim" pra cada rule
- [ ] Mensagens de erro acionáveis (sugerem "como consertar")
- [ ] Sub-comando `npm run validate -- --samples` que roda todas as samples
- [ ] Watch mode (`--watch`)
- [ ] Discovery automático de assets em `assets/img/`

---

## Armadilhas já conhecidas (descobertas na validação prévia)

Vocês NÃO vão precisar consertar nada disso — só pra contexto:

- ⚠️ **CSS do parceiro usa `url('../../img/...')`.** Esses paths funcionam quando servidos pelo grunt do payment-mocker, mas quebram quando o handler serve do `mock-s3-bucket/`. Decisão de design: vira rule (`noRelativeBacktrack`) ou é responsabilidade do handler reescrever?
- ⚠️ **Convenção de estrutura de pastas.** O payment-mocker tem `src/partials/payment.html`, mas a doc diz que cada parceiro pode organizar diferente. Vale validar isso explicitamente ou aceitar várias convenções (como o skeleton faz hoje).
- ⚠️ **Dev environment vs template.** O payment-mocker é boilerplate de dev — tem `index.html` wrapper, `angular.min.js`, `checkout-style.css` mockado. Sem filtro, esses ~315KB de coisa-de-dev-env entram na conta da `maxFileSize` e falsificam o resultado. O skeleton já tem uma lista `IGNORED_PATHS` que cobre os arquivos óbvios — Squad B precisa decidir se essa lista vira hardcoded, `.validatorignore`, ou flag.
