import type { BrushOptions, DrawCoordinate, DrawProjector, DrawSession, ResolvedBrushOptions } from "./draw-layer-types";
import {
  DEFAULT_BRUSH_CURSOR_ACTIVE_COLOR,
  DEFAULT_BRUSH_CURSOR_COLOR,
  DEFAULT_BRUSH_CURSOR_DASH,
  DEFAULT_BRUSH_CURSOR_LINE_WIDTH,
  DEFAULT_BRUSH_EDGE_DETAIL,
  DEFAULT_BRUSH_EDGE_SMOOTHING,
  DEFAULT_BRUSH_FILL_COLOR,
  DEFAULT_BRUSH_FILL_OPACITY,
  DEFAULT_BRUSH_RADIUS,
  EMPTY_DASH,
  MAX_BRUSH_EDGE_DETAIL,
  MAX_BRUSH_EDGE_SMOOTHING,
  MIN_BRUSH_EDGE_DETAIL,
  MIN_BRUSH_EDGE_SMOOTHING,
} from "./draw-layer-types";
import { clamp, clampPositiveOrFallback, clampUnitOpacity, toCoord } from "./draw-layer-utils";

export type { BrushOptions, ResolvedBrushOptions };

export function sanitizeBrushLineDash(value: number[] | undefined): number[] {
  if (!Array.isArray(value)) return DEFAULT_BRUSH_CURSOR_DASH;
  const out = value.filter(item => Number.isFinite(item) && item >= 0);
  return out.length > 0 ? out : DEFAULT_BRUSH_CURSOR_DASH;
}

export function resolveBrushEdgeDetail(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BRUSH_EDGE_DETAIL;
  return clamp(value, MIN_BRUSH_EDGE_DETAIL, MAX_BRUSH_EDGE_DETAIL);
}

export function resolveBrushEdgeSmoothing(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BRUSH_EDGE_SMOOTHING;
  return Math.round(clamp(value, MIN_BRUSH_EDGE_SMOOTHING, MAX_BRUSH_EDGE_SMOOTHING));
}

export function resolveBrushOptions(options: BrushOptions | undefined): ResolvedBrushOptions {
  const radius = clampPositiveOrFallback(options?.radius, DEFAULT_BRUSH_RADIUS);
  const cursorLineWidth = clampPositiveOrFallback(options?.cursorLineWidth, DEFAULT_BRUSH_CURSOR_LINE_WIDTH);
  const edgeDetail = resolveBrushEdgeDetail(options?.edgeDetail);
  const edgeSmoothing = resolveBrushEdgeSmoothing(options?.edgeSmoothing);
  return {
    radius,
    edgeDetail,
    edgeSmoothing,
    clickSelectRoi: options?.clickSelectRoi === true,
    fillColor: options?.fillColor || DEFAULT_BRUSH_FILL_COLOR,
    fillOpacity: clampUnitOpacity(options?.fillOpacity, DEFAULT_BRUSH_FILL_OPACITY),
    cursorColor: options?.cursorColor || DEFAULT_BRUSH_CURSOR_COLOR,
    cursorActiveColor: options?.cursorActiveColor || DEFAULT_BRUSH_CURSOR_ACTIVE_COLOR,
    cursorLineWidth,
    cursorLineDash: sanitizeBrushLineDash(options?.cursorLineDash),
  };
}

export function drawBrushStrokePreview(ctx: CanvasRenderingContext2D, session: DrawSession, resolvedBrushOptions: ResolvedBrushOptions): void {
  if (!session.isDrawing || session.screenPoints.length === 0) return;
  const screenPoints = session.screenPoints;
  if (screenPoints.length === 0) return;
  const radiusPx = resolvedBrushOptions.radius;
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) return;

  ctx.save();
  ctx.globalAlpha = resolvedBrushOptions.fillOpacity;
  ctx.fillStyle = resolvedBrushOptions.fillColor;
  ctx.strokeStyle = resolvedBrushOptions.fillColor;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = radiusPx * 2;
  if (screenPoints.length === 1) {
    ctx.beginPath();
    ctx.arc(screenPoints[0][0], screenPoints[0][1], radiusPx, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(screenPoints[0][0], screenPoints[0][1]);
    for (let i = 1; i < screenPoints.length; i += 1) {
      ctx.lineTo(screenPoints[i][0], screenPoints[i][1]);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function drawBrushCursor(ctx: CanvasRenderingContext2D, session: DrawSession, projector: DrawProjector | null, resolvedBrushOptions: ResolvedBrushOptions): void {
  const cursor = session.cursor;
  if (!cursor) return;
  const screen = session.cursorScreen ?? toCoord(projector?.worldToScreen(cursor[0], cursor[1]) ?? []);
  if (!screen) return;
  const radiusPx = resolvedBrushOptions.radius;
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.arc(screen[0], screen[1], radiusPx, 0, Math.PI * 2);
  ctx.strokeStyle = session.isDrawing ? resolvedBrushOptions.cursorActiveColor : resolvedBrushOptions.cursorColor;
  ctx.lineWidth = resolvedBrushOptions.cursorLineWidth;
  ctx.setLineDash(resolvedBrushOptions.cursorLineDash);
  ctx.stroke();
  ctx.setLineDash(EMPTY_DASH);
  ctx.restore();
}
