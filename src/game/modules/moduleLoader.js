// Module loader. Every folder under src/modules/<name>/ with an index.js
// file is treated as a module. Each module's default export looks like:
//
//   export default {
//     name: 'base',
//     depends: [],                 // other module names (optional)
//     register({ world, registry, assets, log }) { ... },
//   };
//
// Adding or removing a folder under src/modules/ installs or removes the
// module — Vite's import.meta.glob scans the tree at build/dev time, so no
// manual registration list is needed. Asset PNG/JPEG/GLB files alongside each
// module are likewise auto-discovered.

const moduleEntries = import.meta.glob('../../modules/*/index.js', { eager: true });
const moduleAssets  = import.meta.glob(
  '../../modules/*/assets/**/*.{png,jpg,jpeg,webp,glb,gltf}',
  { eager: true, query: '?url', import: 'default' },
);

// Vite returns import paths relative to this file. We just need the module
// name (the folder under modules/). This regex pulls it out.
const NAME_REGEXP = /\.\.\/\.\.\/modules\/([^/]+)\//;

function parseModuleName(path) {
  const match = NAME_REGEXP.exec(path);
  return match ? match[1] : null;
}

// Returns { name, definition, assetUrlsByRelativePath } for each discovered
// module — assets are keyed by their path within the module's assets/
// directory (e.g. 'grass.png', 'subdir/icon.png').
export function discoverModules() {
  const discovered = new Map();

  for (const [path, module] of Object.entries(moduleEntries)) {
    const name = parseModuleName(path);
    if (!name) continue;
    const definition = module.default;
    if (!definition || typeof definition.register !== 'function') {
      console.warn('module ' + name + ' has no default export with register()');
      continue;
    }
    if (definition.name && definition.name !== name) {
      console.warn(
        'module folder ' + name + " declares mismatched name '" + definition.name + "'",
      );
    }
    discovered.set(name, {
      name,
      definition: { ...definition, name },
      assetUrlsByRelativePath: new Map(),
    });
  }

  for (const [path, url] of Object.entries(moduleAssets)) {
    const name = parseModuleName(path);
    if (!name) continue;
    const entry = discovered.get(name);
    if (!entry) continue;
    // Strip everything up to and including "/assets/".
    const assetsIndex = path.indexOf('/assets/');
    if (assetsIndex < 0) continue;
    const relative = path.slice(assetsIndex + '/assets/'.length);
    entry.assetUrlsByRelativePath.set(relative, url);
  }

  return discovered;
}

// Sort modules so any module appears after every module it depends on.
// Throws on missing deps or cycles.
export function sortModulesByDependency(discovered) {
  const visited = new Set();
  const sorted = [];
  const stack = new Set();

  function visit(name) {
    if (visited.has(name)) return;
    if (stack.has(name)) throw new Error('module dependency cycle at ' + name);
    const entry = discovered.get(name);
    if (!entry) throw new Error('missing module dependency: ' + name);
    stack.add(name);
    const dependencies = entry.definition.depends ?? [];
    for (const dependencyName of dependencies) visit(dependencyName);
    stack.delete(name);
    visited.add(name);
    sorted.push(entry);
  }

  for (const name of discovered.keys()) visit(name);
  return sorted;
}

// Load every module in dependency order, calling each register() with a
// shared context. Returns the ordered module list (handy for logging).
export function loadAllModules(context) {
  const discovered = discoverModules();
  const ordered = sortModulesByDependency(discovered);
  for (const entry of ordered) {
    context.assets.registerModuleAssets(entry.name, entry.assetUrlsByRelativePath);
    entry.definition.register({
      ...context,
      moduleName: entry.name,
      log: (...args) => console.log('[' + entry.name + ']', ...args),
    });
    context.registry.moduleOrder.push(entry.name);
  }
  return ordered;
}
