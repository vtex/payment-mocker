const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { validate } = require('../index');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const CLI = path.join(REPO_ROOT, 'validator', 'cli.js');

// ─── helpers ───────────────────────────────────────────────────────────────

function makeTmpTemplate(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptv-'));
  for (const [rel, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return tmpDir;
}

const VALID_HTML = '<fieldset class="box-payment-group2"><h3>Pay</h3></fieldset>';
const VALID_I18N = JSON.stringify({ 'payment.title': 'Pagamento' });

// ─── US-3: validate() API (lib) ────────────────────────────────────────────

test('validate() — retorna ok:true para template válido', async () => {
  const dir = makeTmpTemplate({
    'partials/payment.html': VALID_HTML,
    'i18n/pt-BR.json': VALID_I18N,
    'i18n/en-US.json': JSON.stringify({ 'payment.title': 'Payment' }),
  });
  const result = await validate(dir);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('validate() — retorna ok:false para template com erro de maxFileSize', async () => {
  const bigContent = Buffer.alloc(200 * 1024, 'x');
  const dir = makeTmpTemplate({
    'partials/payment.html': VALID_HTML,
    'big.bin': bigContent,
  });
  const result = await validate(dir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.rule === 'maxFileSize'));
});

test('validate() — retorna ok:false para i18n inconsistente', async () => {
  const dir = makeTmpTemplate({
    'partials/payment.html': VALID_HTML,
    'i18n/pt-BR.json': JSON.stringify({ a: '1', b: '2' }),
    'i18n/es.json': JSON.stringify({ a: 'Alpha' }),
  });
  const result = await validate(dir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.rule === 'i18nKeyConsistency'));
});

test('validate() — retorna ok:false para HTML com script externo', async () => {
  const dir = makeTmpTemplate({
    'partials/payment.html': '<div><script src="https://evil.com/x.js"></script></div>',
  });
  const result = await validate(dir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.rule === 'htmlSafety' || e.rule === 'noExternalRefs'));
});

test('validate() — retorna ok:false para HTML com onclick inline', async () => {
  const dir = makeTmpTemplate({
    'partials/payment.html': '<button onclick="evil()">Pagar</button>',
  });
  const result = await validate(dir);
  assert.ok(result.errors.some(e => e.rule === 'htmlSafety'));
});

test('validate() — retorna ok:false para URL externa em CSS', async () => {
  const dir = makeTmpTemplate({
    'partials/payment.html': VALID_HTML,
    'style.css': 'div { background: url("https://cdn.com/img.png"); }',
  });
  const result = await validate(dir);
  assert.ok(result.errors.some(e => e.rule === 'noExternalRefs'));
});

test('validate() — opts.maxFileSize sobrescreve limite padrão', async () => {
  const dir = makeTmpTemplate({
    'partials/payment.html': VALID_HTML,
    'small.bin': Buffer.alloc(5 * 1024, 'x'),
  });
  const result = await validate(dir, { maxFileSize: 1 * 1024 });
  assert.ok(result.errors.some(e => e.rule === 'maxFileSize'));
});

// ─── US-1: CLI com template default de src/ ────────────────────────────────

test('CLI — src/ do payment-mocker passa em todas as validações (exit 0)', () => {
  const out = execSync(`node "${CLI}" "${SRC_DIR}"`, { encoding: 'utf8' });
  assert.match(out, /passou em todas as validações/);
});

// ─── US-2: CLI com --json ──────────────────────────────────────────────────

test('CLI --json — retorna JSON ok:true para template válido', () => {
  const out = execSync(`node "${CLI}" "${SRC_DIR}" --json`, { encoding: 'utf8' });
  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.errors));
});

test('CLI --json — retorna JSON ok:false para template inválido (exit 1)', () => {
  const bigContent = Buffer.alloc(200 * 1024, 'x');
  const dir = makeTmpTemplate({
    'partials/payment.html': VALID_HTML,
    'big.bin': bigContent,
  });

  let threw = false;
  try {
    execSync(`node "${CLI}" "${dir}" --json`, { encoding: 'utf8' });
  } catch (err) {
    threw = true;
    assert.equal(err.status, 1);
    const result = JSON.parse(err.stdout);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  }
  assert.ok(threw, 'CLI deveria ter retornado exit 1');
});

test('CLI — exit 2 quando diretório não existe', () => {
  let threw = false;
  try {
    execSync(`node "${CLI}" /tmp/nao-existe-ptv-xyzabc`, { encoding: 'utf8' });
  } catch (err) {
    threw = true;
    assert.equal(err.status, 2);
  }
  assert.ok(threw);
});

test('CLI — exit 2 quando nenhum argumento passado', () => {
  let threw = false;
  try {
    execSync(`node "${CLI}"`, { encoding: 'utf8' });
  } catch (err) {
    threw = true;
    assert.equal(err.status, 2);
  }
  assert.ok(threw);
});
