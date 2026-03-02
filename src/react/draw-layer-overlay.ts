import type { DrawCoordinate, DrawOverlayShape, RegionStrokeStyle } from "./draw-layer-types";
import { drawPath, isNestedRingCoordinates, mergeStrokeStyle, normalizeOverlayRings, tracePath } from "./draw-layer-utils";

export function drawInvertedFillMask(ctx: CanvasRenderingContext2D, outerRing: DrawCoordinate[], holeRings: DrawCoordinate[][], fillColor: string): void {
  if (outerRing.length < 4 || holeRings.length === 0) return;
  ctx.save();
  ctx.beginPath();
  tracePath(ctx, outerRing, true);
  for (const ring of holeRings) {
    if (ring.length < 4) continue;
    tracePath(ctx, ring, true);
  }
  ctx.fillStyle = fillColor;
  ctx.fill("evenodd");
  ctx.restore();
}

export interface DrawOverlayShapesParams {
  ctx: CanvasRenderingContext2D;
  overlayShapes: DrawOverlayShape[];
  imageOuterRing: DrawCoordinate[];
  worldToScreenPoints: (points: DrawCoordinate[]) => DrawCoordinate[];
  baseStrokeStyle: RegionStrokeStyle;
  onInvertedFillDebug?: (info: { id: string | number; outerRingPoints: number; sourceRingCount: number; holeRingCount: number; fillColor: string }) => void;
}

export function drawOverlayShapes(params: DrawOverlayShapesParams): void {
  const { ctx, overlayShapes, imageOuterRing, worldToScreenPoints, baseStrokeStyle, onInvertedFillDebug } = params;

  const debugOverlay = Boolean((globalThis as { __OPEN_PLANT_DEBUG_OVERLAY__?: boolean }).__OPEN_PLANT_DEBUG_OVERLAY__);

  for (let i = 0; i < overlayShapes.length; i += 1) {
    const shape = overlayShapes[i];
    if (!shape?.coordinates?.length || shape.visible === false) continue;

    const closed = shape.closed ?? isNestedRingCoordinates(shape.coordinates);
    const renderRings = normalizeOverlayRings(shape.coordinates, closed);

    if (shape.invertedFill?.fillColor) {
      const holeRings: DrawCoordinate[][] = [];
      const closedRings = normalizeOverlayRings(shape.coordinates, true);
      for (const ring of closedRings) {
        const screen = worldToScreenPoints(ring);
        if (screen.length >= 4) {
          holeRings.push(screen);
        }
      }
      if (debugOverlay && onInvertedFillDebug) {
        onInvertedFillDebug({
          id: shape.id ?? i,
          outerRingPoints: imageOuterRing.length,
          sourceRingCount: closedRings.length,
          holeRingCount: holeRings.length,
          fillColor: shape.invertedFill.fillColor,
        });
      }
      drawInvertedFillMask(ctx, imageOuterRing, holeRings, shape.invertedFill.fillColor);
    }

    if (renderRings.length === 0) continue;
    const strokeStyle = mergeStrokeStyle(baseStrokeStyle, shape.stroke ?? shape.strokeStyle);
    for (const ring of renderRings) {
      const screen = worldToScreenPoints(ring);
      if (screen.length < 2) continue;
      drawPath(ctx, screen, strokeStyle, closed, shape.fill ?? false);
    }
  }
}
