// Registry de rules. Cada rule é uma função (template) => ValidationError[].
//
// TODO Squad B: adicionar as outras rules conforme implementadas
//   - allowedTags
//   - noExternalRefs
//   - assetsReferenced
//   - i18nKeysPresent

module.exports = [
  require('./maxFileSize'),
];
