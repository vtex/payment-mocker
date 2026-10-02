'use strict';

const fs = require('fs');
const path = require('path');
const { ORIGIN_PATTERN } = require('@vtex/payment-templates-core/wrap');

const BUNDLE_PREFIX = '/template-bundle/';
const ICON_PREFIX = '/template-icon/';
const PREVIEW_CONFIG_PATH = '/preview.config.json';
// Reports the validator's findings for the currently configured bundle as
// JSON, without ever blocking the wrapped preview on them (see
// serveWrappedIndex below). src/assets/libs/template-host.js fetches this
// once per page load (boot()'s loadTemplateValidation(), not a poll) to
// render a banner above the payment box instead, so the dev can keep looking
// at the template they're building while they fix the errors on their own
// schedule — the banner catches up on the next full-page reload, which is
// also why Gruntfile.js's livereload options (liveCSS/liveImg: false) always
// fall through to one instead of a partial DOM patch.
const TEMPLATE_VALIDATION_PATH = '/template-validation.json';
// Serves @vtex/payment-templates-core/wrap/resolve-locale.js verbatim (see
// serveResolveLocaleScript below) to two consumers: the checkout shell mock
// (src/assets/libs/template-host.js), which runs in the host page, and the
// wrapped iframe document, which loads it as the first of its two
// <script src> tags. One shared file instead of divergent copies of the
// algorithm — resolve-locale.js itself no longer lives in this repo's lib/,
// only this route path (kept stable for both consumers above) does.
const RESOLVE_LOCALE_SCRIPT_PATH = '/lib/resolve-locale.js';
// Serves @vtex/payment-templates-core/wrap/template-runtime.js verbatim (see
// serveTemplateRuntimeScript below) as the wrapped document's second script
// tag. Keeping the runtime a real, servable file (rather than a string a Node
// module builds) is what lets vcs.checkout-ui vendor a byte-for-byte copy and
// diff the two in CI — template-runtime.js itself no longer lives in this
// repo's lib/, only this route path does.
const TEMPLATE_RUNTIME_SCRIPT_PATH = '/lib/template-runtime.js';

// Editing THIS file (preview-middleware.js itself — its routing, the Host
// check, CSP building, sanitizeErrorMessage, ...) while grunt is running
// still needs a restart: Gruntfile.js requires it exactly once, at startup,
// to build the middleware function connect's option array holds onto for the
// server's whole lifetime, and nothing re-requires it or re-invokes
// createPreviewMiddleware() on any later request the way loadBundle()/
// readPreviewConfig() below do for the four modules invalidateWrapCache
// names. Only edits to those four modules take effect live.
function invalidateWrapCache() {
  [
    // wrap-template.js, locale-tag.js, origin-pattern.js and theme-tokens.js
    // moved to @vtex/payment-templates-core/wrap (see the RFC in that repo) —
    // that module is not local source under active edit, so it has nothing to
    // invalidate here. template-runtime.js and resolve-locale.js are streamed
    // from the package's dist/ on every request (see serveResolveLocaleScript
    // / serveTemplateRuntimeScript below), never require()d, so neither has a
    // require.cache entry either.
    './load-bundle.js',
    './preview-config.js',
    './path-contained.js',
    './validation-input.js',
  ].forEach(function (modulePath) {
    try {
      const resolvedId = require.resolve(modulePath);
      delete require.cache[resolvedId];
      // Deleting the cache entry above is not enough on its own: require()
      // also unconditionally pushes the freshly loaded Module onto this
      // file's own `module.children`, with no dedup and nothing that ever
      // removes an old entry. This function runs on nearly every request, so
      // without this, every invalidate+require cycle left one more discarded
      // Module object (and everything it in turn references) reachable
      // forever through this file's module.children, even though nothing
      // could reach it through require.cache anymore — an unbounded leak for
      // a long-running dev server. Splicing out the stale entry before the
      // caller re-requires keeps at most one live child per module path.
      for (let i = module.children.length - 1; i >= 0; i--) {
        if (module.children[i].id === resolvedId) module.children.splice(i, 1);
      }
    } catch (error) {
      // Module may not be loaded yet.
    }
  });
}

function loadBundle(bundleDir) {
  invalidateWrapCache();
  return require('./load-bundle').loadBundle(bundleDir);
}

function isAllowedBundleFilename(name) {
  invalidateWrapCache();
  return require('./load-bundle').isAllowedBundleFilename(name);
}

function toValidationBundle(bundle, defaultLocale) {
  return require('./load-bundle').toValidationBundle(bundle, defaultLocale);
}

function buildValidationInput(config, template, templateRoot) {
  return require('./validation-input').buildValidationInput(config, template, templateRoot);
}

function finishValidationResult(result, input, extraFindings) {
  return require('./validation-input').finishValidationResult(result, input, extraFindings);
}

function readPreviewConfig(templateRoot) {
  invalidateWrapCache();
  return require('./preview-config').readPreviewConfig(templateRoot);
}

function defaultTemplateRoot() {
  invalidateWrapCache();
  return require('./preview-config').TEMPLATE_ROOT;
}

function isPathContained(root, target) {
  invalidateWrapCache();
  return require('./path-contained').isPathContained(root, target);
}

// normalizeIndexPath and isAllowedIconFilename live in path-contained.js and
// preview-config.js (see each one's own docblock) so lib/validation-input.js
// can share them with the icon route instead of keeping its own copy.
function normalizeIndexPath(relativePath) {
  invalidateWrapCache();
  return require('./path-contained').normalizeIndexPath(relativePath);
}

function isAllowedIconFilename(icon) {
  invalidateWrapCache();
  return require('./preview-config').isAllowedIconFilename(icon);
}

function wrapTemplate(bundle, defaultLocale, origin, themeTokens) {
  invalidateWrapCache();
  return require('@vtex/payment-templates-core/wrap').wrapTemplate(bundle, defaultLocale, origin, themeTokens);
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

const PROTOCOL_PATTERN = /^https?$/;
// ORIGIN_PATTERN itself lives in @vtex/payment-templates-core/wrap (shared
// with that package's own wrap-template.js) — see the import above and that
// module's docblock for why it accepts either a plain hostname or an IPv6
// literal in bracket notation (e.g. `[::1]`), each with an optional port.

function requestProtocol(req) {
  const forwarded = req.headers && req.headers['x-forwarded-proto'];
  const candidate = forwarded
    ? String(forwarded).split(',')[0].trim()
    : req.socket && req.socket.encrypted
    ? 'https'
    : 'http';
  return PROTOCOL_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * Builds the preview server's own origin from request headers, for use as the
 * wrapped document's CSP style-src/img-src. Both the protocol and the fully
 * assembled origin are validated: `Host` and `x-forwarded-proto` are
 * attacker-controlled headers, and interpolating them unvalidated into the
 * CSP meta tag lets a crafted header value break out of the `content="..."`
 * attribute (or smuggle a bogus scheme into the CSP) and inject executable
 * markup. Returning `undefined` on any mismatch makes wrapTemplate fall back
 * to `'self'`, per its existing design.
 */
function requestOrigin(req) {
  if (!req.headers || !req.headers.host) return undefined;
  const protocol = requestProtocol(req);
  if (!protocol) return undefined;
  const origin = protocol + '://' + req.headers.host;
  return ORIGIN_PATTERN.test(origin) ? origin : undefined;
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * True only for a `Host` header naming this machine itself. Gruntfile.js
 * binds the literal `hostname: '127.0.0.1'` (loopback only, not every
 * interface — a literal IP rather than the name 'localhost', which resolved
 * to IPv6-only on the machine this was verified on, leaving 127.0.0.1 itself
 * unreachable) for both `connect` and the livereload server, which is what
 * actually keeps a
 * non-browser client on the LAN — curl, a script, another program — from
 * reaching this dev server at all: `Host` is just a request header, not a
 * property of which interface a connection arrived on, so a check here alone
 * could never tell such a client's `Host: localhost` apart from a real local
 * request.
 *
 * What this check adds on top of that binding: DNS rebinding. A browser page
 * whose hostname a DNS answer later points at loopback still physically
 * reaches this server (the socket accepts any connection arriving over
 * loopback, whatever hostname resolved there), but sends the hostname it
 * navigated to as `Host`, not `localhost` — a page's own script can never
 * set that header itself (fetch/XHR both refuse to; it's one of the fixed
 * set of headers only the browser's own navigation controls). Rejecting a
 * non-local `Host` here is what stops that case, which the network-level
 * binding alone does not.
 *
 * IPv6 hostnames arrive bracketed (`[::1]:8080`), so the port suffix is
 * stripped by locating the closing bracket rather than splitting on `:` —
 * naively splitting on the first `:` would cut a bracket-less IPv6 literal to
 * pieces, though `Host` headers use the bracketed form exactly to avoid that
 * ambiguity in the first place.
 *
 * `'[::1]'` is accepted here even though Gruntfile.js's literal
 * `'127.0.0.1'` bind (see above) means `.listen()` only accepts IPv4
 * connections, so a request actually arriving with this Host is currently
 * unreachable in practice — kept for whenever that binds dual-stack instead,
 * rather than silently going stale the way the surrounding claims about this
 * check did the first time Gruntfile.js's binding changed.
 */
function isLocalHostname(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;
  const hostname = hostHeader[0] === '[' ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

function serveWrappedIndex(config, req, res) {
  // Deliberately does NOT gate on validate() here: an author actively editing
  // a bundle is very often mid-edit, and blocking the preview on every rule
  // violation meant they couldn't see what they were building until it was
  // fully fixed. Validation still runs — see serveTemplateValidation below —
  // but only to inform the banner the host page renders, never to withhold
  // the render itself. loadBundle can still throw synchronously (e.g. a file
  // name outside the contract, which leaves nothing to render at all), so
  // this stays wrapped in a promise chain with a single .catch that never
  // lets a synchronous throw escape as an uncaught exception or leak a stack
  // trace/absolute filesystem path back to the client.
  Promise.resolve()
    .then(function () {
      const bundle = loadBundle(config.bundlePath);
      // `themeTokens` is optional and normally absent: production derives these
      // values from the live checkout DOM, which the preview has no equivalent
      // of, so here they are declared by hand to exercise the tokenized branch.
      const html = wrapTemplate(bundle, config.defaultLocale, requestOrigin(req), config.themeTokens);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      // Defense in depth: the isolation this document actually relies on is
      // the parent checkout shell's `<iframe sandbox="allow-scripts">`
      // attribute (src/assets/libs/template-host.js), which only applies when
      // this response is loaded *as* that iframe. This same URL is also
      // reachable directly, as a top-level navigation — Gruntfile.js binds
      // the dev server to loopback only now, but that still includes every
      // browser tab and local process on this machine, none of which goes
      // through the iframe attribute above. A `sandbox` directive can only be
      // delivered via this header, never via the
      // wrapped document's own `<meta http-equiv="Content-Security-Policy">`
      // (wrapTemplate's own CSP, scoped to script-src/style-src/img-src) —
      // the two are independent and both apply. `allow-scripts` alone, with
      // no `allow-same-origin`, still lets the runtime execute but confines
      // it to a unique opaque origin either way this document is loaded.
      res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
      res.end(html);
    })
    .catch(function (error) {
      console.error('Failed to prepare template preview:', error);
      res.statusCode = 500;
      res.end('Failed to prepare template preview.');
    });
}

// Matches one or more consecutive `/segment` groups — i.e. anything that
// looks like an absolute Unix path — inside an arbitrary error message.
// Deliberately generic (see sanitizeErrorMessage below) rather than a list of
// specific paths to strip.
//
// The leading `(?<![\w@.])` stops a match from starting mid-identifier: a bare
// npm specifier like `@vtex/payment-templates-core` (no leading slash —
// exactly what a "Cannot find module" error quotes verbatim) contains a `/`
// that this pattern would otherwise happily latch onto, treat as the start of
// a path, and rewrite into a mangled, half-eaten string — the very kind of
// corruption this replaced a naive substring-replace to avoid in the first
// place. Requiring the character right before the `/` to be neither a word
// character nor `@`/`.` means the pattern only fires at an actual path
// boundary (start of string, whitespace, a quote, `:`, `=`, ...).
//
// A segment may also contain a single space immediately followed by an
// uppercase letter — `Mobile Documents`, `My Projects`, `Program Files`, the
// common shape of a real folder name with a space in it, which the plain
// `[^\s'"()]+` below would otherwise stop at, leaving everything past the
// space (including more of the path, and the OS username in it) unredacted.
// The lookahead is what keeps this from also swallowing ordinary prose after
// the path: an English sentence resumes in lowercase ("... contains files
// outside ..."), so the space right after the path itself is never followed
// by an uppercase letter and the match still ends exactly there.
//
// `\p{Lu}` (Unicode "uppercase letter"), not `[A-Z]`: an ASCII-only class
// missed a name like `João Ávila` — "Á" is uppercase but outside A-Z, so the
// match stopped one word early and "Ávila\..." leaked. `\p{Lu}` (with the `u`
// flag below) covers uppercase in any script while still excluding lowercase,
// so it closes that gap without reopening the prose-swallowing one.
//
// KNOWN REMAINING GAPS in this generic pattern, which is why
// sanitizeErrorMessage first rewrites every path under the repository root
// (and the caller's bundlePath/templateRoot) by literal prefix, protecting the
// whole rest of that path from this pattern, and only falls back to it for
// whatever is left — an absolute path OUTSIDE the repository: elsewhere under
// the home directory, the Node install, a system path, another user's home.
// For those, and only those, all of these stay open:
//
// - A real folder/user name whose second word starts lowercase (`jane doe`,
//   a perfectly ordinary display name) is indistinguishable, character by
//   character, from resumed lowercase prose ("... contains files ...") — the
//   match still stops at that space, and the un-redacted remainder can
//   still carry a path fragment past it.
// - A segment stops at the first `'`, `"`, `(` or `)`, since those are what
//   delimit a path quoted in a message — so a real name containing one
//   (`/Users/o'brien/...`, `/Users/me/Projects(old)x/...`) is cut there, and
//   everything after that character (`o'brien/Documents/...`,
//   `Projects(old)x/...`) survives, relative-looking and un-redacted.
// - Once a match has been cut short by either of the above, a later `/`
//   right after a character the lookbehind below allows (`)`, `-`, `~`, `+`,
//   ...) starts a NEW match mid-path, and the rest of the path collapses onto
//   what was left before it: `/Users/me/Downloads/foo (1)/x/y.png` comes
//   out as `foo (1)y.png`. Mangled rather than leaked — what disappears is
//   directory structure — but no longer a path anyone could follow.
//
// - A Windows path with no drive letter and a single leading backslash is
//   only recognized from two segments of two or more characters each, not
//   starting like an escape sequence (see WINDOWS_PATH_PATTERN): a
//   single-segment `\foo`, a one-character first segment (`\x\alice\...`),
//   or a folder that reads like an escape (`\nFoo\...`, `\S1\...`) survives
//   as it is. So does one glued with no separator onto a word (`a\Users\...`,
//   indistinguishable from `x\ny`) or onto a `.` (a relative `..\x`).
//
// These don't reach a path inside the repository (see
// knownPathReplacements), which is where nearly every path this server's own
// messages quote lives: the bundle, template/, lib/, node_modules/ — with
// one known, accepted exception. A repository path embedded in a `file://`
// URL (`file:///Users/<you>/.../payment-mocker/lib/x.js`) is NOT rewritten
// repo-relative: the `/` right before it is a path character (see
// PATH_CHAR_PATTERN), so replaceKnownPath refuses the match there, and the
// whole URL falls to this generic pattern instead (`file://x.js`). That is
// still redacted, except that — like any path outside the repository — a
// folder or user name of a space followed by a lowercase letter cuts the match
// short and can leave the rest of the name, username included, visible.
// File URLs only appear in ESM / require(esm) errors, which this CommonJS
// server doesn't produce, so this is left as is rather than special-cased.
//
// `(?<!:\/)` alongside the existing `(?<![\w@.])`: without it, a URL quoted in
// a message (`http://localhost:8080/template-bundle/index.html`) matches too
// — the scheme's `//` looks exactly like an absolute path starting mid-string
// — and gets mangled down to just its basename (`http:index.html`). Neither
// lookbehind alone stops this (the first only blocks starting exactly on the
// character after `:`, and the engine just retries one character later, on
// the second `/`); rejecting a start that is itself immediately preceded by
// `:/` closes both attempts, since by the second one those are exactly the
// two preceding characters. `(?!\/)` on the leading slash is what makes that
// rejection reach the second `/` at all, instead of silently absorbing it as
// part of the same match one position earlier.
const ABSOLUTE_PATH_PATTERN = /(?<![\w@.])(?<!:\/)(?:\/(?!\/)(?:[^\s'"()]|[ ](?=\p{Lu}))+)+/gu;

// The same job for Windows-shaped absolute paths — a drive letter
// (`C:\Users\alice\...`) or a UNC share (`\\server\share\...`) — which the
// Unix pattern above cannot see at all, since they contain no forward slash.
// A message quoting one of those leaks the full path, OS username included,
// exactly like the Unix case. Segment characters are restricted the same way
// (no whitespace, quotes or parens) so the match stops at the end of the path
// rather than eating the rest of the sentence — and, like the Unix pattern
// above, a segment may contain a single space immediately followed by an
// uppercase letter in any script (`C:\Users\Jane Doe\...`, `C:\Users\João
// Ávila\...`), for the same reason, the same `\p{Lu}` fix, and the same
// bound against swallowing trailing prose — and the same known remaining gaps
// (a lowercase-starting second word, a quote or paren inside a name), see the
// Unix pattern's comment above.
//
// A third shape, a path with NO drive letter and a single leading backslash
// (`\Users\alice\AppData\npm`, rooted at the current drive), is the second
// alternative. It used to match neither branch, so a message quoting one
// leaked it whole, username included, and so did one glued onto a repository
// path (`<repo>\x.js:\Users\alice\z.js`: endOfPathRemainder ends the
// protected span before the `:`, but nothing then picked up what followed).
// A lone `\` is far more ambiguous than `C:\` or `\\`, though: messages carry
// escape sequences as literal text (`\n`, `\t`, `\u00e9`, a JSON string, a
// regex like `\d+\s*\w`), and collapsing those to their "basename" would
// corrupt them. So this branch only fires when:
//
// - the `\` is not preceded by a word character, `@`, `.` or another `\`
//   (`x\ny` inside a JSON string, a relative `.\lib\x.js` / `..\lib`, the
//   escaped `\\` of `a\\b`, the second `\` of a UNC `\\server`), nor by a
//   drive letter and `:` (the tail of `C:\...`, which the first branch
//   already owns). A `:` after anything else is allowed on purpose: the
//   known-path token ends in `_`, so the `:\Users\...` glued onto a
//   repository path (see knownPathToken) starts a match here;
// - there are at least TWO segments (`\seg\seg...`), each of the first two
//   at least two characters long: a single escape (`\n`, `\foo` — see the
//   gaps above) never matches, nor does `\btest\b`;
// - neither of those first two segments starts like an escape sequence
//   rather than a folder name (DRIVELESS_ESCAPE_LIKE): one of `n r t f v 0`
//   / `b B d D s S w W` followed by anything but a lowercase letter
//   (`\nFoo`, `\d+`, `\s*`, `\w`, `\b`, while `\bin`, `\temp`, `\Downloads`
//   and `\Windows` still read as folders), `u`/`x` plus hex digits
//   (`\u00e9`, `\x41`), or `u{`, `x{`, `p{`, `P{`, `k{` (`\p{Lu}`).
//
// Later segments are unrestricted, like the other branches, so the match
// still runs to the end of the path (`\Users\alice\x` comes out as `x`, not
// `alice` plus a leftover `\x`). The segment characters, the space-before-
// uppercase tolerance (`\Users\Jane Doe\x`) and the stop at whitespace, a
// quote or a paren are WINDOWS_SEGMENT's, so trailing prose and a closing
// `)` or `'` stay outside the match — and so does a known-path token, which
// starts with a space and contains no `\`. Because it is the SECOND
// alternative, wherever the first branch matches (a drive letter or UNC
// path, including the one-letter "drive" of `ENOENT:\x\y`) its output is
// exactly what it was before this branch existed.
const WINDOWS_SEGMENT_CHAR = '(?:[^\\s\'"()\\\\]|[ ](?=\\p{Lu}))';
const WINDOWS_SEGMENT = WINDOWS_SEGMENT_CHAR + '+';
const DRIVELESS_ESCAPE_LIKE = '(?:[nrtfv0bBdDsSwW](?!\\p{Ll})|[uxpPk]\\{|u[\\dA-Fa-f]{4}|x[\\dA-Fa-f]{2})';
const DRIVELESS_LEADING_SEGMENT = '(?!' + DRIVELESS_ESCAPE_LIKE + ')' + WINDOWS_SEGMENT_CHAR + '{2,}';
const WINDOWS_PATH_PATTERN = new RegExp(
  '(?:[A-Za-z]:|\\\\)\\\\' + WINDOWS_SEGMENT + '(?:\\\\' + WINDOWS_SEGMENT + ')*' +
    '|(?<![\\w@.\\\\])(?<![A-Za-z]:)\\\\' + DRIVELESS_LEADING_SEGMENT + '\\\\' + DRIVELESS_LEADING_SEGMENT +
    '(?:\\\\' + WINDOWS_SEGMENT + ')*',
  'gu'
);

// A character that can continue a path segment or join two of them — used
// by replaceKnownPath below to only ever replace a known path where it
// starts and ends at a real path boundary.
const PATH_CHAR_PATTERN = /[\p{L}\p{N}_.@~$\-\/\\]/u;

function isPathChar(character) {
  return character !== '' && PATH_CHAR_PATTERN.test(character);
}

// ` (1)/`, ` (old)\`: a space, a parenthesized word and then a separator —
// the shape of a copied folder's name (`foo (1)`, the way Finder and most
// file managers name a duplicate) somewhere in the middle of a path. Only
// ever taken with the separator after it, so prose that merely follows a
// path with a parenthetical — `/repo/x.js (see above)` — still ends the path
// at the space. Sticky (`y`), matched at `lastIndex` against the whole
// message rather than `^`-anchored against a fresh `message.slice(end)` per
// candidate space, which is a copy of the rest of the message each time on
// an engine without cheap substrings.
const SPACED_PAREN_SEGMENT_PATTERN = / \([^\s'"`()\\/]*\)(?=[\\/])/y;

// The most of a message endOfPathRemainder walks after one known path: 4096
// characters, PATH_MAX on Linux (macOS's is 1024), so the rest of any real
// path fits in it. Only text no real path produces — a huge author-controlled
// value quoted in a message, say a preview.config.json field of 40 000 `)`
// right after a repository path — ever reaches it. Bounding it keeps that
// one walk's cost fixed however long the message is (the walk is linear now
// too, see endOfPathRemainder), on a server whose single event loop serves
// every other request meanwhile.
//
// Past the cap the protected span simply ends, and the rest of the message
// goes to the generic patterns like any other text outside a known path: it
// is never left out of sanitizing, and those patterns only ever shorten what
// they match (an absolute path down to its basename), so nothing past the cap
// can come out showing more than the uncapped span would have. What can
// differ, for such a message only, is the stretch between the cap and where
// the span would otherwise have ended: kept verbatim inside the span before,
// it may now be collapsed by the generic patterns instead. Below the cap the
// output is exactly what it was without one.
const MAX_PATH_REMAINDER_LENGTH = 4096;

// A character that, immediately followed by the start of an absolute path —
// `/`, `\` or a drive letter plus `:\` / `:/` (see NEW_PATH_START_PATTERN) —
// begins ANOTHER path rather than continuing the current one: `:` (the Unix
// PATH / NODE_PATH separator, `a:/b`), `;` (the Windows one, `a;C:\b`), `,`
// (a list), `>` (an arrow, `a=>/b`, `a->/b`), `=` (`key=/b`) and `(` (a
// wrapped path, `x(/b)`). Used by endOfPathRemainder below to end the
// protected span right before it.
const PATH_LIST_SEPARATORS = ':;,>=(';
const NEW_PATH_START_PATTERN = /^(?:[\\/]|[A-Za-z]:[\\/])/;

/** Whether the character at `index` is a PATH_LIST_SEPARATORS one that starts another path. */
function startsAnotherPath(message, index) {
  return PATH_LIST_SEPARATORS.includes(message[index]) && NEW_PATH_START_PATTERN.test(message.slice(index + 1, index + 4));
}

/**
 * Where the rest of a path that starts at `start` (on a separator, right
 * after a known path) ends in `message`: the end index of the span
 * replaceKnownPath below protects from the generic patterns.
 *
 * The span runs up to whitespace, a quote (`'`, `"`, a backtick) or the end
 * of the message — the characters that end a path quoted in an error message
 * — except that, like ABSOLUTE_PATH_PATTERN, a single space immediately
 * followed by an uppercase letter (`My Projects`) is kept as part of the
 * path, and so is a ` (1)` that is followed by another separator (see
 * SPACED_PAREN_SEGMENT_PATTERN). Anything else — `(`, `)`, `-`, `~` — is
 * kept too: inside the repository a directory named `ref(1)` or `a-` is just part of
 * the path, and holding it inside the span is exactly what stops the generic
 * pattern from cutting at a `(` and then restarting after a `)` or `-`.
 *
 * The one exception to "anything else": the span also ends right BEFORE a
 * `:`, `;`, `,`, `>`, `=` or `(` that is immediately followed by the start of
 * an absolute path (`/`, `\`, or a drive letter and `:\` / `:/` — see
 * startsAnotherPath). That character cannot be part of a path under the
 * repository; it is where a second path glued on with no space begins —
 * `<repo>/node_modules:/Users/<you>/.node_modules` (a NODE_PATH),
 * `<repo>\bin;C:\Users\<you>\AppData\...` (a Windows PATH),
 * `<repo>/lib/x.js:12:3,/elsewhere/...`, `<repo>/x.js=>/elsewhere/...`,
 * `<repo>/node_modules/.bin/x(/elsewhere/...)`. Without this, that second
 * path — which is OUTSIDE the repository and typically carries the OS
 * username — was swallowed into the protected span, never seen by the
 * generic patterns, and reached the client whole. Ending the span there
 * hands it (and the separator before it) to the generic pass like any other
 * path outside the repository. It is the character AFTER the separator that
 * decides: a `(` followed by a digit, as in `ref(1)/x`, is still kept (the
 * `/` there follows the `)`, not the `(`), and so are a `:12:3` and a `-`
 * or `~` followed by `/` (`a-/b`), none of which is followed by a path start.
 *
 * Then trailing characters that belong to the prose around the path, not to
 * the path, are given back, repeatedly until none is left: a sentence's
 * `.`/`,`/`;`/`:`/`!`/`?`, a `)`/`]`/`}` with no opening partner inside the
 * span (`(see /repo/x.js)`, a stack frame's `(/repo/x.js:12:3)`), and a
 * `:line` / `:line:column` suffix (`at /repo/lib/x.js:12:3`). What is given
 * back contains no separator, so the generic patterns can't start a match in
 * it either.
 *
 * At most MAX_PATH_REMAINDER_LENGTH characters are walked (see there for
 * what happens past them). A ` (1)` copy suffix that starts before that mark
 * is still taken whole, so the walk can end a few characters past it.
 *
 * Linear in the span's length. An earlier version re-sliced the span, re-ran
 * a `(?::\d+)+$` regex over it and split it twice for EVERY character it gave
 * back, so a repository path followed by N `)` cost O(N²) — about 0.5 s at
 * 10 000, 2 s at 20 000 and 8 s at 40 000, all synchronous. It now walks
 * `end` back over indices, keeps the bracket counts as running totals and
 * finds a `:line:column` suffix by scanning back from `end`, giving the same
 * answer as before for every input.
 */
function endOfPathRemainder(message, start) {
  const limit = Math.min(message.length, start + MAX_PATH_REMAINDER_LENGTH);
  let end = start;
  while (end < limit) {
    const character = message[end];
    if (character === "'" || character === '"' || character === '`') break;
    if (/\s/.test(character)) {
      if (character === ' ' && /\p{Lu}/u.test(message.charAt(end + 1))) {
        end += 1;
        continue;
      }
      SPACED_PAREN_SEGMENT_PATTERN.lastIndex = end;
      const copySuffix = SPACED_PAREN_SEGMENT_PATTERN.exec(message);
      if (copySuffix) {
        end += copySuffix[0].length;
        continue;
      }
      break;
    }
    if (startsAnotherPath(message, end)) break;
    end += 1;
  }

  // Then give back the prose around the path. `counts` holds how many of
  // each bracket lie inside [start, end), updated as `end` moves back.
  const counts = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 };
  for (let index = start; index < end; index++) {
    if (Object.prototype.hasOwnProperty.call(counts, message[index])) counts[message[index]] += 1;
  }
  for (;;) {
    // A `:line` / `:line:column` suffix (no bracket in it, so `counts` is
    // unaffected), unless it is the whole span.
    const lineColumnStart = trailingLineColumnStart(message, start, end);
    if (lineColumnStart > start) {
      end = lineColumnStart;
      continue;
    }
    if (end === start) return end;
    const last = message[end - 1];
    if (SENTENCE_PUNCTUATION.includes(last) && end - start > 1) {
      end -= 1;
      continue;
    }
    const opening = OPENING_BRACKET_FOR[last];
    if (opening && counts[opening] < counts[last]) {
      counts[last] -= 1;
      end -= 1;
      continue;
    }
    return end;
  }
}

const SENTENCE_PUNCTUATION = '.,;:!?';
const OPENING_BRACKET_FOR = { ')': '(', ']': '[', '}': '{' };

function isAsciiDigit(character) {
  return character >= '0' && character <= '9';
}

/**
 * Where the run of `:<digits>` groups that ends exactly at `end` begins —
 * what `/(?::\d+)+$/.exec(message.slice(start, end))` matches, as an index
 * into `message` — or -1 when there is none. Scanned backwards from `end`,
 * so it only ever looks at the suffix itself plus one more digit run.
 */
function trailingLineColumnStart(message, start, end) {
  let matchStart = -1;
  let groupEnd = end;
  for (;;) {
    let digitsStart = groupEnd;
    while (digitsStart > start && isAsciiDigit(message[digitsStart - 1])) digitsStart -= 1;
    if (digitsStart === groupEnd || digitsStart === start || message[digitsStart - 1] !== ':') return matchStart;
    groupEnd = digitsStart - 1;
    matchStart = groupEnd;
  }
}

/**
 * Replaces every occurrence of the literal string `knownPath` in `message`
 * with `makeReplacement(remainder)` — but only where it sits at a path
 * boundary: not preceded by a path character, and followed by the end of the
 * string, a separator, a non-path character, or a sentence-ending `.` (one
 * followed by whitespace or the end of the message). A literal indexOf scan
 * rather than a regex (no escaping of an arbitrary path into a pattern), and
 * rather than a bare split/join, which is what an earlier version of this
 * function used and what could corrupt a message: splitting on
 * `/var/folders/...` inside `/private/var/folders/...` (macOS's /var ->
 * /private/var symlink, which os.tmpdir() resolves through) spliced out the
 * tail and left a mangled `/private<replacement>` behind, and a root
 * `/Users/me/repo` would likewise have been cut out of the middle of
 * `/Users/me/repo2/...`. The boundary check refuses both.
 *
 * When the known path is followed by a separator, the rest of that path
 * (see endOfPathRemainder) is consumed with it and handed to
 * `makeReplacement` as `remainder` (`/template/reference/index.html`,
 * separator first), so the whole path — not just its known prefix — is
 * replaced in one piece and the generic patterns never see any of it.
 * Otherwise `remainder` is ''.
 */
function replaceKnownPath(message, knownPath, makeReplacement) {
  let result = '';
  let from = 0;
  for (;;) {
    const index = message.indexOf(knownPath, from);
    if (index === -1) break;
    const before = index === 0 ? '' : message[index - 1];
    const afterIndex = index + knownPath.length;
    const after = message.charAt(afterIndex);
    const endsSentence = after === '.' && /^\s?$/.test(message.charAt(afterIndex + 1));
    const endsAtBoundary = after === '' || after === '/' || after === '\\' || endsSentence || !isPathChar(after);
    if (!isPathChar(before) && endsAtBoundary) {
      const end = after === '/' || after === '\\' ? endOfPathRemainder(message, afterIndex) : afterIndex;
      result += message.slice(from, index) + makeReplacement(message.slice(afterIndex, end));
      from = end;
    } else {
      result += message.slice(from, index + 1);
      from = index + 1;
    }
  }
  return result + message.slice(from);
}

function lastPathSegment(knownPath) {
  const segments = knownPath.split(/[\\/]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : knownPath;
}

function stripTrailingSeparators(knownPath) {
  return knownPath.replace(/[\\/]+$/, '');
}

/**
 * Every spelling a message might use for `knownPath`: its own, its
 * realpath'd one (the /var -> /private/var case above), and each with its
 * separators flipped both ways, so a Windows path is found whether a message
 * spells it `C:\Users\...` or `C:/Users/...`. A bare root (`/`, `\`, `C:\`)
 * strips down to '' or a lone drive letter and is dropped: replacing it would
 * rewrite every absolute path in the message.
 */
function pathSpellings(knownPath) {
  const forms = new Set([knownPath]);
  try {
    forms.add(fs.realpathSync(knownPath));
  } catch (error) {
    // Doesn't exist (or isn't resolvable) on this machine: its literal
    // spelling alone is still worth stripping.
  }
  for (const form of Array.from(forms)) {
    forms.add(form.replace(/\\/g, '/'));
    forms.add(form.replace(/\//g, '\\'));
  }
  return Array.from(forms, stripTrailingSeparators).filter(function (form) {
    return form !== '' && !/^[A-Za-z]:$/.test(form);
  });
}

function isAbsoluteAnywhere(candidate) {
  return typeof candidate === 'string' && (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate));
}

/** `form` relative to one of `rootForms` ('' for the root itself), or null if it's under none. */
function relativeToRoot(form, rootForms) {
  for (const rootForm of rootForms) {
    if (form === rootForm) return '';
    if (form.startsWith(rootForm + '/') || form.startsWith(rootForm + '\\')) return form.slice(rootForm.length + 1);
  }
  return null;
}

/**
 * The server's own absolute paths that an error message is most likely to
 * quote, each paired with the base of what replaces it, longest first (so a
 * path nested under another known one — bundlePath under the repository
 * root — is replaced whole, before its ancestor could claim just its prefix).
 * Every path is added in each of its pathSpellings.
 *
 * The one known path that is always there is the repository root,
 * `repoRoot` (the parent of TEMPLATE_ROOT in production): its base is '',
 * so anything under it comes out as a path RELATIVE to the repository —
 * `template/reference/index.html`, `lib/load-bundle.js`,
 * `node_modules/@vtex/...` — and the root itself as the repository
 * folder's own name (see applyReplacement). That reads the way the author already thinks of these
 * files, keeps every segment that's actually useful to them, and drops
 * exactly the part that isn't: where on this machine the checkout lives,
 * which is where the OS username is.
 *
 * `extraKnownPaths` (the route passes config.bundlePath and its
 * templateRoot) are rewritten the same way when they lie inside the
 * repository — mostly redundant with the root itself, but it also covers a
 * spelling of them the root's own spellings don't (one reached through a
 * symlink from outside, whose realpath is inside). One OUTSIDE the
 * repository — tests pass a temp-directory templateRoot, and nothing stops a
 * bundle living elsewhere — keeps the older behavior: it becomes its last
 * segment (`template`, `reference`), the same thing the generic patterns
 * reduce a path to, with the rest of its path protected the same way. An
 * extra path that is an ancestor of the repository root (a templateRoot of
 * `/Users`, say) is skipped: replacing it would turn every OTHER path under
 * it — `/Users/<someone>/...` — into a relative, username-bearing
 * `Users/<someone>/...` the generic patterns no longer recognize as a path
 * at all. A relative value (`template`) is skipped too: it would match that
 * bare word anywhere in ordinary prose.
 *
 * There is deliberately no special case for os.homedir() (it used to become
 * `~`) or process.cwd(): cwd is the repository root whenever this runs under
 * `grunt`/`npm test`, and the home directory's own OTHER contents are exactly
 * the "outside the repository" paths the generic patterns handle — see the
 * gaps listed above ABSOLUTE_PATH_PATTERN for what that costs.
 */
function knownPathReplacements(extraKnownPaths, repoRoot) {
  const replacements = new Map();
  const rootForms = isAbsoluteAnywhere(repoRoot) ? pathSpellings(stripTrailingSeparators(repoRoot)) : [];
  for (const form of rootForms) replacements.set(form, '');

  function isAncestorOfRoot(form) {
    return rootForms.some(function (rootForm) {
      return rootForm !== form && (rootForm.startsWith(form + '/') || rootForm.startsWith(form + '\\'));
    });
  }

  for (const candidate of extraKnownPaths || []) {
    if (!isAbsoluteAnywhere(candidate)) continue;
    const forms = pathSpellings(candidate);
    let base = null;
    for (const form of forms) {
      base = relativeToRoot(form, rootForms);
      if (base !== null) break;
    }
    for (const form of forms) {
      if (replacements.has(form)) continue;
      if (base === null && isAncestorOfRoot(form)) continue;
      replacements.set(form, base === null ? lastPathSegment(form) : base);
    }
  }

  return Array.from(replacements.entries()).sort(function (a, b) {
    return b[0].length - a[0].length;
  });
}

/**
 * The text a known path (with the `remainder` replaceKnownPath consumed after
 * it) is replaced by: `base` + `remainder`, except that for the repository
 * root itself (`base` '') the remainder's leading separator goes too —
 * `template/reference`, not `/template/reference` — and the bare root,
 * with nothing after it, is the repository folder's own name (`rootName`,
 * `payment-mocker`). Not `.`, the other obvious choice: a message quoting
 * the root at the end of a sentence (`... at /Users/me/payment-mocker.`)
 * then read `... at ..`, which names the parent directory instead.
 */
function applyReplacement(base, remainder, rootName) {
  if (base !== '') return base + remainder;
  const relative = remainder.replace(/^[\\/]+/, '');
  return relative === '' ? rootName : relative;
}

/**
 * Strips the server's absolute filesystem path(s) out of an error message
 * before it's allowed anywhere near the client. `error.message` for the
 * failure modes this guards (loadBundle rejecting a file outside the
 * template contract, a raw ENOENT for a missing index.html/style.css, a
 * `Cannot find module '...'` from a dependency that never got installed,
 * ...) frequently embeds an absolute filesystem path verbatim — including
 * the server's OS username on a typical dev machine. Every other route in
 * this file already takes care never to do this (see sendInvalidConfigError
 * and serveWrappedIndex's .catch); this is the same treatment for
 * serveTemplateValidation.
 *
 * Two passes. First, every path under the repository root (always known:
 * the parent of TEMPLATE_ROOT) is rewritten RELATIVE to it, whole —
 * `/Users/<you>/.../payment-mocker/template/reference/index.html` becomes
 * `template/reference/index.html` — along with whatever the caller passes in
 * `extraKnownPaths` (the route passes config.bundlePath and its templateRoot
 * when it has them; see knownPathReplacements for one outside the
 * repository). "Whole" means both the known prefix, however unusual its
 * characters — `o'brien`, `Projects(old)x`, `jane doe` — and the rest of the
 * path after it (endOfPathRemainder), which is exactly where the generic
 * patterns below guess wrong (see the gaps listed above
 * ABSOLUTE_PATH_PATTERN).
 *
 * Then, as the fallback for any absolute path outside the repository (a
 * `Require stack:` entry elsewhere on disk, the Node install, a system path,
 * ...), every substring that merely *looks* like an absolute Unix or Windows
 * path (`ABSOLUTE_PATH_PATTERN` / `WINDOWS_PATH_PATTERN` above) is collapsed
 * down to its basename. That keeps the actionable part of the message (which
 * file) while dropping the directory structure and OS username, without
 * having to predict which absolute path shows up or how it's spelled.
 *
 * `extraKnownPaths` is optional on purpose: Gruntfile.js constructs the
 * middleware with createPreviewMiddleware() and no arguments at all in
 * production, so `templateRoot` is `undefined` on that path. The repository
 * root is resolved here (from TEMPLATE_ROOT, which is what `templateRoot`
 * falls back to) rather than required from the caller, so that path gets the
 * known-path pass too instead of silently doing half its job — the failure
 * mode an earlier version of this function, which took `config` and
 * `templateRoot` as required parameters, had.
 */
// Stand-in for a known path while the generic patterns run, restored to its
// replacement text afterwards. Why not just insert the replacement directly:
// the replacement is a RELATIVE path (`template/reference/index.html`,
// `ref(1)/x/y.png`), and the generic patterns would see its own `/x/y.png`
// tail — right after a `)`, a `-`, ... which their lookbehind allows — as a
// fresh absolute path and collapse it (`ref(1)y.png`). This token ends in
// `_`, a word character, which the Unix pattern's lookbehind never allows a
// match to start after \u2014 and NOT a letter, so the Windows pattern can't take
// it for a drive letter either when the span ends right before a `:\`
// (endOfPathRemainder ends it there; a token ending in `x` came out as part of
// a mangled `x:\...` match); it starts with a space, which ends any path
// segment either pattern could be matching just before it (the marker after
// the space is not an uppercase letter, so the `[ ](?=\p{Lu})` exception
// never applies).
//
// The marker around the index is a private-use code point chosen PER CALL as
// one that does not occur anywhere in the incoming message (tokenMarkerFor).
// An earlier version used a fixed `\uE000`/`\uE001` pair and restored every
// match of the pattern across the whole message, so a message that already
// contained that text (`x \uE0000\uE001x y`) came out as `xundefined y`, or
// with another path's replacement spliced in. With a marker absent from the
// input, every occurrence of it afterwards was inserted by this call: the
// generic patterns only ever replace a match with its basename, a substring
// of the input, and a match can't reach into a token (no `/` or `\` inside
// it, a space before it, a `_` after it). Whatever text the input had is left
// exactly as it was.
function tokenMarkerFor(message) {
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const marker = String.fromCharCode(codePoint);
    if (!message.includes(marker)) return { marker: marker, message: message };
  }
  // Only reachable for a message containing every one of the 6400 BMP
  // private-use code points. Give up one of them rather than risk a
  // collision: drop it from the message and use it.
  return { marker: '\uE000', message: message.replace(/\uE000/g, '') };
}

function knownPathToken(marker, index) {
  return ' ' + marker + index + marker + '_';
}

function knownPathTokenPattern(marker) {
  return new RegExp(' ' + marker + '(\\d+)' + marker + '_', 'g');
}

/**
 * sanitizeErrorMessage with the repository root passed in rather than
 * derived from TEMPLATE_ROOT — the seam that lets a test exercise a root
 * spelled like `/Users/o'brien/...` or `/Users/me/Projects(old)x/...`
 * without mocking os/fs or moving the checkout. Exported for tests only
 * (as `_sanitizeErrorMessageForRoot`); everything else calls
 * sanitizeErrorMessage.
 */
function sanitizeErrorMessageForRoot(message, extraKnownPaths, repoRoot) {
  const { marker, message: input } = tokenMarkerFor(String(message));
  let sanitized = input;
  const tokenReplacements = [];
  const rootName = lastPathSegment(String(repoRoot || ''));
  for (const [knownPath, base] of knownPathReplacements(extraKnownPaths, repoRoot)) {
    sanitized = replaceKnownPath(sanitized, knownPath, function (remainder) {
      tokenReplacements.push(applyReplacement(base, remainder, rootName));
      return knownPathToken(marker, tokenReplacements.length - 1);
    });
  }
  return sanitized
    .replace(ABSOLUTE_PATH_PATTERN, function (match) {
      return path.basename(match);
    })
    // path.win32 explicitly, not the platform-default `path`: on macOS/Linux
    // — where this dev server usually runs, and where a Windows-shaped path
    // can still reach it through a message it merely relays — `path.basename`
    // is the POSIX one, doesn't treat `\` as a separator, and would hand the
    // entire `C:\Users\alice\...` string back unchanged.
    .replace(WINDOWS_PATH_PATTERN, function (match) {
      return path.win32.basename(match);
    })
    // Only a token this call inserted is restored; anything else that merely
    // looks like one (impossible with a per-call marker, but never `undefined`
    // regardless) is left as it is.
    .replace(knownPathTokenPattern(marker), function (token, index) {
      const replacement = tokenReplacements[Number(index)];
      return replacement === undefined ? token : replacement;
    });
}

function sanitizeErrorMessage(message, extraKnownPaths) {
  return sanitizeErrorMessageForRoot(message, extraKnownPaths, path.dirname(defaultTemplateRoot()));
}

/**
 * Reports the validator's findings for the currently configured bundle as
 * JSON — `{ ok, errors }`, the same shape `validate()` itself returns — for
 * the checkout shell mock to render as a banner. Any failure (a malformed
 * bundle that loadBundle rejects outright, a malformed displayName that
 * makes validate() throw synchronously, ...) is reported the same way, as an
 * `ok: false` finding, rather than a 500: this endpoint's only job is
 * describing what's wrong with the bundle, so it should never itself be the
 * thing that's broken. (Problems with the configured icon are not load
 * failures any more — see runTemplateValidation — and neither is an
 * oversized bundle file, with one exception: a single file past
 * lib/load-bundle.js's 4 MB MAX_VALIDATION_BYTES, which toValidationBundle
 * refuses with its own message naming the file and its size, reported here
 * as the one finding.)
 *
 * Shared with scripts/validate-reference.js (via runTemplateValidation, and
 * directly for a preview.config.json it can't read), so `npm run
 * validate:reference` prints the same `load` finding the banner shows
 * instead of a raw exception and its stack.
 */
function loadFailureResult(error, knownPaths) {
  const rawMessage = error && error.message ? error.message : String(error);
  return {
    ok: false,
    errors: [
      {
        rule: 'load',
        severity: 'error',
        message: sanitizeErrorMessage(rawMessage, knownPaths),
      },
    ],
  };
}

function sendValidationResult(res, result) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(JSON.stringify({ ok: !!result.ok, errors: result.errors || [] }));
}

/**
 * Validates the bundle `config` names, start to finish, and resolves with
 * what to report — `{ ok, errors }` — never rejecting for anything an
 * author's bundle or icon can cause: a failure to load or validate it at all
 * (loadBundle rejecting a file outside the contract, toValidationBundle
 * refusing a file past 4 MB, validate() throwing on a malformed displayName,
 * ...) resolves as loadFailureResult's single sanitized `load` finding, after
 * `onLoadFailure(error)` (optional) has seen the raw error — the route logs it
 * for whoever runs the server; the CLI passes nothing, since its terminal IS
 * the author's and the finding already says what is wrong.
 *
 * The one pipeline both /template-validation.json (serveTemplateValidation
 * below) and scripts/validate-reference.js run, so the banner and `npm run
 * validate:reference` can't disagree on the same bundle — not on its
 * findings, and not on how a load failure is worded either: the CLI used to
 * print such a failure as a raw exception and stack trace while the banner
 * showed one clean finding. `templateRoot` is optional (the real template/
 * by default), exactly as for createPreviewMiddleware.
 */
function runTemplateValidation(config, templateRoot, onLoadFailure) {
  const knownPaths = [config.bundlePath, templateRoot];
  return Promise.resolve()
    .then(function () {
      const bundle = loadBundle(config.bundlePath);
      const { validate } = require('@vtex/payment-templates-core');
      const template = toValidationBundle(bundle, config.defaultLocale);
      // `findings`: problems with config.icon that kept it out of `input`
      // (lib/validation-input.js's resolveIconPath/readIconEntry) — reported
      // alongside validate()'s own findings instead of replacing them, which
      // is what a throw from there used to do (a single `load` finding for a
      // misnamed icon hid everything else wrong with the bundle). Their
      // messages quote config.icon verbatim, so they go through the same
      // sanitizer a load failure's message does.
      const { input, findings } = buildValidationInput(config, template, templateRoot);
      const iconFindings = findings.map(function (finding) {
        return Object.assign({}, finding, { message: sanitizeErrorMessage(finding.message, knownPaths) });
      });
      // finishValidationResult also drops the one finding that exists only
      // because a truncated image was zero-padded (see
      // lib/validation-input.js's withoutTruncationArtifacts) — which is why
      // it takes `input` too.
      return Promise.resolve(validate(input)).then(function (result) {
        return finishValidationResult(result, input, iconFindings);
      });
    })
    .catch(function (error) {
      if (onLoadFailure) onLoadFailure(error);
      return loadFailureResult(error, knownPaths);
    });
}

function serveTemplateValidation(config, req, res, templateRoot) {
  runTemplateValidation(config, templateRoot, function (error) {
    console.error('Template validation failed to run:', error);
  })
    .then(function (result) {
      sendValidationResult(res, result);
    })
    .catch(function (error) {
      // Belt-and-suspenders: runTemplateValidation's own .catch already turns
      // every *expected* failure (loadBundle rejecting the bundle, validate()
      // throwing) into a normal { ok: false, errors: [...] } result. This
      // final .catch is only reached if something inside that .catch or the
      // .then above itself throws
      // unexpectedly (e.g. sanitizeErrorMessage choking on a non-string
      // message) — in which case that rejection would otherwise have no
      // handler downstream, which recent Node versions can escalate to a
      // fatal unhandled-rejection crash. Per this function's own docblock
      // ("this endpoint's only job... it should never itself be the thing
      // that's broken"), log the real error for the dev running the server,
      // but never leak error.message (or anything else about it) to the
      // client — by this point the error is unexpected enough that its
      // content can't be trusted to be safe to show.
      console.error('Template validation route failed unexpectedly:', error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Failed to run template validation.');
      }
    });
}

/**
 * Responds with a fixed, generic message for a broken/missing
 * preview.config.json instead of interpolating `error.message`, which for
 * the common failure modes (missing file, bad JSON) includes the absolute
 * filesystem path of the server (e.g. an ENOENT's `path` property embedded
 * in the message). The real error — path and all — still goes to the
 * server log via console.error for whoever is running the dev server.
 */
function sendInvalidConfigError(res, error) {
  console.error('Invalid preview.config.json:', error);
  res.statusCode = 500;
  res.end('Invalid preview.config.json');
}

/**
 * Serves preview.config.json itself, at the exact URL
 * src/assets/libs/template-host.js fetches it from. Deliberately re-shapes
 * the object rather than forwarding `readPreviewConfig()`'s return value
 * as-is: that function stamps an absolute `bundlePath` onto the config for
 * internal use, and that path must never reach the client.
 */
function servePreviewConfig(req, res, templateRoot) {
  let config;
  try {
    config = readPreviewConfig(templateRoot);
  } catch (error) {
    sendInvalidConfigError(res, error);
    return;
  }

  // The locale switcher in the checkout shell mock is populated from the
  // bundle's own i18n files rather than a hardcoded list, so it can never
  // offer a locale the bundle doesn't actually ship.
  let availableLocales = [];
  try {
    const bundle = loadBundle(config.bundlePath);
    availableLocales = Object.keys(bundle.i18n).sort();
  } catch (error) {
    // Bundle may violate the contract; the validation banner (fetched
    // separately from /template-validation.json) already reports that.
    // Degrade to an empty list here instead of taking the whole route down.
  }

  const clientConfig = {
    bundleDir: config.bundleDir,
    defaultLocale: config.defaultLocale,
    // Always present (possibly empty) so the client never has to handle
    // an undefined case.
    availableLocales,
  };
  if (config.icon !== undefined) clientConfig.icon = config.icon;
  if (config.displayName !== undefined) clientConfig.displayName = config.displayName;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(JSON.stringify(clientConfig));
}

/**
 * `declaredContentType`, when passed, overrides the extension-sniffed value
 * that would otherwise come from `resolvedFile` itself. That distinction
 * matters wherever `resolvedFile` was reached by following a symlink
 * (`fs.realpathSync`) whose *target* has a different extension than the name
 * that actually passed this route's contract/shape check — e.g. a bundle's
 * `asset-x.png` symlinked to an `evil.html` elsewhere in the same bundle:
 * containment still passes (the target is inside the bundle), the name still
 * passes (it's a validly-shaped `asset-*.png`), but sniffing off the resolved
 * target would serve it as `text/html` regardless. Callers that already
 * validated a name against the contract pass that name's own content type
 * here instead of letting the resolved target answer the question.
 */
function streamFile(resolvedFile, res, declaredContentType, corpPolicy) {
  res.setHeader('Content-Type', declaredContentType || contentType(resolvedFile));
  res.setHeader('Cache-Control', 'no-cache');
  // `corpPolicy` is opt-in per caller, not a blanket default here — see each
  // call site for why. `Cross-Origin-Resource-Policy: same-origin` only makes
  // sense for a resource actually fetched by a same-origin document; most of
  // this function's callers serve files requested by the wrapped template
  // document itself — rendered inside an `<iframe sandbox="allow-scripts">`
  // with no `allow-same-origin` — namely its style.css/assets (the bundle
  // static-file route) and the two `/lib/...` runtime scripts. (The wrapped
  // index.html is not one of them: serveWrappedIndex sends it via res.end,
  // never through here.) Sandboxing without `allow-same-origin` gives
  // that document a unique **opaque** origin — one that never equals
  // anything, including itself on a second load — so `same-origin` there
  // blocks every one of those fetches outright (confirmed against a real
  // Chromium: `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` on style.css, both
  // /lib/ scripts, and every bundle asset, which silently killed the whole
  // preview — no styles, no runtime, no locale switching, no height sizing).
  if (corpPolicy) {
    res.setHeader('Cross-Origin-Resource-Policy', corpPolicy);
  }
  const stream = fs.createReadStream(resolvedFile);
  // `open` failures (EACCES, the file vanishing between realpathSync and
  // open, ...) surface as an async 'error' event on the stream. Without a
  // listener, that event becomes an uncaughtException and takes down the
  // whole dev server.
  stream.on('error', function () {
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end('Failed to read file');
  });
  stream.pipe(res);
}

/**
 * Serves the verbatim resolve-locale.js from @vtex/payment-templates-core
 * (the shared source of truth — see that repo's rfc-wrap-runtime.md) as a
 * plain static script. The path is fixed (not derived from the request URL),
 * so there is no user input to validate or contain here.
 */
function serveResolveLocaleScript(req, res) {
  streamFile(require.resolve('@vtex/payment-templates-core/wrap/resolve-locale.js'), res);
}

/**
 * Serves the verbatim template-runtime.js from @vtex/payment-templates-core,
 * the same way serveResolveLocaleScript does. The path is fixed (not derived
 * from the request URL), so there is no user input to validate or contain
 * here.
 */
function serveTemplateRuntimeScript(req, res) {
  streamFile(require.resolve('@vtex/payment-templates-core/wrap/template-runtime.js'), res);
}

/**
 * Serves `config.icon` from a dedicated route rooted at TEMPLATE_ROOT, not
 * bundlePath. Per CONTRACT.md the icon is "stored separately from the
 * versioned bundle": resolving it inside the bundle directory leaves no way
 * to configure one that isn't also rejected by loadBundle's contract check
 * (an unreferenced extra file) or the validator's unused-asset check
 * (referenced nowhere in HTML/CSS).
 */
function serveTemplateIcon(req, res, templateRoot) {
  let config;
  try {
    config = readPreviewConfig(templateRoot);
  } catch (error) {
    sendInvalidConfigError(res, error);
    return;
  }

  if (!config.icon) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  let relativePath;
  try {
    relativePath = decodeURIComponent(req.url.slice(ICON_PREFIX.length).split('?')[0]);
  } catch (error) {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  const normalizedPath = normalizeIndexPath(relativePath);
  const normalizedIcon = normalizeIndexPath(config.icon);

  if (normalizedPath.toLowerCase() !== normalizedIcon.toLowerCase()) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  const root = templateRoot || defaultTemplateRoot();
  let resolvedRoot;
  let resolvedFile;
  try {
    resolvedRoot = fs.realpathSync(root);
    resolvedFile = fs.realpathSync(path.join(root, normalizedIcon));
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    res.statusCode = 500;
    res.end('Failed to resolve path');
    return;
  }

  if (!isPathContained(resolvedRoot, resolvedFile)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(resolvedFile);
  } catch (error) {
    // The file can vanish (or become inaccessible) in the window between
    // the realpathSync above and this stat — treat that race the same as
    // "not found" instead of letting a synchronous throw escape to
    // connect's default handler, which would leak a stack trace and an
    // absolute filesystem path back to the client.
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  // !isFile(), not isDirectory(): a directory is the common case, but this
  // must reject anything that isn't a plain file just as firmly — a FIFO in
  // particular would make the fs.createReadStream inside streamFile below
  // block open() waiting for a writer that never arrives, on every request
  // for it, the same hang lib/validation-input.js's own isFile() check
  // guards the separate icon-for-validation read against.
  if (!stat.isFile()) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  // Checked last, after the traversal/existence checks above so those keep
  // answering with their own, more specific status (403 for an escaping
  // path) — this is purely about what KIND of file `normalizedIcon` may name,
  // regardless of where it resolves to. isAllowedIconFilename normalizes
  // `config.icon` the same way `normalizedIcon` was derived above, and is the
  // same check lib/validation-input.js's resolveIconPath applies.
  if (!isAllowedIconFilename(config.icon)) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  // 'same-origin' is safe here, unlike streamFile's other callers: the icon
  // is applied as a CSS background-image by src/assets/libs/template-host.js,
  // which runs in the top-level checkout shell page itself — a normal
  // same-origin document, not the sandboxed/opaque-origin wrapped template.
  streamFile(resolvedFile, res, contentType(normalizedIcon), 'same-origin');
}

function createPreviewMiddleware(options) {
  const templateRoot = options && options.templateRoot;

  return function previewMiddleware(req, res, next) {
    if (!req.url) {
      next();
      return;
    }

    const pathOnly = req.url.split('?')[0];
    const isConfigRoute = pathOnly === PREVIEW_CONFIG_PATH;
    const isResolveLocaleRoute = pathOnly === RESOLVE_LOCALE_SCRIPT_PATH;
    const isTemplateRuntimeRoute = pathOnly === TEMPLATE_RUNTIME_SCRIPT_PATH;
    const isValidationRoute = pathOnly === TEMPLATE_VALIDATION_PATH;
    const isIconRoute = req.url.indexOf(ICON_PREFIX) === 0;
    const isBundleRoute = req.url.indexOf(BUNDLE_PREFIX) === 0;

    // None of this middleware's routes match — defer to the next handler in
    // the chain without touching the method at all.
    if (
      !isConfigRoute &&
      !isResolveLocaleRoute &&
      !isTemplateRuntimeRoute &&
      !isValidationRoute &&
      !isIconRoute &&
      !isBundleRoute
    ) {
      next();
      return;
    }

    // Every route this middleware owns hands out the partner's own
    // unpublished bundle, icon or validator findings, with no auth — see
    // isLocalHostname's own docblock for what this adds on top of
    // Gruntfile.js's loopback-only bind (DNS rebinding specifically).
    // Checked before the method guard below so a non-local Host is rejected
    // uniformly regardless of method, and before any route-specific handler
    // ever reads the request.
    if (!isLocalHostname(req.headers && req.headers.host)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    // Every route this middleware owns is read-only, so reject any other
    // method uniformly here, before dispatching to a specific route handler.
    // Previously only /preview.config.json and /template-validation.json
    // carried this guard; /template-bundle/..., /template-icon/..., and
    // /lib/resolve-locale.js accepted POST/PUT/DELETE etc. as if they were
    // GET.
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.end('Method Not Allowed');
      return;
    }

    if (isConfigRoute) {
      servePreviewConfig(req, res, templateRoot);
      return;
    }

    if (isResolveLocaleRoute) {
      serveResolveLocaleScript(req, res);
      return;
    }

    if (isTemplateRuntimeRoute) {
      serveTemplateRuntimeScript(req, res);
      return;
    }

    if (isValidationRoute) {
      let validationConfig;
      try {
        validationConfig = readPreviewConfig(templateRoot);
      } catch (error) {
        // Unlike sendInvalidConfigError's plain-text 500 (used by the other
        // routes below), this route's contract is `{ ok, errors }` JSON — the
        // checkout shell mock's banner only ever renders on a 2xx response
        // from this endpoint. A bad preview.config.json (a malformed
        // defaultLocale, a bundleDir that doesn't exist, ...) used to 500
        // here, which meant exactly the mistakes an author is most likely to
        // make while editing showed no banner at all, only a bare failure in
        // the iframe. Reporting it the same way loadBundle/validate() failures
        // already are keeps this route's own promise: "this endpoint's only
        // job is describing what's wrong with the bundle, so it should never
        // itself be the thing that's broken."
        console.error('Invalid preview.config.json:', error);
        sendValidationResult(res, loadFailureResult(error, [templateRoot]));
        return;
      }
      serveTemplateValidation(validationConfig, req, res, templateRoot);
      return;
    }

    if (isIconRoute) {
      serveTemplateIcon(req, res, templateRoot);
      return;
    }

    let config;
    try {
      config = readPreviewConfig(templateRoot);
    } catch (error) {
      sendInvalidConfigError(res, error);
      return;
    }

    let relativePath;
    try {
      relativePath = decodeURIComponent(req.url.slice(BUNDLE_PREFIX.length).split('?')[0]);
    } catch (error) {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }

    const normalizedPath = normalizeIndexPath(relativePath);

    // Lexical containment check FIRST, with no filesystem access: resolving a
    // path via fs.realpathSync requires the target to exist, and doing that
    // before checking containment turns a 403-vs-404 status difference into
    // an oracle that lets a request enumerate the existence of arbitrary
    // files on disk via `/template-bundle/../../../../etc/passwd`-style
    // requests — independent of whether the escaping path is
    // percent-encoded, and regardless of who can reach this route at all.
    // `normalizedPath` is
    // already decoded and normalized above, so a plain string-based
    // path.resolve + containment check here is enough to catch every
    // escaping request uniformly, before anything touches the disk.
    //
    // This check — and the "is this the index?" decision right after it —
    // must run on `lexicalTarget` (the resolved absolute path), never on the
    // raw relative string. A URL like `/template-bundle/../reference/index.html`
    // has a relative form that isn't literally `index.html`, but can still
    // *resolve* back inside the bundle (or to the bundle's own index.html)
    // once `..` segments are collapsed. Deciding "is index?" from the
    // pre-resolution string let such a URL slip past both the wrap/CSP path
    // and the containment check's protection into the raw static-file
    // branch below, serving the unwrapped, unvalidated fragment.
    const lexicalTarget = path.resolve(config.bundlePath, normalizedPath);
    if (!isPathContained(config.bundlePath, lexicalTarget)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    // `normalizeIndexPath('')` normalizes to `'.'`, and `path.resolve(bundlePath,
    // '.')` returns `bundlePath` itself, so the first arm below covers the
    // bare `/template-bundle/` request (with its trailing slash — a bare
    // `/template-bundle`, with no trailing slash, doesn't match BUNDLE_PREFIX
    // at all and is sent to `next()` earlier, before any of this code runs);
    // the second arm covers every other path (however it was spelled,
    // including via `..` segments) that resolves to `<bundlePath>/index.html`.
    // Comparison
    // is case-insensitive on purpose: case-insensitive filesystems (default
    // on macOS/APFS, and Windows) resolve `INDEX.HTML` to the same physical
    // file as `index.html`, so a case-sensitive comparison here would let
    // that request fall through to the static-file branch below and serve
    // the raw, unwrapped fragment with no CSP and no validation.
    const indexTarget = path.join(config.bundlePath, 'index.html');
    const isIndex =
      lexicalTarget === config.bundlePath || lexicalTarget.toLowerCase() === indexTarget.toLowerCase();

    if (isIndex) {
      // Only the exact canonical forms are served in place (case-insensitive).
      // Anything else that resolves to the index (a doubled slash, a
      // trailing slash, `./index.html`, `../reference/index.html`, ...) is
      // redirected to the canonical URL instead: serving the wrap directly
      // at a non-canonical URL leaves the wrapped document's *base* URL
      // non-canonical too, so every relative reference in it (style.css,
      // asset-*) resolves against the wrong path and 404s/500s (ENOTDIR) —
      // and, for the `..`-escaping forms specifically, redirecting (rather
      // than serving) means the raw string is never treated as "already the
      // index" and routed around the wrap/CSP/validation path.
      const lowerRelative = relativePath.toLowerCase();
      const isCanonical = lowerRelative === '' || lowerRelative === '.' || lowerRelative === 'index.html';
      if (!isCanonical) {
        const queryIndex = req.url.indexOf('?');
        const querySuffix = queryIndex === -1 ? '' : req.url.slice(queryIndex);
        res.statusCode = 301;
        // Every other response sets this; without it, a dev server's redirect
        // is otherwise cacheable by the browser heuristically/persistently.
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Location', BUNDLE_PREFIX + 'index.html' + querySuffix);
        res.end();
        return;
      }
      serveWrappedIndex(config, req, res);
      return;
    }

    // lib/load-bundle.js deliberately excludes dotfiles (any path segment
    // starting with `.`) from the bundle contract, so nothing that matches
    // one could ever have come from a validated/wrapped bundle in the first
    // place. Without this guard, the static-file branch below would still
    // happily stream them straight off disk by realpath alone — serving
    // `.env`, `.git/config`, editor swap files, etc. over HTTP with no
    // prerequisite at all. `isIndex` is already false here, so the canonical
    // `''`/`.`/`index.html` cases above are unaffected.
    if (normalizedPath.split(path.sep).some(function (segment) { return segment.startsWith('.'); })) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    // Same reasoning one step further: containment says *where* a file may
    // live, never *what* it may be called, so this branch used to stream any
    // filename that happened to sit inside the bundle directory — including
    // a stray `evil.html`, served as text/html, at the preview server's own
    // origin and outside the sandboxed iframe. lib/load-bundle.js rejects the
    // whole bundle over such a file, but it is never consulted for an
    // individual request, so the contract check has to happen here too — by
    // asking load-bundle.js itself rather than by restating its rule.
    //
    // Checked against the full `normalizedPath`, not `path.basename(...)`: the
    // bundle contract is a FLAT folder (CONTRACT.md), so a legitimate name is
    // never inside a subdirectory in the first place, and every arm of
    // isAllowedBundleFilename is a full-string match/anchored regex — a nested
    // path like `old/index.html` fails all of them as a whole, whereas taking
    // just its basename would wrongly compare `index.html` alone and pass. That
    // gap mattered here specifically: index.html is the one name this branch
    // must never serve unwrapped (the canonical one is handled above, wrapped
    // and with its CSP), and it was the one name basename-only checking let
    // slip back in through any subdirectory.
    //
    // Lexical, like the dotfile guard above it, and deliberately before any
    // realpathSync/statSync, so a disallowed name answers 404 identically
    // whether or not the file exists.
    if (!isAllowedBundleFilename(normalizedPath)) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    let resolvedRoot;
    let resolvedFile;
    try {
      resolvedRoot = fs.realpathSync(config.bundlePath);
      resolvedFile = fs.realpathSync(lexicalTarget);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }
      res.statusCode = 500;
      res.end('Failed to resolve path');
      return;
    }

    // Second containment check, now against the realpath'd result: this is
    // what still catches a symlink inside the bundle that points outside it
    // (the lexical check above can't see through symlinks).
    if (!isPathContained(resolvedRoot, resolvedFile)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    let stat;
    try {
      stat = fs.statSync(resolvedFile);
    } catch (error) {
      // The file can vanish (or become inaccessible) in the window between
      // the realpathSync above and this stat — treat that race the same as
      // "not found" instead of letting a synchronous throw escape to
      // connect's default handler, which would leak a stack trace and an
      // absolute filesystem path back to the client.
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    // !isFile(), not isDirectory(): same reasoning as serveTemplateIcon's own
    // copy of this check — a FIFO would make streamFile's fs.createReadStream
    // hang open() indefinitely waiting for a writer, on every request.
    if (!stat.isFile()) {
      next();
      return;
    }

    // contentType(normalizedPath), not resolvedFile: normalizedPath already
    // passed isAllowedBundleFilename above, so its own extension is what
    // decides the Content-Type — sniffing resolvedFile instead would trust
    // whatever a symlink inside the bundle actually points to (e.g. a
    // contract-shaped `asset-x.png` symlinked to an `evil.html` elsewhere in
    // the same bundle, which containment alone doesn't catch: the resolved
    // target is still inside the bundle, just not what the name claims it is).
    //
    // Streamed whole, whatever its size: CONTRACT.md's per-file caps (and the
    // 4 MB ceiling past which a text file is no longer read whole) only bound
    // what loadBundle reads (lib/load-bundle.js) — what the server inlines
    // (index.html, i18n) and what it hands the validator. An over-cap
    // style.css or asset renders in full here, and the banner's maxFileSize
    // finding is what tells the author upload would reject it.
    streamFile(resolvedFile, res, contentType(normalizedPath));
  };
}

module.exports = {
  BUNDLE_PREFIX,
  ICON_PREFIX,
  PREVIEW_CONFIG_PATH,
  RESOLVE_LOCALE_SCRIPT_PATH,
  TEMPLATE_RUNTIME_SCRIPT_PATH,
  TEMPLATE_VALIDATION_PATH,
  createPreviewMiddleware,
  loadFailureResult,
  normalizeIndexPath,
  runTemplateValidation,
  sanitizeErrorMessage,
  // Tests only: see sanitizeErrorMessageForRoot.
  _sanitizeErrorMessageForRoot: sanitizeErrorMessageForRoot,
};
