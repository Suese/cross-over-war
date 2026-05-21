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

  document.addEventListener('keydown', (event) => {
    // Ignore keys when focus is in an input.
    if (event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA')) return;
    if (event.key === 'm' || event.key === 'M') {
      hooks.onConfirmMove?.(null);
      lastPlannedDestinationKey = null;
      return;
    }
    if (event.key === 'Escape') {
      hooks.onClearPath?.();
      lastPlannedDestinationKey = null;
      return;
    }
    const panStep = 1.2;
    if (event.key === 'w' || event.key === 'ArrowUp')    renderer.panCamera(0, -panStep);
    if (event.key === 's' || event.key === 'ArrowDown')  renderer.panCamera(0,  panStep);
    if (event.key === 'a' || event.key === 'ArrowLeft')  renderer.panCamera(-panStep, 0);
    if (event.key === 'd' || event.key === 'ArrowRight') renderer.panCamera( panStep, 0);
  });
}
