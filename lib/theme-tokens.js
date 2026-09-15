'use strict';

/**
 * Theming tokens — the CLOSED set of CSS custom properties the checkout host
 * may forward into the payment template document.
 *
 * Why tokens rather than the store's stylesheet: a template renders in a
 * sandboxed iframe with an opaque origin, so CSS inheritance stops at the
 * boundary and the store's sheet cannot reach in. Forwarding the whole sheet
 * would fix that by handing partner-controlled space an unvalidated, merchant-
 * authored payload; forwarding two named values keeps the surface auditable.
 *
 * Deliberately absent: a brand/primary color. The template is the payment
 * method's own surface (Pix green is not the merchant's to repaint), and an
 * arbitrary color produces contrast pairings the partner never tested.
 *
 * KNOWN LIMIT, and the reason `font-family` is a name and not a file: the CSP
 * this document carries is `default-src 'none'` with no `font-src`, and the
 * bundle itself may not reference external URLs (the validator's
 * `noExternalRefs` rule). So `@font-face` cannot load inside the iframe, and a
 * forwarded family name only renders where that font is already installed on
 * the device. Serving a merchant's brand webfont would additionally require
 * opening `font-src` to their asset host — a separate decision, not implied by
 * this module.
 *
 * Parity: `vcs.checkout-ui/src/script/payment/payment-template-document.js`
 * carries an ES5 twin of the two patterns and of buildThemeTokenStyle. Mirror
 * any change there (the same standing note applies as for wrap-template.js).
 */

const FONT_FAMILY_TOKEN = '--checkout-font-family';
const BORDER_RADIUS_TOKEN = '--checkout-border-radius';

// Order fixes the declaration order in the emitted style attribute, which is
// what lets the tests assert on an exact string.
const THEME_TOKEN_NAMES = [FONT_FAMILY_TOKEN, BORDER_RADIUS_TOKEN];

/**
 * Applied AFTER `"` is folded to `'` (see sanitizeFontFamily), so the quote
 * character is absent from the allowed set on purpose rather than by omission.
 *
 * Every character this rejects is rejected for a concrete reason, and the set
 * is what makes interpolation into `style="..."` safe without a second
 * escaping layer:
 *
 * - `;` would end the custom property and start a new declaration.
 * - `(` `)` would allow `url(...)`, the CSS exfiltration channel — the token
 *   must be able to change what the document RENDERS, never what it FETCHES.
 * - `"` `<` `>` `&` would break out of, or forge markup in, the HTML attribute
 *   the value is interpolated into.
 * - `\` would let a CSS escape sequence smuggle any of the above back in.
 *
 * What survives is exactly what a font stack needs: family names, the comma
 * separators, single quotes around multi-word names, and the hyphens, dots and
 * digits real family names carry (`Helvetica Neue`, `PT Sans`, `Roboto Slab`).
 */
const FONT_FAMILY_PATTERN = /^[A-Za-z0-9 ,._'-]{1,200}$/;

/**
 * A single length, not the 1-to-4-value shorthand. The token expresses "the
 * store's corner radius", and one value says that; accepting the full grammar
 * would widen the surface for no theming gain.
 */
const BORDER_RADIUS_PATTERN = /^\d{1,3}(?:\.\d{1,3})?(?:px|rem|em|%)$/;

/**
 * @param {*} value typically `getComputedStyle(...).fontFamily`
 * @returns {string|null} a safe declaration value, or null to omit the token
 */
function sanitizeFontFamily(value) {
  if (typeof value !== 'string') {
    return null;
  }
  // getComputedStyle quotes multi-word families with `"` (`"Helvetica Neue",
  // Helvetica, Arial, sans-serif`). Folding to `'` keeps those families usable
  // instead of rejecting the most common real-world value: both quote
  // characters are valid CSS string delimiters, and `'` is inert inside the
  // double-quoted HTML attribute this lands in.
  const normalized = value.replace(/"/g, "'").trim();
  return FONT_FAMILY_PATTERN.test(normalized) ? normalized : null;
}

/**
 * @param {*} value typically `getComputedStyle(...).borderTopLeftRadius`
 * @returns {string|null} a safe declaration value, or null to omit the token
 */
function sanitizeBorderRadius(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if (!BORDER_RADIUS_PATTERN.test(normalized)) {
    return null;
  }
  // A zero radius is not a theme, it is the absence of one. Emitting it would
  // override the bundle's own `var(..., 4px)` fallback with a square corner
  // the merchant never asked for, so drop it and let the fallback stand.
  return parseFloat(normalized) === 0 ? null : normalized;
}

const SANITIZERS = {
  [FONT_FAMILY_TOKEN]: sanitizeFontFamily,
  [BORDER_RADIUS_TOKEN]: sanitizeBorderRadius,
};

/**
 * Builds the custom-property declarations to append to the root container's
 * `style` attribute, INCLUDING the leading `;` when non-empty.
 *
 * Invalid or unknown input is dropped, per token, rather than throwing — which
 * is the opposite of how this repo treats malformed locales or origins, and the
 * asymmetry is intentional. Those are contract violations by the caller; a
 * token value is whatever a merchant's stylesheet happened to compute to, and
 * a template that renders with its own fallback typography is a far better
 * outcome than a template that does not render at all.
 *
 * Returns '' when nothing survives, so a document with no theming is
 * byte-identical to one built before tokens existed.
 *
 * @param {*} tokens map of token name → raw value
 * @returns {string}
 */
function buildThemeTokenStyle(tokens) {
  if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) {
    return '';
  }

  const declarations = [];
  for (const name of THEME_TOKEN_NAMES) {
    const value = SANITIZERS[name](tokens[name]);
    if (value !== null) {
      declarations.push(name + ':' + value);
    }
  }

  return declarations.length === 0 ? '' : ';' + declarations.join(';');
}

module.exports = {
  FONT_FAMILY_TOKEN,
  BORDER_RADIUS_TOKEN,
  THEME_TOKEN_NAMES,
  sanitizeFontFamily,
  sanitizeBorderRadius,
  buildThemeTokenStyle,
};
