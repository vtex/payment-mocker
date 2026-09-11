'use strict';

/**
 * Single source of truth for the locale tag shape used throughout this repo:
 * a two-letter lowercase language code, a hyphen, and a two-letter uppercase
 * region code (e.g. `pt-BR`). Previously duplicated across preview-config.js,
 * wrap-template.js, and (as an embedded capture group) load-bundle.js — the
 * same class of drift that caused the IPv6 ORIGIN_PATTERN bug fixed in an
 * earlier round.
 */
const LOCALE_TAG_SOURCE = '[a-z]{2}-[A-Z]{2}';
const LOCALE_TAG = new RegExp('^' + LOCALE_TAG_SOURCE + '$');

function isValidLocaleTag(value) {
  return typeof value === 'string' && LOCALE_TAG.test(value);
}

module.exports = { LOCALE_TAG, LOCALE_TAG_SOURCE, isValidLocaleTag };
