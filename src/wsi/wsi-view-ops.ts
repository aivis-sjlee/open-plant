import type { OrthoCamera } from "../core/ortho-camera";
import type { WsiImageSource, WsiViewState } from "./types";
import { clamp } from "./utils";
import { toRadians } from "./wsi-normalize";

export function resolveDefaultZoomBounds(fitZoom: number): { minZoom: number; maxZoom: number } {
  const minZoom = Math.max(fitZoom * 0.5, 1e-6);
  const maxZoom = Math.max(1, fitZoom * 8);
  return {
    minZoom,
    maxZoom: Math.max(minZoom, maxZoom),
  };
}

export function resolveZoomBounds(fitZoom: number, minZoomOverride: number | null, maxZoomOverride: number | null): { minZoom: number; maxZoom: number } {
  const defaults = resolveDefaultZoomBounds(fitZoom);
  let minZoom = minZoomOverride ?? defaults.minZoom;
  let maxZoom = maxZoomOverride ?? defaults.maxZoom;
  minZoom = Math.max(1e-6, minZoom);
  maxZoom = Math.max(1e-6, maxZoom);
  if (minZoom > maxZoom) {
    minZoom = maxZoom;
  }
  return { minZoom, maxZoom };
}

export function resolveTargetViewState(
  camera: OrthoCamera,
  minZoom: number,
  maxZoom: number,
  next: Partial<WsiViewState>,
  clampViewState: () => void,
): WsiViewState {
  const current = camera.getViewState();
  const candidate: WsiViewState = {
    zoom: typeof next.zoom === "number" && Number.isFinite(next.zoom) ? clamp(next.zoom, minZoom, maxZoom) : current.zoom,
    offsetX: typeof next.offsetX === "number" && Number.isFinite(next.offsetX) ? next.offsetX : current.offsetX,
    offsetY: typeof next.offsetY === "number" && Number.isFinite(next.offsetY) ? next.offsetY : current.offsetY,
    rotationDeg: typeof next.rotationDeg === "number" && Number.isFinite(next.rotationDeg) ? next.rotationDeg : current.rotationDeg,
  };

  camera.setViewState(candidate);
  clampViewState();
  const target = camera.getViewState();
  camera.setViewState(current);
  return target;
}

export function computeFitToImageTarget(
  source: WsiImageSource,
  viewportWidth: number,
  viewportHeight: number,
  minZoom: number,
  maxZoom: number,
): { fitZoom: number; target: WsiViewState } {
  const zoom = Math.min(viewportWidth / source.width, viewportHeight / source.height);
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const clampedZoom = clamp(safeZoom, minZoom, maxZoom);
  const visibleWorldW = viewportWidth / clampedZoom;
  const visibleWorldH = viewportHeight / clampedZoom;

  return {
    fitZoom: safeZoom,
    target: {
      zoom: clampedZoom,
      offsetX: (source.width - visibleWorldW) * 0.5,
      offsetY: (source.height - visibleWorldH) * 0.5,
      rotationDeg: 0,
    },
  };
}

export function computeZoomByTarget(
  camera: OrthoCamera,
  minZoom: number,
  maxZoom: number,
  factor: number,
  screenX: number,
  screenY: number,
): Partial<WsiViewState> | null {
  const state = camera.getViewState();
  const nextZoom = clamp(state.zoom * factor, minZoom, maxZoom);
  if (nextZoom === state.zoom) return null;

  const [worldX, worldY] = camera.screenToWorld(screenX, screenY);
  const vp = camera.getViewportSize();
  const dx = screenX - vp.width * 0.5;
  const dy = screenY - vp.height * 0.5;
  const rad = toRadians(state.rotationDeg);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const worldDx = (dx / nextZoom) * cos - (dy / nextZoom) * sin;
  const worldDy = (dx / nextZoom) * sin + (dy / nextZoom) * cos;
  const nextCenterX = worldX - worldDx;
  const nextCenterY = worldY - worldDy;

  return {
    zoom: nextZoom,
    offsetX: nextCenterX - vp.width / (2 * nextZoom),
    offsetY: nextCenterY - vp.height / (2 * nextZoom),
  };
}
