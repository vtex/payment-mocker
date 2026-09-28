'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatRef, formatFinding, printValidationResult } = require('../lib/format-validation-output');

function captureOutput(t) {
  const calls = { log: [], warn: [], error: [], stdout: [] };
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    write: process.stdout.write,
  };
  console.log = (line) => calls.log.push(line);
  console.warn = (line) => calls.warn.push(line);
  console.error = (line) => calls.error.push(line);
  process.stdout.write = (chunk) => {
    calls.stdout.push(chunk);
    return true;
  };
  t.after(() => {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    process.stdout.write = originals.write;
  });
  return calls;
}

test('formatRef returns an empty string when there is no ref or no file', () => {
  assert.equal(formatRef(undefined), '');
  assert.equal(formatRef({}), '');
});

test('formatRef returns just the file when there is no line', () => {
  assert.equal(formatRef({ file: 'index.html' }), 'index.html');
});

test('formatRef returns file:line when there is no column', () => {
  assert.equal(formatRef({ file: 'index.html', line: 2 }), 'index.html:2');
});

test('formatRef returns file:line:column when all three are present', () => {
  assert.equal(formatRef({ file: 'index.html', line: 2, column: 1 }), 'index.html:2:1');
});

test('formatRef never prints a partial field as "undefined" (column without line)', () => {
  // A ref shaped { file, column } with no line is not a shape the validator
  // produces, but formatFinding must not crash or print "file:undefined:3" if
  // it ever did — line gates column, so this degrades to the file-only case.
  assert.equal(formatRef({ file: 'index.html', column: 3 }), 'index.html');
});

test('formatFinding combines severity, rule, location, and message', () => {
  const finding = {
    severity: 'error',
    rule: 'htmlSafety',
    message: 'Forbidden tag <script>',
    ref: { file: 'index.html', line: 2, column: 1 },
  };
  assert.equal(formatFinding(finding), '[error] htmlSafety index.html:2:1 — Forbidden tag <script>');
});

test('formatFinding omits the location entirely when the finding has no ref', () => {
  const finding = { severity: 'warning', rule: 'unusedAsset', message: 'asset-old.png is never referenced' };
  assert.equal(formatFinding(finding), '[warning] unusedAsset — asset-old.png is never referenced');
});

test('printValidationResult in json mode writes the raw result and nothing else', (t) => {
  const calls = captureOutput(t);
  const result = { ok: true, errors: [] };
  printValidationResult(result, { json: true });
  assert.deepEqual(calls.log, []);
  assert.deepEqual(calls.error, []);
  assert.equal(calls.stdout.length, 1);
  assert.equal(calls.stdout[0], JSON.stringify(result, null, 2) + '\n');
});

test('printValidationResult reports a clean pass with no warning noise', (t) => {
  const calls = captureOutput(t);
  printValidationResult({ ok: true, errors: [] }, { suffix: ' — template at template/reference' });
  assert.deepEqual(calls.log, ['validate: ok — template at template/reference']);
  assert.deepEqual(calls.warn, []);
});

test('printValidationResult reports warning count on an otherwise-passing bundle', (t) => {
  const calls = captureOutput(t);
  const result = {
    ok: true,
    errors: [{ severity: 'warning', rule: 'unusedAsset', message: 'unused', ref: { file: 'style.css' } }],
  };
  printValidationResult(result, {});
  assert.deepEqual(calls.log, ['validate: ok (1 warning)']);
  assert.deepEqual(calls.warn, ['  [warning] unusedAsset style.css — unused']);
});

test('printValidationResult reports error and warning counts on a failing bundle', (t) => {
  const calls = captureOutput(t);
  const result = {
    ok: false,
    errors: [
      { severity: 'error', rule: 'htmlSafety', message: 'Forbidden tag <script>', ref: { file: 'index.html', line: 2, column: 1 } },
      { severity: 'warning', rule: 'unusedAsset', message: 'unused', ref: { file: 'style.css' } },
    ],
  };
  printValidationResult(result, { suffix: ' — template at template/reference' });
  assert.deepEqual(calls.error, [
    'validate: failed (1 error, 1 warning) — template at template/reference',
    '  [error] htmlSafety index.html:2:1 — Forbidden tag <script>',
  ]);
  // A warning finding in a failing result still prints via console.log, not
  // console.error — only the error-severity findings go to stderr.
  assert.deepEqual(calls.log, ['  [warning] unusedAsset style.css — unused']);
});

test('printValidationResult pluralizes singular counts correctly', (t) => {
  const calls = captureOutput(t);
  const result = {
    ok: false,
    errors: [{ severity: 'error', rule: 'htmlSafety', message: 'bad', ref: { file: 'index.html' } }],
  };
  printValidationResult(result, {});
  assert.equal(calls.error[0], 'validate: failed (1 error)');
});
