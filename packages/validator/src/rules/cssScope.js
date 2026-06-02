// Exempted at-rule prefixes that don't have CSS selectors as their block head
const EXEMPT_AT_RULES = /^@(keyframes|font-face|charset|namespace)/i;

function extractSelectors(css) {
  // Remove comments
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  // Match selector blocks: capture everything before { up to the previous }
  // We walk char-by-char tracking depth
  let depth = 0;
  let blockStart = 0;
  let selectorBuffer = '';

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') {
      if (depth === 0) {
        selectorBuffer = stripped.slice(blockStart, i).trim();
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        if (selectorBuffer) {
          selectors.push(selectorBuffer);
        }
        selectorBuffer = '';
        blockStart = i + 1;
      }
    }
  }
  return selectors;
}

function cssScope(template) {
  if (!template.css) return [];

  const selectors = extractSelectors(template.css.content);
  const errors = [];

  for (const sel of selectors) {
    // Skip exempt at-rules like @keyframes, @font-face
    if (EXEMPT_AT_RULES.test(sel)) continue;

    // @media / @supports: extract inner selectors by recursing on the block content
    // At depth 0, @media "selector" is the at-rule condition, not a CSS selector
    if (/^@(media|supports|layer)/i.test(sel)) continue;

    // Split multiple selectors (comma-separated)
    const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (!part.includes('[data-payment-template]')) {
        errors.push({
          rule: 'cssScope',
          message: `Seletor CSS fora do escopo [data-payment-template]: "${part.slice(0, 60)}"`,
          file: template.css.path,
          severity: 'warning',
        });
      }
    }
  }

  return errors;
}

// Recurse into @media blocks to check inner selectors
function cssScopeDeep(template) {
  if (!template.css) return [];
  return cssScopeWithContent(template.css.content, template.css.path);
}

function cssScopeWithContent(css, filePath) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const errors = [];
  let depth = 0;
  let blockStart = 0;
  let selectorBuf = '';
  let innerContent = '';
  let innerStart = 0;

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') {
      if (depth === 0) {
        selectorBuf = stripped.slice(blockStart, i).trim();
        innerStart = i + 1;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        innerContent = stripped.slice(innerStart, i);

        if (!EXEMPT_AT_RULES.test(selectorBuf)) {
          if (/^@(media|supports|layer)/i.test(selectorBuf)) {
            // Recurse into @media block
            errors.push(...cssScopeWithContent(innerContent, filePath));
          } else {
            // Regular selector
            const parts = selectorBuf.split(',').map(s => s.trim()).filter(Boolean);
            for (const part of parts) {
              if (!part.includes('[data-payment-template]')) {
                errors.push({
                  rule: 'cssScope',
                  message: `Seletor CSS fora do escopo [data-payment-template]: "${part.slice(0, 60)}"`,
                  file: filePath,
                  severity: 'warning',
                });
              }
            }
          }
        }

        selectorBuf = '';
        blockStart = i + 1;
      }
    }
  }
  return errors;
}

function cssScopeRule(template) {
  if (!template.css) return [];
  return cssScopeWithContent(template.css.content, template.css.path);
}

cssScopeRule.ruleName = 'cssScope';
cssScopeRule.describe = function(template) {
  return template.css ? 'CSS' : 'sem CSS';
};
module.exports = cssScopeRule;
