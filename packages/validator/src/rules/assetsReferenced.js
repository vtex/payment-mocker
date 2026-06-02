const path = require('path');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico']);

function isExternalOrData(ref) {
  return /^https?:\/\//i.test(ref) || /^data:/i.test(ref);
}

function collectRefs(content, pattern) {
  const refs = new Set();
  let match;
  const re = new RegExp(pattern, 'gi');
  while ((match = re.exec(content)) !== null) {
    const ref = match[1];
    if (!isExternalOrData(ref) && !ref.startsWith('/')) {
      refs.add(ref);
    }
  }
  return refs;
}

function assetsReferenced(template) {
  const refs = new Set();

  if (template.html) {
    for (const r of collectRefs(template.html.content, /(?:src|href)\s*=\s*["']([^"'#?]+)/)) refs.add(r);
  }
  if (template.css) {
    for (const r of collectRefs(template.css.content, /url\s*\(\s*["']?([^"')]+)/)) refs.add(r);
  }

  // Resolve refs to absolute paths relative to templateDir
  const resolveRef = (ref) => {
    if (template.html && !ref.startsWith('./') && !ref.startsWith('../')) {
      return path.resolve(template.templateDir, ref);
    }
    return path.resolve(template.templateDir, ref);
  };

  const assetPaths = new Set((template.assets || []).map(a => a.path));
  const imageAssets = (template.assets || []).filter(a => IMAGE_EXTS.has(path.extname(a.path).toLowerCase()));
  const imageAssetPaths = new Set(imageAssets.map(a => a.path));

  const errors = [];

  // Broken references: ref in HTML/CSS → file not in assets
  for (const ref of refs) {
    if (path.extname(ref) === '' || !IMAGE_EXTS.has(path.extname(ref).toLowerCase())) continue;
    const abs = resolveRef(ref);
    if (!assetPaths.has(abs)) {
      errors.push({
        rule: 'assetsReferenced',
        message: `Referência quebrada: "${ref}" não encontrado nos assets (vai dar 404 em produção)`,
        severity: 'error',
      });
    }
  }

  // Orphan assets: image file present but never referenced
  const referencedAbs = new Set([...refs].map(resolveRef));
  for (const asset of imageAssets) {
    const name = path.basename(asset.path);
    // Check by basename too (HTML often references just the filename)
    const isReferenced = referencedAbs.has(asset.path) ||
      [...refs].some(r => path.basename(r) === name || r === name);
    if (!isReferenced) {
      errors.push({
        rule: 'assetsReferenced',
        message: `Asset órfão: "${name}" presente mas nunca referenciado em HTML ou CSS`,
        file: asset.path,
        severity: 'warning',
      });
    }
  }

  return errors;
}

assetsReferenced.ruleName = 'assetsReferenced';
assetsReferenced.describe = function(template) {
  const imgs = (template.assets || []).filter(a => IMAGE_EXTS.has(path.extname(a.path).toLowerCase())).length;
  return `${imgs} imagem(ns) nos assets`;
};
module.exports = assetsReferenced;
