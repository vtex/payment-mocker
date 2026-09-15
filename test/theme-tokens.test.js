'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FONT_FAMILY_TOKEN,
  BORDER_RADIUS_TOKEN,
  THEME_TOKEN_NAMES,
  sanitizeFontFamily,
  sanitizeBorderRadius,
  buildThemeTokenStyle,
} = require('../lib/theme-tokens');

test('the token set is closed and names both supported properties', () => {
  // A closed set is the point of the design: it is what makes the forwarded
  // surface auditable, versus handing over the store's whole stylesheet.
  assert.deepEqual(THEME_TOKEN_NAMES, ['--checkout-font-family', '--checkout-border-radius']);
});

test('sanitizeFontFamily folds the double quotes getComputedStyle emits into single quotes', () => {
  // The real-world value on an unstyled checkout. Rejecting it over the quote
  // character would drop the single most common input, so it is normalized:
  // both quotes are valid CSS delimiters, and `'` is inert inside the
  // double-quoted HTML attribute this lands in.
  assert.equal(
    sanitizeFontFamily('"Helvetica Neue", Helvetica, Arial, sans-serif'),
    "'Helvetica Neue', Helvetica, Arial, sans-serif"
  );
});

test('sanitizeFontFamily accepts the family names real stores use', () => {
  assert.equal(sanitizeFontFamily('Roboto, sans-serif'), 'Roboto, sans-serif');
  assert.equal(sanitizeFontFamily("'PT Sans', Arial, sans-serif"), "'PT Sans', Arial, sans-serif");
  assert.equal(sanitizeFontFamily('  Inter, sans-serif  '), 'Inter, sans-serif');
});

test('sanitizeFontFamily rejects a value that would end the declaration and start another', () => {
  assert.equal(sanitizeFontFamily('Roboto; position: fixed'), null);
});

test('sanitizeFontFamily rejects parentheses, closing the CSS exfiltration channel', () => {
  // A token may change what the document RENDERS, never what it FETCHES: no
  // `url()` may reach the declaration, whatever the merchant's sheet computed
  // to. img-src/style-src already scope fetches, so this is defense in depth.
  assert.equal(sanitizeFontFamily("Roboto, url('https://attacker.example/x')"), null);
});

test('sanitizeFontFamily rejects characters that would break out of the style attribute', () => {
  assert.equal(sanitizeFontFamily('Roboto" onmouseover="alert(1)'), null, 'the folded quote must not smuggle an attribute');
  assert.equal(sanitizeFontFamily('Roboto<script>'), null);
  assert.equal(sanitizeFontFamily('Roboto & Friends'), null, '& would need HTML escaping');
  assert.equal(sanitizeFontFamily('Roboto\\3b  x'), null, 'a CSS escape must not smuggle a semicolon back in');
});

test('sanitizeFontFamily rejects non-strings and absurdly long values', () => {
  assert.equal(sanitizeFontFamily(undefined), null);
  assert.equal(sanitizeFontFamily(null), null);
  assert.equal(sanitizeFontFamily(12), null);
  assert.equal(sanitizeFontFamily(''), null);
  assert.equal(sanitizeFontFamily('A'.repeat(201)), null);
});

test('sanitizeBorderRadius accepts a single length in the units a theme would use', () => {
  assert.equal(sanitizeBorderRadius('3px'), '3px');
  assert.equal(sanitizeBorderRadius('0.5rem'), '0.5rem');
  assert.equal(sanitizeBorderRadius('50%'), '50%');
  assert.equal(sanitizeBorderRadius(' 12px '), '12px');
});

test('sanitizeBorderRadius drops a zero radius so the bundle fallback survives', () => {
  // A zero radius is the absence of a theme, not a theme. Forwarding it would
  // override a partner's own `var(..., 4px)` with a square corner nobody asked
  // for — and zero is exactly what an uncustomized container computes to.
  assert.equal(sanitizeBorderRadius('0px'), null);
  assert.equal(sanitizeBorderRadius('0%'), null);
});

test('sanitizeBorderRadius rejects the multi-value shorthand and unitless or hostile input', () => {
  assert.equal(sanitizeBorderRadius('4px 8px'), null);
  assert.equal(sanitizeBorderRadius('4'), null);
  assert.equal(sanitizeBorderRadius('4px;color:red'), null);
  assert.equal(sanitizeBorderRadius('calc(1px + 2px)'), null);
});

test('buildThemeTokenStyle emits both declarations with a leading semicolon, in a fixed order', () => {
  const style = buildThemeTokenStyle({
    [BORDER_RADIUS_TOKEN]: '8px',
    [FONT_FAMILY_TOKEN]: 'Roboto, sans-serif',
  });
  // Order follows THEME_TOKEN_NAMES, not the input object, so the output is
  // stable regardless of how the caller assembled the map.
  assert.equal(style, ';--checkout-font-family:Roboto, sans-serif;--checkout-border-radius:8px');
});

test('buildThemeTokenStyle returns an empty string when nothing is themed', () => {
  // This is what keeps an untokenized document byte-identical to one built
  // before tokens existed — see the exact-string assertion in
  // test/wrap-template.test.js.
  assert.equal(buildThemeTokenStyle(undefined), '');
  assert.equal(buildThemeTokenStyle(null), '');
  assert.equal(buildThemeTokenStyle({}), '');
  assert.equal(buildThemeTokenStyle([]), '');
  assert.equal(buildThemeTokenStyle('Roboto'), '');
});

test('buildThemeTokenStyle drops only the invalid token, keeping the valid one', () => {
  // Per-token, and silent: at runtime these values come from whatever a
  // merchant's stylesheet computed to, and a template rendering with its own
  // fallback typography beats a template that refuses to render.
  const style = buildThemeTokenStyle({
    [FONT_FAMILY_TOKEN]: 'Roboto; position: fixed',
    [BORDER_RADIUS_TOKEN]: '3px',
  });
  assert.equal(style, ';--checkout-border-radius:3px');
});

test('buildThemeTokenStyle ignores names outside the closed set', () => {
  const style = buildThemeTokenStyle({ '--checkout-color': 'red', '--anything': '1px' });
  assert.equal(style, '');
});
