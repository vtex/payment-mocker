const { run } = require('./runner');
const rules = require('./rules');

async function validate(templateDir, opts) {
  const errors = run(templateDir, rules, opts || {});
  return { ok: errors.length === 0, errors };
}

module.exports = { validate, rules };
