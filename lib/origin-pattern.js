'use strict';

/**
 * Single source of truth for the origin shape accepted throughout this repo:
 * `scheme://host[:port]`, where host is either a plain hostname or an IPv6
 * literal in bracket notation (e.g. `[::1]`), each with an optional port.
 * `new URL(...).host` never includes a scheme, so this only ever needs to
 * match the host+port portion once combined with a scheme.
 *
 * Previously duplicated (as an identical, independently-maintained copy)
 * across lib/wrap-template.js and lib/preview-middleware.js — an earlier IPv6
 * bracket-notation fix landed in only one of the two copies, leaving the
 * other out of date. Centralizing it here removes that drift risk, the same
 * way lib/locale-tag.js does for the locale-tag regex.
 */
const ORIGIN_PATTERN = /^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(:\d{1,5})?$/;

module.exports = { ORIGIN_PATTERN };
