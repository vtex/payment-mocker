# VTEX Payment Mocker

Authoring kit for **Payment Templates** — develop, preview, and validate payment method UI for VTEX Smart Checkout.

We recommend you read the [Guide to Design a Payment Method to VTEX Smart Checkout](https://docs.google.com/document/d/16JVEF6I5brdUl_zHpE6kUriVKuigycVUNEt20iPyoNI/edit#heading=h.qytoq9cybc2s).

## Features

* Local dev server with livereload
* Checkout shell preview with sandboxed iframe (same integration pattern as production)
* Template bundle validation via `@vtex/payment-templates-validator`

## Quick start

```bash
npm i
grunt
```

Open [http://localhost:8080/](http://localhost:8080/).

Validate before submitting:

```bash
npm run validate:reference
```

## Template contract

- **Contract:** [template/CONTRACT.md](template/CONTRACT.md)
- **Reference example:** [template/reference/](template/reference/)
- **Preview config:** [template/preview.config.json](template/preview.config.json)

| Field | Purpose |
| --- | --- |
| `bundleDir` | Folder under `template/` with `index.html`, `style.css`, i18n files, and assets |
| `defaultLocale` | Fallback locale (upload field in production) |
| `icon` | Method icon file name inside the bundle folder (shown on the payment tab) |
| `displayName` | Labels for the payment-method tab in the checkout shell |

## Authoring workflow

When you run `grunt`, the server serves:

1. A **checkout shell** (`src/index.html`) that mimics the VTEX payment step.
2. Your **template bundle** from `template/<bundleDir>/`, wrapped and rendered inside a sandboxed iframe.

Edit the template files (livereload watches `template/` and `lib/`):

* `template/reference/index.html` — markup fragment (`data-i18n` keys)
* `template/reference/style.css` — styles (bundle-local assets only)
* `template/reference/asset-*` — raster images
* `template/reference/i18n-{locale}.json` — translations
* `template/preview.config.json` — `defaultLocale`, `icon`, `displayName`, and `bundleDir`

Use the language flags at the top of the page to send `{ locale }` to the iframe.

Copy `template/reference/` to a new folder and point `bundleDir` at it when starting a new payment method.

## Dependencies

1. [Node.js](http://nodejs.org/download) (≥ 18)
2. Grunt CLI: `npm i -g grunt-cli`

## Project layout

```
template/           Template bundles and preview config
src/                Checkout shell (static mock)
lib/                Template wrap and preview middleware
scripts/            Validation and asset helpers
```
