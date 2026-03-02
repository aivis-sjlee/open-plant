import { normalizeRoiGeometry, toRoiGeometry } from "../wsi/roi-geometry";
import { clamp } from "../wsi/utils";
import type { DrawCoordinate, DrawOverlayCoordinates, DrawRegionCoordinates, NormalizedDrawRegionPolygon, RegionStrokeStyle } from "./draw-layer-types";
import { CIRCLE_SIDES, DEFAULT_REGION_STROKE_STYLE, type DrawBounds, EMPTY_DASH } from "./draw-layer-types";

export { clamp };

export function clampWorld(coord: DrawCoordinate, imageWidth: number, imageHeight: number): DrawCoordinate {
  return [clamp(coord[0], 0, imageWidth), clamp(coord[1], 0, imageHeight)];
}

export function toCoord(value: DrawCoordinate | number[]): DrawCoordinate | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

export function closeRing(coords: DrawCoordinate[]): DrawCoordinate[] {
  if (!Array.isArray(coords) || coords.length < 3) return [];

  const out = coords.map(([x, y]) => [x, y] as DrawCoordinate);
  const first = out[0];
  const last = out[out.length - 1];
  if (!first || !last) return [];

  if (first[0] !== last[0] || first[1] !== last[1]) {
    out.push([first[0], first[1]]);
  }

  return out;
}

export function polygonArea(coords: DrawCoordinate[]): number {
  if (!Array.isArray(coords) || coords.length < 4) return 0;

  let sum = 0;
  for (let i = 0; i < coords.length - 1; i += 1) {
    const a = coords[i];
    const b = coords[i + 1];
    sum += a[0] * b[1] - b[0] * a[1];
  }

  return Math.abs(sum * 0.5);
}

export function computeBounds(coords: DrawCoordinate[]): DrawBounds {
  if (!Array.isArray(coords) || coords.length === 0) return [0, 0, 0, 0];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  return [minX, minY, maxX, maxY];
}

export function tracePath(ctx: CanvasRenderingContext2D, points: DrawCoordinate[], close = false): void {
  if (points.length === 0) return;

  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i][0], points[i][1]);
  }

  if (close) {
    ctx.closePath();
  }
}

export function drawPath(ctx: CanvasRenderingContext2D, points: DrawCoordinate[], strokeStyle: RegionStrokeStyle, close = false, fill = false, fillColor = "rgba(255, 77, 79, 0.16)"): void {
  if (points.length === 0) return;

  ctx.beginPath();
  tracePath(ctx, points, close);
  if (fill && close) {
    ctx.fillStyle = fillColor;
    ctx.fill();
  }

  ctx.strokeStyle = strokeStyle.color;
  ctx.lineWidth = strokeStyle.width;
  ctx.lineJoin = strokeStyle.lineJoin;
  ctx.lineCap = strokeStyle.lineCap;
  ctx.shadowColor = strokeStyle.shadowColor;
  ctx.shadowBlur = strokeStyle.shadowBlur;
  ctx.shadowOffsetX = strokeStyle.shadowOffsetX;
  ctx.shadowOffsetY = strokeStyle.shadowOffsetY;
  ctx.setLineDash(strokeStyle.lineDash);
  ctx.stroke();
  ctx.setLineDash(EMPTY_DASH);
  ctx.shadowColor = "rgba(0, 0, 0, 0)";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

export function resolveStrokeStyle(style: Partial<RegionStrokeStyle> | undefined): RegionStrokeStyle {
  const dash = Array.isArray(style?.lineDash) ? style.lineDash.filter(value => Number.isFinite(value) && value >= 0) : EMPTY_DASH;
  const width = typeof style?.width === "number" && Number.isFinite(style.width) ? Math.max(0, style.width) : DEFAULT_REGION_STROKE_STYLE.width;
  const shadowBlur = typeof style?.shadowBlur === "number" && Number.isFinite(style.shadowBlur) ? Math.max(0, style.shadowBlur) : DEFAULT_REGION_STROKE_STYLE.shadowBlur;
  const shadowOffsetX = typeof style?.shadowOffsetX === "number" && Number.isFinite(style.shadowOffsetX) ? style.shadowOffsetX : DEFAULT_REGION_STROKE_STYLE.shadowOffsetX;
  const shadowOffsetY = typeof style?.shadowOffsetY === "number" && Number.isFinite(style.shadowOffsetY) ? style.shadowOffsetY : DEFAULT_REGION_STROKE_STYLE.shadowOffsetY;
  return {
    color: style?.color || DEFAULT_REGION_STROKE_STYLE.color,
    width,
    lineDash: dash.length ? dash : EMPTY_DASH,
    lineJoin: style?.lineJoin || DEFAULT_REGION_STROKE_STYLE.lineJoin,
    lineCap: style?.lineCap || DEFAULT_REGION_STROKE_STYLE.lineCap,
    shadowColor: style?.shadowColor || DEFAULT_REGION_STROKE_STYLE.shadowColor,
    shadowBlur,
    shadowOffsetX,
    shadowOffsetY,
  };
}

export function mergeStrokeStyle(base: RegionStrokeStyle, override: Partial<RegionStrokeStyle> | undefined): RegionStrokeStyle {
  if (!override) return base;
  return resolveStrokeStyle({
    color: override.color ?? base.color,
    width: override.width ?? base.width,
    lineDash: override.lineDash ?? base.lineDash,
    lineJoin: override.lineJoin ?? base.lineJoin,
    lineCap: override.lineCap ?? base.lineCap,
    shadowColor: override.shadowColor ?? base.shadowColor,
    shadowBlur: override.shadowBlur ?? base.shadowBlur,
    shadowOffsetX: override.shadowOffsetX ?? base.shadowOffsetX,
    shadowOffsetY: override.shadowOffsetY ?? base.shadowOffsetY,
  });
}

export function isSameRegionId(a: string | number | null | undefined, b: string | number | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return false;
  }
  return String(a) === String(b);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isCoordinatePair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]);
}

export function isCoordinateRing(value: unknown): value is DrawCoordinate[] {
  return Array.isArray(value) && value.length >= 2 && value.every(point => isCoordinatePair(point));
}

function collectOverlayRings(value: unknown, out: DrawCoordinate[][]): void {
  if (!Array.isArray(value) || value.length === 0) return;
  if (isCoordinateRing(value)) {
    out.push(value.map(([x, y]) => [x, y] as DrawCoordinate));
    return;
  }
  for (const item of value) {
    collectOverlayRings(item, out);
  }
}

export function normalizeOverlayRings(coordinates: DrawOverlayCoordinates, close: boolean): DrawCoordinate[][] {
  const sourceRings: DrawCoordinate[][] = [];
  collectOverlayRings(coordinates, sourceRings);
  const out: DrawCoordinate[][] = [];
  for (const ring of sourceRings) {
    if (ring.length < 2) continue;
    const normalized = close ? closeRing(ring) : ring;
    if (normalized.length >= (close ? 4 : 2)) {
      out.push(normalized);
    }
  }
  return out;
}

export function clampPositiveOrFallback(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

export function clampUnitOpacity(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clamp(value, 0, 1);
}

export function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, width * 0.5, height * 0.5));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function isNestedRingCoordinates(coordinates: DrawOverlayCoordinates): boolean {
  const first = coordinates[0];
  return Array.isArray(first) && Array.isArray(first[0]);
}

export function createRectangle(
  start: DrawCoordinate | null,
  end: DrawCoordinate | null,
  projection?: {
    worldToScreen: (x: number, y: number) => DrawCoordinate | null;
    screenToWorld: (screen: DrawCoordinate) => DrawCoordinate | null;
  }
): DrawCoordinate[] {
  if (!start || !end) return [];

  if (projection) {
    const startScreen = projection.worldToScreen(start[0], start[1]);
    const endScreen = projection.worldToScreen(end[0], end[1]);

    if (startScreen && endScreen) {
      const screenCorners: DrawCoordinate[] = [
        [startScreen[0], startScreen[1]],
        [endScreen[0], startScreen[1]],
        [endScreen[0], endScreen[1]],
        [startScreen[0], endScreen[1]],
      ];
      const worldCorners: DrawCoordinate[] = [];
      for (const corner of screenCorners) {
        const world = projection.screenToWorld(corner);
        if (!world) return createRectangle(start, end);
        worldCorners.push(world);
      }
      return closeRing(worldCorners);
    }
  }

  return closeRing([
    [start[0], start[1]],
    [end[0], start[1]],
    [end[0], end[1]],
    [start[0], end[1]],
  ]);
}

export function createCircle(start: DrawCoordinate | null, end: DrawCoordinate | null, sides = CIRCLE_SIDES): DrawCoordinate[] {
  if (!start || !end) return [];

  const centerX = (start[0] + end[0]) * 0.5;
  const centerY = (start[1] + end[1]) * 0.5;
  const radius = Math.hypot(end[0] - start[0], end[1] - start[1]) * 0.5;
  if (radius < 1) return [];

  const coords: DrawCoordinate[] = [];
  for (let i = 0; i <= sides; i += 1) {
    const t = (i / sides) * Math.PI * 2;
    coords.push([centerX + Math.cos(t) * radius, centerY + Math.sin(t) * radius]);
  }

  return closeRing(coords);
}

export function normalizeDrawRegionPolygons(coordinates: DrawRegionCoordinates): NormalizedDrawRegionPolygon[] {
  const multipolygon = normalizeRoiGeometry(toRoiGeometry(coordinates));
  if (multipolygon.length === 0) return [];

  const out: NormalizedDrawRegionPolygon[] = [];
  for (const polygon of multipolygon) {
    const outer = polygon[0];
    if (!outer || outer.length < 4) continue;
    const normalizedOuter = outer.map(([x, y]) => [x, y] as DrawCoordinate);
    const holes: DrawCoordinate[][] = [];
    for (let i = 1; i < polygon.length; i += 1) {
      const hole = polygon[i];
      if (!hole || hole.length < 4) continue;
      holes.push(hole.map(([x, y]) => [x, y] as DrawCoordinate));
    }
    out.push({
      outer: normalizedOuter,
      holes,
    });
  }
  return out;
}
