// Asset loader.
//
// Modules drop PNG / JPEG / WebP / GLB / GLTF files into their assets/
// directory and the module loader hands the resulting Vite URLs to this
// loader, keyed by 'moduleName/relativePath' (e.g. 'base/grass.png').
//
// Callers ask for assets by that same key. Textures are loaded eagerly when
// requested; models are loaded on demand. Missing assets are recorded so the
// audit step (or the in-page console) can list them.

import { TextureLoader, SRGBColorSpace, RepeatWrapping } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const textureLoader = new TextureLoader();
const modelLoader = new GLTFLoader();

const TEXTURE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const MODEL_EXTS = ['.glb', '.gltf'];

function hasAnyExtension(name, extensions) {
  const lowered = name.toLowerCase();
  for (const ext of extensions) if (lowered.endsWith(ext)) return true;
  return false;
}

export function createAssetLoader() {
  const urlsByKey = new Map();           // 'base/grass.png' → url
  const textureCache = new Map();        // key → THREE.Texture
  const modelCache = new Map();          // key → Promise<THREE.Group>
  const missingAssets = [];              // [{ moduleName, key, kind, requestedBy }]

  function registerModuleAssets(moduleName, urlsByRelativePath) {
    for (const [relative, url] of urlsByRelativePath) {
      const key = moduleName + '/' + relative;
      urlsByKey.set(key, url);
    }
  }

  function hasAsset(key) {
    return urlsByKey.has(key);
  }

  function getTexture(key, options = {}) {
    if (!urlsByKey.has(key)) {
      missingAssets.push({
        key,
        kind: 'texture',
        moduleName: key.split('/')[0],
        requestedBy: options.requestedBy ?? null,
      });
      return null;
    }
    if (textureCache.has(key)) return textureCache.get(key);
    const texture = textureLoader.load(urlsByKey.get(key));
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.anisotropy = options.anisotropy ?? 4;
    textureCache.set(key, texture);
    return texture;
  }

  function loadModel(key, options = {}) {
    if (!urlsByKey.has(key)) {
      missingAssets.push({
        key,
        kind: 'model',
        moduleName: key.split('/')[0],
        requestedBy: options.requestedBy ?? null,
      });
      return Promise.resolve(null);
    }
    if (modelCache.has(key)) return modelCache.get(key);
    const promise = new Promise((resolve, reject) => {
      modelLoader.load(urlsByKey.get(key), (gltf) => resolve(gltf.scene), undefined, reject);
    });
    modelCache.set(key, promise);
    return promise;
  }

  // Iterate every discovered asset URL — handy for any "preload everything"
  // pass that wants to warm caches up front.
  function listAllAssetKeys() {
    return Array.from(urlsByKey.keys());
  }

  function listTextureKeys() {
    return listAllAssetKeys().filter(key => hasAnyExtension(key, TEXTURE_EXTS));
  }

  function listModelKeys() {
    return listAllAssetKeys().filter(key => hasAnyExtension(key, MODEL_EXTS));
  }

  function getMissingAssets() {
    return missingAssets.slice();
  }

  return {
    registerModuleAssets,
    hasAsset,
    getTexture,
    loadModel,
    listAllAssetKeys,
    listTextureKeys,
    listModelKeys,
    getMissingAssets,
  };
}
