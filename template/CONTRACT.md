# Payment template contract

This document defines the file contract for a **Payment Template** — the bundle partners author and deliver for publication in VTEX Smart Checkout.

Copy the [`reference/`](./reference/) folder as a starting point. It is a complete, valid example you can validate locally before submission.

## Bundle layout

A template is a flat folder of files. Use the exact names below.

| File / field | Required | Description |
| --- | --- | --- |
| `index.html` | Yes | Markup fragment shown inside the checkout iframe. Translatable text uses `data-i18n="<key>"`. No author `<script>` tags. No external URLs. |
| `style.css` | Yes | Styles for the template. Reference bundle assets only, e.g. `url(./asset-logo.png)` or `url(asset-logo.png)`. |
| `asset-*` | No | Raster images (PNG, JPEG, or WebP) referenced from HTML or CSS. Name every file `asset-<label>.<ext>`. |
| `i18n-{locale}.json` | Yes (≥1) | Nested JSON map of translation keys per locale. File name must use a full language–region tag (`xx-XX`), e.g. `i18n-pt-BR.json`, `i18n-en-US.json`. Language-only tags such as `i18n-pt.json` are rejected. |
| `defaultLocale` | Yes | Upload field (not a file) naming the fallback locale. Must match one of your `i18n-{locale}.json` files. When the shopper locale has no exact match, checkout resolves to this locale. |
| `icon` | No | Method icon shown in the payment list. PNG, JPEG, or WebP only. Max **50 KB**. Fits a **160×160 px** box; smallest side ≥ **60 px**. Stored separately from the versioned bundle. |
| `displayName-{locale}` | No | Plain-text label for the payment method in the list, one field per locale (e.g. `displayName-pt-BR`). Rendered as text, never HTML. Max **90** Unicode code points. No control or bidi override characters. |

In production upload, `displayName-{locale}` fields are flat, one per locale. In the local `preview.config.json` (development only, see "Local preview" below), the same data is represented as a single nested `displayName` object with one key per locale.

## Internationalization

### Locale tags

Every locale identifier — file names, `defaultLocale`, and `displayName` keys — must match:

```
^[a-z]{2}-[A-Z]{2}$
```

Examples: `pt-BR`, `en-US`, `es-AR`. Tags like `pt` or `zh-Hant-TW` are not accepted.

When a shopper's language matches more than one candidate locale and none of them is `defaultLocale`, the candidate whose tag sorts first alphabetically wins the tie-break.

### Translation keys

1. Add `data-i18n="<key>"` on elements whose text should translate (e.g. `data-i18n="pay.title"`).
2. Define the same keys in **every** `i18n-{locale}.json` file.
3. Keys are nested in JSON (`{ "pay": { "title": "…" } }`).

### `defaultLocale` fallback

Set `defaultLocale` to the locale you want when the shopper language does not match any file exactly.

Example with `defaultLocale = pt-BR` and files `i18n-pt-BR.json`, `i18n-en-US.json`:

| Shopper locale | Resolved template locale |
| --- | --- |
| `pt-BR` | `pt-BR` (exact match) |
| `en-US` | `en-US` (exact match) |
| `pt` (language only) | `pt-BR` (matches language; `defaultLocale` wins when several locales share the language) |
| `fr-FR` | `pt-BR` (fallback) |

The reference template documents this behavior in the `pay.fallbackNote` string.

## HTML constraints

Only a fixed set of HTML elements is allowed (headings, sections, lists, tables, `img`, inline SVG subset, etc.). Interactive form controls (`input`, `button`, `select`, …) are **not** allowed — templates are display-only inside a sandboxed iframe.

Forbidden in all cases:

- `<script>`, `<iframe>`, `<object>`, `<embed>`
- Inline event handlers (`onclick`, `onload`, …)
- `javascript:` URLs
- External references (`https://…`, `//…`, `data:…`)

## CSS constraints

- Every class selector in `style.css` must appear on an element in `index.html`.
- Every `asset-*` file you submit must be referenced at least once in HTML or CSS.
- Do not define selectors for classes that are never used in the markup.

## Responsive layout

Use `@media`. Your template is self-contained: it gets no layout signal from checkout and needs none.

Because the template renders in a sandboxed iframe, a width query measures **that iframe** rather than the shopper's screen. This is the useful measurement — it is the box checkout granted you, and the only width your layout depends on. It updates as the box does, so the queries stay correct on resize and on rotation.

Pick thresholds by the width at which **your own content stops fitting**, not by copying checkout's breakpoints. Checkout splits on the shopper's viewport at 768 px; that number means nothing inside your iframe. For reference, the widths checkout currently grants a template are:

| Shopper viewport | Width your template receives |
| --- | --- |
| ≥ 980 px | 409 px |
| 768–979 px | 462 px |
| < 768 px | fills the column — about 306 px on a 390 px phone |

Note the middle row: a phone held sideways gives your template *more* room than a desktop does. Width is not a proxy for device, so do not treat it as one — lay out for the space, and both cases land somewhere sensible.

```css
/* Side by side while both columns fit, stacked once they do not. */
.pay__benefits {
  display: flex;
  gap: 12px;
}

@media (max-width: 379px) {
  .pay__benefits {
    display: block;
  }
}
```

Only the dimensional media features (`width`, `height`, `aspect-ratio`, `orientation`) are scoped to the iframe. Everything describing the device or the shopper's preferences reaches you unchanged, so `@media (pointer: coarse)`, `(prefers-reduced-motion)` and `(prefers-color-scheme)` all work as they would on a top-level page.

## Size and type limits

| Item | Limit |
| --- | --- |
| Whole template bundle (HTML + CSS + assets + i18n) | ≤ **1 MB** |
| `index.html` | ≤ **128 KB** |
| `style.css` | ≤ **128 KB** |
| Each `asset-*` | ≤ **256 KB** |
| Each `i18n-{locale}.json` | ≤ **64 KB** |
| Icon (optional) | ≤ **50 KB** |

Images are verified by file content (magic bytes), not by extension. SVG **files** are not allowed; inline `<svg>` markup in HTML is permitted within the HTML allow list.

The local preview also clamps the iframe's rendered height to a maximum of **2000 px** (and a minimum of 40 px) — see `clampHeight` in `src/assets/libs/template-host.js`. This is a display behavior of the local preview server only; it is not a rule `npm run validate:reference` (or the upload-time validator) checks.

## Validation

Install dependencies from the repository root, then run:

```bash
npm run validate:reference
```

This runs `@vtex/payment-templates-validator` against the bundle configured in `template/preview.config.json`. A passing run prints `validate: ok — template at template/<bundleDir> passed all applicable rules.`

Local validation is for feedback only. VTEX runs the same validator on upload before anything is published.

## Local preview

```bash
grunt
```

Open [http://localhost:8080/](http://localhost:8080/). `grunt` runs `@vtex/payment-templates-validator` on your bundle before starting the server; fix reported errors, then preview.

The payment step renders your bundle in an iframe with `sandbox="allow-scripts"`, applies translations from the wrapped document, resizes on content changes, and accepts locale switches via `postMessage` — matching the checkout host contract.

Images inside the iframe may use bundle-local files. Inline SVG in CSS `url(data:…)` is not supported.

Configure `bundleDir`, `defaultLocale`, optional `icon`, and optional `displayName` in [`preview.config.json`](./preview.config.json).

Example:

```json
{
  "bundleDir": "reference",
  "defaultLocale": "pt-BR",
  "icon": "icon.png",
  "displayName": {
    "pt-BR": "Example Pay",
    "en-US": "Example Pay"
  }
}
```

`icon` is a path relative to `template/` (this directory), not to the bundle folder — matching "stored separately from the versioned bundle" above. Change it to any raster file placed directly under `template/`; the checkout shell preview updates on reload.

## Submitting a template

Deliver the bundle folder to your VTEX partnership contact together with:

- `defaultLocale` (required)
- Optional `icon` file
- Optional `displayName-{locale}` fields for each locale you support

Do not rename `index.html` or `style.css`. Keep asset names stable and referenced.

## Reference example

The [`reference/`](./reference/) directory contains:

- `index.html` with `data-i18n` on all user-visible strings
- `style.css` with bundle-local asset references
- `asset-logo.png` and `asset-badge.png`
- `i18n-pt-BR.json` and `i18n-en-US.json` with matching keys
- `defaultLocale = pt-BR` (set in `preview.config.json` and documented above)

Use it as the canonical starting point for new templates.
