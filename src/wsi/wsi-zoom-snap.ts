import type { OrthoCamera } from "../core/ortho-camera";
import type { WsiViewState } from "./types";
import { clamp, nowMs } from "./utils";
import { linearEasing, toRadians } from "./wsi-normalize";
import type { ViewAnimationRuntimeState } from "./wsi-renderer-types";

export const SNAP_ZOOM_DURATION_MS = 250;

export function normalizeZoomSnaps(magnifications: number[] | null | undefined, mpp: number | undefined): number[] {
  if (!magnifications || magnifications.length === 0) return [];
  if (!mpp || mpp <= 0) return [];
  const maxMag = 10 / mpp;
  return magnifications
    .map(mag => mag / maxMag)
    .filter(z => Number.isFinite(z) && z > 0)
    .sort((a, b) => a - b);
}

export type SnapZoomResult = { type: "snap"; zoom: number } | { type: "fit" } | null;

export function resolveSnapTarget(validSnaps: number[], currentZoom: number, direction: "in" | "out", fitAsMin: boolean): SnapZoomResult {
  if (validSnaps.length === 0) return null;

  const epsilon = Math.max(currentZoom * 0.005, 1e-8);

  if (direction === "in") {
    for (const snap of validSnaps) {
      if (snap > currentZoom + epsilon) {
        return { type: "snap", zoom: snap };
      }
    }
    return null;
  }

  for (let i = validSnaps.length - 1; i >= 0; i--) {
    if (validSnaps[i] < currentZoom - epsilon) {
      return { type: "snap", zoom: validSnaps[i] };
    }
  }

  if (fitAsMin && currentZoom <= validSnaps[0] + epsilon) {
    return { type: "fit" };
  }

  return null;
}

export interface ZoomPivotAnimationContext {
  camera: OrthoCamera;
  viewAnimationState: ViewAnimationRuntimeState;
  minZoom: number;
  maxZoom: number;
  cancelViewAnimation: () => void;
  clampViewState: () => void;
  onViewStateChange: (state: WsiViewState) => void;
  requestRender: () => void;
}

export function startZoomPivotAnimation(ctx: ZoomPivotAnimationContext, targetZoom: number, pivotScreenX: number, pivotScreenY: number, durationMs: number): void {
  const fromState = ctx.camera.getViewState();
  const [pivotWorldX, pivotWorldY] = ctx.camera.screenToWorld(pivotScreenX, pivotScreenY);
  const vp = ctx.camera.getViewportSize();
  const safeTargetZoom = clamp(targetZoom, ctx.minZoom, ctx.maxZoom);
  if (safeTargetZoom === fromState.zoom) return;

  const rad = toRadians(fromState.rotationDeg);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const screenDx = pivotScreenX - vp.width * 0.5;
  const screenDy = pivotScreenY - vp.height * 0.5;

  ctx.cancelViewAnimation();

  const computeOffsetForZoom = (z: number): { offsetX: number; offsetY: number } => {
    const worldDx = (screenDx / z) * cos - (screenDy / z) * sin;
    const worldDy = (screenDx / z) * sin + (screenDy / z) * cos;
    return {
      offsetX: pivotWorldX - worldDx - vp.width / (2 * z),
      offsetY: pivotWorldY - worldDy - vp.height / (2 * z),
    };
  };

  const finalOffset = computeOffsetForZoom(safeTargetZoom);
  ctx.viewAnimationState.animation = {
    startMs: nowMs(),
    durationMs: Math.max(0, durationMs),
    from: fromState,
    to: { zoom: safeTargetZoom, offsetX: finalOffset.offsetX, offsetY: finalOffset.offsetY, rotationDeg: fromState.rotationDeg },
    easing: linearEasing,
  };

  const step = (): void => {
    const animation = ctx.viewAnimationState.animation;
    if (!animation) return;

    const elapsed = Math.max(0, nowMs() - animation.startMs);
    const rawT = durationMs <= 0 ? 1 : clamp(elapsed / durationMs, 0, 1);
    const eased = clamp(rawT * rawT * (3 - 2 * rawT), 0, 1);

    const z = fromState.zoom + (safeTargetZoom - fromState.zoom) * eased;
    const { offsetX, offsetY } = computeOffsetForZoom(z);

    ctx.camera.setViewState({ zoom: z, offsetX, offsetY, rotationDeg: fromState.rotationDeg });

    const isComplete = rawT >= 1;
    if (isComplete) {
      ctx.clampViewState();
      ctx.viewAnimationState.animation = null;
      ctx.viewAnimationState.frame = null;
    }

    ctx.onViewStateChange(ctx.camera.getViewState());
    ctx.requestRender();

    if (!isComplete) {
      ctx.viewAnimationState.frame = requestAnimationFrame(step);
    }
  };

  ctx.viewAnimationState.frame = requestAnimationFrame(step);
}
