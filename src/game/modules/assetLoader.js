// Asset loader (streaming).
//
// Models / textures are loaded on demand — every consumer that asks for an
// asset gets called back when the bytes arrive. While a load is pending,
// renderers display a placeholder (a grey cube) and swap it for the real
// mesh once the GLB resolves. Nothing is loaded until something on screen
// asks for it; points of interest that the player never explores never
// trigger a download.
//
// LRU eviction
// ─────────────
// Meshes that reference a loaded model call `acquireModel(key)` when they
// mount it into the scene and `releaseModel(key)` when they're disposed.
// `evictIfOverCapacity()` runs after each successful load: when the loaded
// count exceeds `MAX_LOADED_MODELS`, the oldest refcount-zero models are
// disposed (geometries + materials), freeing GPU memory. Models still
// referenced by a live mesh stay pinned.
//
// Textures
// ────────
// Three.js's TextureLoader.load returns the texture handle synchronously,
// then patches the image bytes onto it when the request resolves — so the
// Material binds to the same Texture object both before and after the load.
// We track `lastTouchedByKey` for textures too but don't currently evict
// them (texture disposal would require rewriting every referencing
// Material's `map` slot, which is rarely worth it for this game's volume).

import { TextureLoader, SRGBColorSpace, RepeatWrapping } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const textureLoader = new TextureLoader();
const modelLoader = new GLTFLoader();

const TEXTURE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const MODEL_EXTS = ['.glb', '.gltf'];

// Cap on how many GLB scenes we keep loaded at once. The mountains tile
// alone weighs ~113 MB so generous defaults are bad — but for a 64×64 map
// the player will see ~9 terrains plus a couple of dozen distinct POIs,
// well within this limit. Bump it (via `setMaxLoadedModels`) if a module
// ships a lot of variety.
const DEFAULT_MAX_LOADED_MODELS = 32;

function hasAnyExtension(name, extensions) {
  const lowered = name.toLowerCase();
  for (const ext of extensions) if (lowered.endsWith(ext)) return true;
  return false;
}

export function createAssetLoader() {
  const urlsByKey = new Map();                // 'base/plains.glb' → url
  const textureCache = new Map();             // key → THREE.Texture (handle, may still be loading)
  const texturePromises = new Map();          // key → Promise<THREE.Texture>
  const modelStateByKey = new Map();          // key → 'unloaded' | 'loading' | 'loaded' | 'failed'
  const modelSceneCache = new Map();          // key → THREE.Group (the GLB scene root)
  const modelSubscribers = new Map();         // key → Set<(scene|null) => void>
  const modelRefcountByKey = new Map();       // key → number (pin counter)
  const lastTouchedByKey = new Map();         // key → ms timestamp
  const missingAssets = [];                   // [{ moduleName, key, kind, requestedBy }]
  let maxLoadedModels = DEFAULT_MAX_LOADED_MODELS;

  function registerModuleAssets(moduleName, urlsByRelativePath) {
    for (const [relative, url] of urlsByRelativePath) {
      urlsByKey.set(moduleName + '/' + relative, url);
    }
  }

  function hasAsset(key) {
    return urlsByKey.has(key);
  }

  function touch(key) {
    lastTouchedByKey.set(key, performance.now());
  }

  function recordMissing(key, kind, requestedBy) {
    missingAssets.push({
      key, kind,
      moduleName: key.split('/')[0],
      requestedBy: requestedBy ?? null,
    });
  }

  // ── Textures ──────────────────────────────────────────────────────────
  function configureTexture(texture, options) {
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.anisotropy = options?.anisotropy ?? 4;
  }

  function getTexture(key, options = {}) {
    if (!urlsByKey.has(key)) { recordMissing(key, 'texture', options.requestedBy); return null; }
    touch(key);
    if (textureCache.has(key)) return textureCache.get(key);
    let resolveLater;
    const promise = new Promise((resolve) => { resolveLater = resolve; });
    const texture = textureLoader.load(
      urlsByKey.get(key),
      (loaded) => resolveLater(loaded),
      undefined,
      () => resolveLater(null),
    );
    configureTexture(texture, options);
    textureCache.set(key, texture);
    texturePromises.set(key, promise);
    return texture;
  }

  function loadTextureAsync(key, options = {}) {
    if (!urlsByKey.has(key)) { recordMissing(key, 'texture', options.requestedBy ?? 'async'); return Promise.resolve(null); }
    if (texturePromises.has(key)) { touch(key); return texturePromises.get(key); }
    getTexture(key, options);          // sets up cache and promise
    return texturePromises.get(key);
  }

  // ── Models (streaming) ────────────────────────────────────────────────
  // `requestModel(key, onLoad)` is the streaming entry point. Behaviour:
  //   • If the asset has already loaded, `onLoad(scene)` fires synchronously
  //     (within the call) and the function returns the scene.
  //   • If it's currently loading, `onLoad` is queued and fires when the
  //     in-flight load resolves; returns null.
  //   • If it's unloaded, the load is kicked off, `onLoad` is queued, and
  //     null is returned.
  //   • If the asset doesn't exist at all (no URL registered), `onLoad(null)`
  //     fires synchronously and we record a missing-asset entry.
  function requestModel(key, onLoad, options = {}) {
    if (!urlsByKey.has(key)) {
      recordMissing(key, 'model', options.requestedBy);
      onLoad?.(null);
      return null;
    }
    touch(key);
    const state = modelStateByKey.get(key) ?? 'unloaded';

    if (state === 'loaded') {
      const scene = modelSceneCache.get(key);
      onLoad?.(scene);
      return scene;
    }

    if (state === 'failed') {
      onLoad?.(null);
      return null;
    }

    // Queue the callback so the loader notifies it when the load resolves.
    if (onLoad) {
      let subs = modelSubscribers.get(key);
      if (!subs) { subs = new Set(); modelSubscribers.set(key, subs); }
      subs.add(onLoad);
    }

    if (state === 'loading') return null;

    // Kick off the actual download.
    modelStateByKey.set(key, 'loading');
    modelLoader.load(
      urlsByKey.get(key),
      (gltf) => {
        modelStateByKey.set(key, 'loaded');
        modelSceneCache.set(key, gltf.scene);
        touch(key);
        const subs = modelSubscribers.get(key);
        if (subs) {
          for (const cb of subs) { try { cb(gltf.scene); } catch (err) { console.error('asset subscriber', err); } }
          modelSubscribers.delete(key);
        }
        evictIfOverCapacity();
      },
      undefined,
      (error) => {
        modelStateByKey.set(key, 'failed');
        console.warn('model load failed for ' + key + ':', error);
        const subs = modelSubscribers.get(key);
        if (subs) {
          for (const cb of subs) { try { cb(null); } catch (err) { console.error('asset subscriber', err); } }
          modelSubscribers.delete(key);
        }
      },
    );
    return null;
  }

  // Legacy promise-shaped helper. Internally re-uses `requestModel` so the
  // subscriber list and state machine stay coherent.
  function loadModel(key, options = {}) {
    return new Promise((resolve) => {
      requestModel(key, (scene) => resolve(scene ?? null), options);
    });
  }

  // Synchronous accessor — returns the cached scene root or null if it
  // hasn't loaded yet. Doesn't trigger a load.
  function getModel(key) {
    if (modelSceneCache.has(key)) { touch(key); return modelSceneCache.get(key); }
    return null;
  }

  function getModelState(key) {
    if (!urlsByKey.has(key)) return 'missing';
    return modelStateByKey.get(key) ?? 'unloaded';
  }

  // Refcount: a live mesh that depends on the model's geometry / material
  // must acquire on construction and release on disposal. Acquired models
  // are pinned against LRU eviction.
  function acquireModel(key) {
    if (!urlsByKey.has(key)) return;
    modelRefcountByKey.set(key, (modelRefcountByKey.get(key) ?? 0) + 1);
    touch(key);
  }

  function releaseModel(key) {
    if (!urlsByKey.has(key)) return;
    const current = modelRefcountByKey.get(key) ?? 0;
    if (current <= 1) modelRefcountByKey.delete(key);
    else modelRefcountByKey.set(key, current - 1);
    touch(key);
  }

  function setMaxLoadedModels(value) {
    if (typeof value === 'number' && value > 0) maxLoadedModels = value;
  }

  function evictIfOverCapacity() {
    if (modelSceneCache.size <= maxLoadedModels) return;
    // Candidates: loaded models with refcount 0, sorted by lastTouched asc.
    const candidates = [];
    for (const key of modelSceneCache.keys()) {
      if ((modelRefcountByKey.get(key) ?? 0) > 0) continue;
      candidates.push(key);
    }
    candidates.sort(
      (a, b) => (lastTouchedByKey.get(a) ?? 0) - (lastTouchedByKey.get(b) ?? 0),
    );
    let surplus = modelSceneCache.size - maxLoadedModels;
    for (const key of candidates) {
      if (surplus <= 0) break;
      disposeModel(key);
      surplus--;
    }
  }

  function disposeModel(key) {
    const scene = modelSceneCache.get(key);
    if (!scene) return;
    scene.traverse((child) => {
      child.geometry?.dispose?.();
      const material = child.material;
      if (Array.isArray(material)) {
        for (const m of material) m?.dispose?.();
      } else {
        material?.dispose?.();
      }
    });
    modelSceneCache.delete(key);
    modelStateByKey.delete(key);
    lastTouchedByKey.delete(key);
  }

  // Iterate every discovered asset URL — useful for diagnostics.
  function listAllAssetKeys() {
    return Array.from(urlsByKey.keys());
  }
  function listTextureKeys() {
    return listAllAssetKeys().filter(key => hasAnyExtension(key, TEXTURE_EXTS));
  }
  function listModelKeys() {
    return listAllAssetKeys().filter(key => hasAnyExtension(key, MODEL_EXTS));
  }
  function getMissingAssets() { return missingAssets.slice(); }

  // Diagnostic: a snapshot of what's loaded right now, sorted by lastTouched.
  function describeCacheState() {
    return Array.from(modelSceneCache.keys()).map((key) => ({
      key,
      refcount: modelRefcountByKey.get(key) ?? 0,
      lastTouched: lastTouchedByKey.get(key) ?? 0,
    })).sort((a, b) => b.lastTouched - a.lastTouched);
  }

  return {
    registerModuleAssets,
    hasAsset,
    // Textures
    getTexture,
    loadTextureAsync,
    // Models — streaming
    requestModel,
    loadModel,
    getModel,
    getModelState,
    acquireModel,
    releaseModel,
    setMaxLoadedModels,
    evictIfOverCapacity,
    // Diagnostics
    listAllAssetKeys,
    listTextureKeys,
    listModelKeys,
    getMissingAssets,
    describeCacheState,
  };
}
