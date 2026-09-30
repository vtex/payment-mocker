# VTEX Payment Mocker

Authoring kit for **Payment Templates** — develop, preview, and validate payment method UI for VTEX Smart Checkout.

We recommend you read the [Guide to Design a Payment Method to VTEX Smart Checkout](https://docs.google.com/document/d/16JVEF6I5brdUl_zHpE6kUriVKuigycVUNEt20iPyoNI/edit#heading=h.qytoq9cybc2s).

## Features

* Local dev server with livereload
* Checkout shell preview with sandboxed iframe (same integration pattern as production)
* Template bundle validation via `@vtex/payment-templates-core`

## Quick start

```bash
npm i
grunt
```

`grunt` validates the configured bundle and starts the dev server either way — a failing bundle still gets a running preview, with the error reported in the terminal and as a banner in the checkout shell.

Open [http://localhost:8080/](http://localhost:8080/).

The dev server and livereload (port 35729) listen on loopback (`127.0.0.1`) only, so they're reachable from the same machine but not from other devices on the network, and port forwarding from a container or VM (e.g. `docker run -p 8080:8080`) won't reach them — run `grunt` directly on the machine whose browser you're using.

Re-run validation manually:

```bash
npm run validate:reference
```

Run the unit tests:

```bash
npm test
```

While the dev server runs, saving files under `template/` or `lib/` triggers validation again via Grunt watch.

## Template contract

- **Contract:** [template/CONTRACT.md](template/CONTRACT.md)
- **Reference example:** [template/reference/](template/reference/)
- **Preview config:** [template/preview.config.json](template/preview.config.json)

| Field | Purpose |
| --- | --- |
| `bundleDir` | Folder under `template/` with `index.html`, `style.css`, i18n files, and assets |
| `defaultLocale` | Fallback locale (upload field in production) |
| `icon` | Method icon file name, relative to `template/` (not the bundle folder — shown on the payment tab) |
| `displayName` | Labels for the payment-method tab in the checkout shell |
| `themeTokens` | Optional `--checkout-font-family`/`--checkout-border-radius` overrides forwarded into the wrapped container — see [template/CONTRACT.md](template/CONTRACT.md#theming-tokens) |

## Authoring workflow

When you run `grunt`, the server serves:

1. A **checkout shell** (`src/index.html`) that mimics the VTEX payment step.
2. Your **template bundle** from `template/<bundleDir>/`, wrapped and rendered inside a sandboxed iframe.

Edit the template files (livereload watches `template/` and `lib/`):

* `template/reference/index.html` — markup fragment (`data-i18n` keys)
* `template/reference/style.css` — styles (bundle-local assets only)
* `template/reference/asset-*` — raster images
* `template/reference/i18n-{locale}.json` — translations
* `template/preview.config.json` — `defaultLocale`, `icon`, `displayName`, `themeTokens`, and `bundleDir`

Use the language select at the top of the page to send `{ locale }` to the iframe. It lists the locales the bundle actually ships (one per `i18n-{locale}.json`), plus a `Default` option that uses `defaultLocale` from `template/preview.config.json`.

Copy `template/reference/` to a new folder and point `bundleDir` at it when starting a new payment method.

## Dependencies

1. [Node.js](http://nodejs.org/download) (≥ 18)
2. Grunt CLI: `npm i -g grunt-cli`

## Project layout

```
template/           Template bundles and preview config
src/                Checkout shell (static mock)
lib/                Preview middleware, bundle loading and config (the template wrap/runtime live in @vtex/payment-templates-core)
scripts/            Validation script
test/               Unit tests (node --test)
```
