'use strict';

/**
 * `ref.line`/`ref.column` are optional on @vtex/payment-templates-core's
 * FindingRef — present for rules that parse markup (e.g. htmlSafety), absent
 * for whole-file rules (e.g. a missing i18n key). Each field is only ever
 * shown once the field before it is present, so a partial ref never prints a
 * misleading `:undefined`.
 */
function formatRef(ref) {
  if (!ref || !ref.file) return '';
  if (ref.line == null) return ref.file;
  if (ref.column == null) return ref.file + ':' + ref.line;
  return ref.file + ':' + ref.line + ':' + ref.column;
}

function formatFinding(finding) {
  const location = formatRef(finding.ref);
  const prefix = '[' + finding.severity + '] ' + finding.rule + (location ? ' ' + location : '');
  return prefix + ' — ' + finding.message;
}

function countBySeverity(findings, severity) {
  return findings.filter((finding) => finding.severity === severity).length;
}

function pluralize(count, noun) {
  return count + ' ' + noun + (count === 1 ? '' : 's');
}

/**
 * Prints a ValidateResult ({ ok, errors }) either as the raw JSON `validate()`
 * itself returns (for CI, `options.json`) or as a human-readable summary. The
 * summary always leads with an error/warning count so a bundle with only
 * warnings doesn't read as silently clean, then lists every finding with its
 * `rule` and `file:line:column` (as far as the finding's own `ref` reaches).
 */
function printValidationResult(result, options) {
  const opts = options || {};

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  const findings = result.errors || [];
  const errorCount = countBySeverity(findings, 'error');
  const warningCount = countBySeverity(findings, 'warning');
  const suffix = opts.suffix || '';

  if (result.ok) {
    let summary = 'validate: ok';
    if (warningCount) summary += ' (' + pluralize(warningCount, 'warning') + ')';
    console.log(summary + suffix);
    findings
      .filter((finding) => finding.severity === 'warning')
      .forEach((finding) => console.warn('  ' + formatFinding(finding)));
    return;
  }

  let summary = 'validate: failed (' + pluralize(errorCount, 'error');
  if (warningCount) summary += ', ' + pluralize(warningCount, 'warning');
  summary += ')' + suffix;
  console.error(summary);

  // Every finding goes to stderr, errors and warnings alike and in the order
  // validate() returned them — the same stream a passing run's warnings use
  // above, and the one every finding used before this formatter existed, so
  // `2> findings.txt` captures the whole report whether or not the run failed.
  findings.forEach((finding) => {
    const line = '  ' + formatFinding(finding);
    if (finding.severity === 'error') {
      console.error(line);
    } else {
      console.warn(line);
    }
  });
}

/**
 * The result reported when validation itself couldn't run — only reached if
 * the sanitizer that turns a load failure into a finding throws too, so
 * there's no message of its own to show. A fixed `load` finding, shaped like
 * any other, so `--json` consumers still get parseable stdout and an empty
 * stderr instead of free text on the wrong stream.
 */
const UNRUNNABLE_RESULT = {
  ok: false,
  errors: [{ rule: 'load', severity: 'error', message: 'Validation could not run.' }],
};

function printUnrunnableResult(options) {
  printValidationResult(UNRUNNABLE_RESULT, options);
}

module.exports = {
  UNRUNNABLE_RESULT,
  formatFinding,
  formatRef,
  printUnrunnableResult,
  printValidationResult,
};
