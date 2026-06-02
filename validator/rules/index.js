// Registry de rules. Cada rule é uma função (template) => ValidationError[].
//
// TODO Squad B: ao migrar pra @vtex/payment-template-validator,
// adicionar as rules novas do menu de MVP (SPEC.md):
//   Obrigatórias (3):
//   - i18nKeyConsistency: todos i18n/*.json têm o mesmo set de chaves
//   - htmlSafety: bloqueia <script> fora de whitelist, eval, on*= inline
//   - noExternalRefs: sem URLs externas em HTML/CSS (privacy + reliability + supply chain)
//   Adicionais (0-1):
//   - assetsReferenced, iconDimensions, cssScope, requiredFiles, ou refinar maxFileSize

module.exports = [
  require('./maxFileSize'),
];
