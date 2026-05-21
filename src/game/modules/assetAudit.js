// Runtime asset audit. After modules register and the game spins up, any
// asset that was requested but not found is recorded by the asset loader.
// At dev time we drop a markdown summary into the browser console so the
// build step (scripts/audit-assets.mjs) can mirror it into docs/missing_assets.md.

export function formatMissingAssetsMarkdown(missingAssets, declaredReferences) {
  if (missingAssets.length === 0 && declaredReferences.length === 0) {
    return '# Missing assets\n\nNone — every declared and requested asset was found.\n';
  }

  const grouped = new Map();
  for (const entry of missingAssets) {
    const list = grouped.get(entry.moduleName) ?? [];
    list.push(entry);
    grouped.set(entry.moduleName, list);
  }
  // Also surface explicit references that were declared but never resolved at runtime.
  for (const reference of declaredReferences) {
    if (!reference.assetKey) continue;
    if (!reference.exists) {
      const list = grouped.get(reference.moduleName) ?? [];
      list.push({
        key: reference.assetKey,
        kind: reference.kind,
        moduleName: reference.moduleName,
        requestedBy: reference.declaredFor,
      });
      grouped.set(reference.moduleName, list);
    }
  }

  const lines = ['# Missing assets', ''];
  lines.push('Generated automatically — drop files into the corresponding');
  lines.push('module\'s `assets/` folder to satisfy these references.');
  lines.push('');

  const moduleNames = Array.from(grouped.keys()).sort();
  for (const moduleName of moduleNames) {
    lines.push('## ' + moduleName);
    lines.push('');
    const entries = grouped.get(moduleName);
    const seen = new Set();
    for (const entry of entries) {
      const dedupeKey = entry.kind + '|' + entry.key + '|' + (entry.requestedBy ?? '');
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const requested = entry.requestedBy ? ' — requested by `' + entry.requestedBy + '`' : '';
      lines.push('- [' + entry.kind + '] `' + entry.key + '`' + requested);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function logMissingAssetsToConsole(assets, registry) {
  const missing = assets.getMissingAssets();
  if (missing.length === 0) return;
  console.groupCollapsed(
    '%cMissing assets (' + missing.length + ')',
    'color:#ff8888;font-weight:bold',
  );
  for (const entry of missing) {
    const tag = '[' + entry.moduleName + '/' + entry.kind + ']';
    const requested = entry.requestedBy ? ' (requested by ' + entry.requestedBy + ')' : '';
    console.log(tag + ' ' + entry.key + requested);
  }
  console.groupEnd();
}
