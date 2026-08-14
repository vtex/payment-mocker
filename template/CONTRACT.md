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
| `i18n-{locale}.json` | Yes (≥1) | Flat or nested JSON map of translation keys per locale. File name must use a full language–region tag (`xx-XX`), e.g. `i18n-pt-BR.json`, `i18n-en-US.json`. Language-only tags such as `i18n-pt.json` are rejected. |
| `defaultLocale` | Yes | Upload field (not a file) naming the fallback locale. Must match one of your `i18n-{locale}.json` files. When the shopper locale has no exact match, checkout resolves to this locale. |
| `icon` | No | Method icon shown in the payment list. PNG, JPEG, or WebP only. Max **50 KB**. Fits a **160×160 px** box; smallest side ≥ **60 px**. Stored separately from the versioned bundle. |
| `displayName-{locale}` | No | Plain-text label for the payment method in the list, one field per locale (e.g. `displayName-pt-BR`). Rendered as text, never HTML. Max **90** Unicode code points. No control or bidi override characters. |

## Internationalization

### Locale tags

Every locale identifier — file names, `defaultLocale`, and `displayName` keys — must match:

```
^[a-z]{2}-[A-Z]{2}$
```

Examples: `pt-BR`, `en-US`, `es-AR`. Tags like `pt` or `zh-Hant-TW` are not accepted.

### Translation keys

1. Add `data-i18n="<key>"` on elements whose text should translate (e.g. `data-i18n="pay.title"`).
2. Define the same keys in **every** `i18n-{locale}.json` file.
3. Keys may be nested in JSON (`{ "pay": { "title": "…" } }`) or flat (`{ "pay.title": "…" }`).

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

## Validation

Install dependencies from the repository root, then run:

```bash
npm run validate:reference
```

This runs `@vtex/payment-templates-validator` against the bundle configured in `template/preview.config.json`. A passing run prints `ok: true`.

Local validation is for feedback only. VTEX runs the same validator on upload before anything is published.

## Local preview

```bash
grunt
```

Open [http://localhost:8080/](http://localhost:8080/). The payment step renders your bundle in an iframe with `sandbox="allow-scripts"`, applies translations from the wrapped document, resizes on content changes, and accepts locale switches via `postMessage` — matching the checkout host contract.

Configure `bundleDir`, `defaultLocale`, optional `icon`, and optional `displayName` in [`preview.config.json`](./preview.config.json).

Example:

```json
{
  "bundleDir": "reference",
  "defaultLocale": "pt-BR",
  "icon": "asset-logo.png",
  "displayName": {
    "pt-BR": "Example Pay",
    "en-US": "Example Pay"
  }
}
```

Change `icon` to any raster file in your bundle folder; the checkout shell preview updates on reload.

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
- `defaultLocale = pt-BR` (set in the validation script and documented above)

Use it as the canonical starting point for new templates.
