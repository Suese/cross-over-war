// Pointer + keyboard input for the adventure map.
//
// Behaviour mirrors HoMM3 closely:
//   • First click on a tile plots a path for the currently-selected hero.
//   • Second click on the same destination (or pressing M) sends the move.
//   • Right-click clears the current plan.
//   • Mouse wheel zooms; WASD / arrow keys pan the camera.
//   • Hover invokes `onHoverHex` with the (q, r) under the cursor and the
//     currently-planned path so the cursor HUD can show travel days.

import { pixelToHex } from '../map/hex.js';

export function installPointerInput(renderer, hooks) {
  const canvas = renderer.canvas;
  let lastPlannedDestinationKey = null;

  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartTargetX = 0;
  let dragStartTargetZ = 0;

  function pixelUnderPointer(event) {
    const groundPoint = renderer.screenToWorldGroundPoint(event.clientX, event.clientY);
    if (!groundPoint) return null;
    return pixelToHex(groundPoint.x, groundPoint.z, renderer.HEX_SIZE);
  }

  canvas.addEventListener('pointermove', (event) => {
    if (dragging) {
      const deltaX = event.clientX - dragStartX;
      const deltaY = event.clientY - dragStartY;
      // Approximate world units per pixel using current distance.
      const worldPerPixel = renderer.camera.position.distanceTo(renderer.cameraTarget) / 600;
      renderer.cameraTarget.set(
        dragStartTargetX - deltaX * worldPerPixel,
        renderer.cameraTarget.y,
        dragStartTargetZ - deltaY * worldPerPixel,
      );
      renderer.panCamera(0, 0); // re-applies placement
      return;
    }
    const hex = pixelUnderPointer(event);
    if (!hex) return;
    hooks.onHoverHex?.(hex, event);
  });

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button === 2) return; // right-click handled in contextmenu
    if (event.button === 1) {
      dragging = true;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragStartTargetX = renderer.cameraTarget.x;
      dragStartTargetZ = renderer.cameraTarget.z;
      canvas.setPointerCapture(event.pointerId);
      return;
    }
  });

  canvas.addEventListener('pointerup', (event) => {
    if (event.button === 1 && dragging) {
      dragging = false;
      try { canvas.releasePointerCapture(event.pointerId); } catch {}
      return;
    }
    if (event.button !== 0) return;
    const hex = pixelUnderPointer(event);
    if (!hex) return;
    const key = hex.q + ',' + hex.r;
    if (lastPlannedDestinationKey === key) {
      // Same destination clicked again → execute the move.
      hooks.onConfirmMove?.(hex);
      lastPlannedDestinationKey = null;
      return;
    }
    lastPlannedDestinationKey = key;
    hooks.onPlanPath?.(hex);
  });

  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    lastPlannedDestinationKey = null;
    hooks.onClearPath?.();
  });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 1.1 : 0.9;
    renderer.zoomCamera(factor);
  }, { passive: false });

  // ── Continuous WASD / arrow scrolling ──────────────────────────────────
  // Track which pan keys are currently held and pan once per animation frame.
  // Step is scaled by the current camera distance so the scroll feels the
  // same speed whether zoomed in or out (covering roughly the same fraction
  // of the visible viewport per second at any zoom).
  const PAN_KEYS = new Map([
    ['w', { dx: 0, dz: -1 }], ['ArrowUp',    { dx: 0, dz: -1 }],
    ['s', { dx: 0, dz:  1 }], ['ArrowDown',  { dx: 0, dz:  1 }],
    ['a', { dx: -1, dz: 0 }], ['ArrowLeft',  { dx: -1, dz: 0 }],
    ['d', { dx:  1, dz: 0 }], ['ArrowRight', { dx:  1, dz: 0 }],
  ]);
  // Normalise so W and w both work.
  function normaliseKey(key) {
    if (key.length === 1) return key.toLowerCase();
    return key;
  }
  const heldPanKeys = new Set();
  let lastFrameTimeMs = performance.now();

  function panEachFrame(nowMs) {
    const deltaSeconds = Math.min(0.1, (nowMs - lastFrameTimeMs) / 1000);
    lastFrameTimeMs = nowMs;
    if (heldPanKeys.size > 0) {
      let dx = 0, dz = 0;
      for (const key of heldPanKeys) {
        const dir = PAN_KEYS.get(key);
        if (!dir) continue;
        dx += dir.dx;
        dz += dir.dz;
      }
      if (dx !== 0 || dz !== 0) {
        // Speed = camera distance per second (so at distance 30 you cross
        // ~30 world units in 1 s — about a full viewport).
        const cameraDistance = renderer.camera.position.distanceTo(renderer.cameraTarget);
        const speed = cameraDistance * 1.2;
        const length = Math.hypot(dx, dz);
        renderer.panCamera(
          (dx / length) * speed * deltaSeconds,
          (dz / length) * speed * deltaSeconds,
        );
      }
    }
    requestAnimationFrame(panEachFrame);
  }
  requestAnimationFrame(panEachFrame);

  document.addEventListener('keydown', (event) => {
    if (event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA')) return;
    const key = normaliseKey(event.key);
    if (key === 'm') {
      hooks.onConfirmMove?.(null);
      lastPlannedDestinationKey = null;
      return;
    }
    if (key === 'Escape') {
      hooks.onClearPath?.();
      lastPlannedDestinationKey = null;
      return;
    }
    if (PAN_KEYS.has(key)) {
      heldPanKeys.add(key);
      event.preventDefault();   // stop arrow keys from scrolling the page
    }
  });

  document.addEventListener('keyup', (event) => {
    const key = normaliseKey(event.key);
    if (PAN_KEYS.has(key)) heldPanKeys.delete(key);
  });

  // Drop held keys if the window loses focus — otherwise the camera keeps
  // panning forever after the user alt-tabs.
  window.addEventListener('blur', () => heldPanKeys.clear());
}
