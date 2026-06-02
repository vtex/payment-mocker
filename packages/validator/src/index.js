const { run } = require('./runner');
const rules = require('./rules');

async function validate(templateDir, opts) {
  const { errors, details } = run(templateDir, rules, opts || {});
  const ok = errors.every(e => e.severity === 'warning');
  return { ok, errors, details };
}

module.exports = { validate, rules };
