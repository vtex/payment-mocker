'use strict';

function formatRef(ref) {
  if (!ref || !ref.file) {
    return '';
  }

  if (ref.line == null) {
    return ref.file;
  }

  if (ref.column == null) {
    return ref.file + ':' + ref.line;
  }

  return ref.file + ':' + ref.line + ':' + ref.column;
}

function formatFinding(finding) {
  var location = formatRef(finding.ref);
  var prefix = '[' + finding.severity + '] ' + finding.rule;
  if (location) {
    prefix += ' ' + location;
  }
  return prefix + ' — ' + finding.message;
}

function countBySeverity(findings, severity) {
  var count = 0;
  for (var i = 0; i < findings.length; i += 1) {
    if (findings[i].severity === severity) {
      count += 1;
    }
  }
  return count;
}

function printValidationResult(result, options) {
  options = options || {};

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  var errorCount = countBySeverity(result.errors, 'error');
  var warningCount = countBySeverity(result.errors, 'warning');
  var suffix = options.suffix || '';

  if (result.ok) {
    var okMessage = 'validate: ok';
    if (warningCount) {
      okMessage += ' (' + warningCount + ' warning' + (warningCount === 1 ? '' : 's') + ')';
    }
    console.log(okMessage + suffix);

    for (var w = 0; w < result.errors.length; w += 1) {
      if (result.errors[w].severity === 'warning') {
        console.log('  ' + formatFinding(result.errors[w]));
      }
    }
    return;
  }

  var summary = 'validate: failed (' + errorCount + ' error' + (errorCount === 1 ? '' : 's');
  if (warningCount) {
    summary += ', ' + warningCount + ' warning' + (warningCount === 1 ? '' : 's');
  }
  summary += ')' + suffix;
  console.error(summary);

  for (var i = 0; i < result.errors.length; i += 1) {
    var finding = result.errors[i];
    var line = '  ' + formatFinding(finding);
    if (finding.severity === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

module.exports = {
  formatFinding,
  formatRef,
  printValidationResult,
};
