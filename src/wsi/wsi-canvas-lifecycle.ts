import type { OrthoCamera } from "../core/ortho-camera";

export interface RendererCanvasHandlers {
  pointerDown: (event: PointerEvent) => void;
  pointerMove: (event: PointerEvent) => void;
  pointerUp: (event: PointerEvent) => void;
  wheel: (event: WheelEvent) => void;
  doubleClick: (event: MouseEvent) => void;
  contextMenu: (event: MouseEvent) => void;
  contextLost: (event: Event) => void;
  contextRestored: (event: Event) => void;
}

export function addRendererCanvasEventListeners(canvas: HTMLCanvasElement, handlers: RendererCanvasHandlers): void {
  canvas.addEventListener("pointerdown", handlers.pointerDown);
  canvas.addEventListener("pointermove", handlers.pointerMove);
  canvas.addEventListener("pointerup", handlers.pointerUp);
  canvas.addEventListener("pointercancel", handlers.pointerUp);
  canvas.addEventListener("wheel", handlers.wheel, { passive: false });
  canvas.addEventListener("dblclick", handlers.doubleClick);
  canvas.addEventListener("contextmenu", handlers.contextMenu);
  canvas.addEventListener("webglcontextlost", handlers.contextLost);
  canvas.addEventListener("webglcontextrestored", handlers.contextRestored);
}

export function removeRendererCanvasEventListeners(canvas: HTMLCanvasElement, handlers: RendererCanvasHandlers): void {
  canvas.removeEventListener("pointerdown", handlers.pointerDown);
  canvas.removeEventListener("pointermove", handlers.pointerMove);
  canvas.removeEventListener("pointerup", handlers.pointerUp);
  canvas.removeEventListener("pointercancel", handlers.pointerUp);
  canvas.removeEventListener("wheel", handlers.wheel);
  canvas.removeEventListener("dblclick", handlers.doubleClick);
  canvas.removeEventListener("contextmenu", handlers.contextMenu);
  canvas.removeEventListener("webglcontextlost", handlers.contextLost);
  canvas.removeEventListener("webglcontextrestored", handlers.contextRestored);
}

export function resizeCanvasViewport(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, camera: OrthoCamera): void {
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(1, rect.width || canvas.clientWidth || 1);
  const cssH = Math.max(1, rect.height || canvas.clientHeight || 1);
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  const pixelW = Math.max(1, Math.round(cssW * dpr));
  const pixelH = Math.max(1, Math.round(cssH * dpr));

  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }

  camera.setViewport(cssW, cssH);
  gl.viewport(0, 0, pixelW, pixelH);
}
