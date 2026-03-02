import type { DrawAreaTooltipOptions, DrawAreaTooltipStyle, DrawCoordinate, RegionLabelStyle, ResolvedDrawAreaTooltipOptions } from "./draw-layer-types";
import {
  DEFAULT_DRAW_AREA_TOOLTIP_OFFSET,
  DEFAULT_DRAW_AREA_TOOLTIP_STYLE,
  DEFAULT_REGION_LABEL_STYLE,
  REGION_LABEL_AUTO_LIFT_MAX_EPSILON,
  REGION_LABEL_AUTO_LIFT_MAX_OFFSET_PX,
} from "./draw-layer-types";
import { clamp, drawRoundedRect } from "./draw-layer-utils";

const LABEL_MEASURE_FALLBACK_EM = 0.58;
const LABEL_MEASURE_CACHE_LIMIT = 4096;
const TOP_ANCHOR_Y_TOLERANCE = 0.5;

let sharedLabelMeasureContext: CanvasRenderingContext2D | null = null;
const labelTextWidthCache = new Map<string, number>();

function getLabelMeasureContext(): CanvasRenderingContext2D | null {
  if (sharedLabelMeasureContext) return sharedLabelMeasureContext;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  sharedLabelMeasureContext = ctx;
  return sharedLabelMeasureContext;
}

export function measureLabelTextWidth(label: string, labelStyle: { fontFamily: string; fontSize: number; fontWeight: string | number }): number {
  const key = `${labelStyle.fontWeight}|${labelStyle.fontSize}|${labelStyle.fontFamily}|${label}`;
  const cached = labelTextWidthCache.get(key);
  if (cached !== undefined) return cached;

  const fallback = label.length * labelStyle.fontSize * LABEL_MEASURE_FALLBACK_EM;
  const ctx = getLabelMeasureContext();
  let width = fallback;
  if (ctx) {
    ctx.font = `${labelStyle.fontWeight} ${labelStyle.fontSize}px ${labelStyle.fontFamily}`;
    const measured = ctx.measureText(label).width;
    if (Number.isFinite(measured) && measured >= 0) {
      width = measured;
    }
  }

  if (labelTextWidthCache.size > LABEL_MEASURE_CACHE_LIMIT) {
    labelTextWidthCache.clear();
  }
  labelTextWidthCache.set(key, width);
  return width;
}

export function getTopAnchor(coords: DrawCoordinate[]): DrawCoordinate | null {
  if (!coords.length) return null;

  let minY = Infinity;
  for (const point of coords) {
    if (point[1] < minY) minY = point[1];
  }
  if (!Number.isFinite(minY)) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  for (const point of coords) {
    if (Math.abs(point[1] - minY) > TOP_ANCHOR_Y_TOLERANCE) continue;
    if (point[0] < minX) minX = point[0];
    if (point[0] > maxX) maxX = point[0];
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  return [(minX + maxX) * 0.5, minY];
}

export function getTopAnchorFromPolygons<T extends { outer: DrawCoordinate[] }>(polygons: T[]): DrawCoordinate | null {
  let best: DrawCoordinate | null = null;
  for (const polygon of polygons) {
    const anchor = getTopAnchor(polygon.outer);
    if (!anchor) continue;
    if (!best || anchor[1] < best[1] || (anchor[1] === best[1] && anchor[0] < best[0])) {
      best = anchor;
    }
  }
  return best;
}

export function resolveRegionLabelStyle(style: Partial<RegionLabelStyle> | undefined): RegionLabelStyle {
  const px = typeof style?.paddingX === "number" && Number.isFinite(style.paddingX) ? Math.max(0, style.paddingX) : DEFAULT_REGION_LABEL_STYLE.paddingX;
  const py = typeof style?.paddingY === "number" && Number.isFinite(style.paddingY) ? Math.max(0, style.paddingY) : DEFAULT_REGION_LABEL_STYLE.paddingY;
  const fs = typeof style?.fontSize === "number" && Number.isFinite(style.fontSize) ? Math.max(8, style.fontSize) : DEFAULT_REGION_LABEL_STYLE.fontSize;
  const bw = typeof style?.borderWidth === "number" && Number.isFinite(style.borderWidth) ? Math.max(0, style.borderWidth) : DEFAULT_REGION_LABEL_STYLE.borderWidth;
  const oy = typeof style?.offsetY === "number" && Number.isFinite(style.offsetY) ? style.offsetY : DEFAULT_REGION_LABEL_STYLE.offsetY;
  const br = typeof style?.borderRadius === "number" && Number.isFinite(style.borderRadius) ? Math.max(0, style.borderRadius) : DEFAULT_REGION_LABEL_STYLE.borderRadius;
  return {
    fontFamily: style?.fontFamily || DEFAULT_REGION_LABEL_STYLE.fontFamily,
    fontSize: fs,
    fontWeight: style?.fontWeight || DEFAULT_REGION_LABEL_STYLE.fontWeight,
    textColor: style?.textColor || DEFAULT_REGION_LABEL_STYLE.textColor,
    backgroundColor: style?.backgroundColor || DEFAULT_REGION_LABEL_STYLE.backgroundColor,
    borderColor: style?.borderColor || DEFAULT_REGION_LABEL_STYLE.borderColor,
    borderWidth: bw,
    paddingX: px,
    paddingY: py,
    offsetY: oy,
    borderRadius: br,
  };
}

export function mergeRegionLabelStyle(base: RegionLabelStyle, override: Partial<RegionLabelStyle> | null | undefined): RegionLabelStyle {
  if (!override) return base;
  return resolveRegionLabelStyle({
    fontFamily: override.fontFamily ?? base.fontFamily,
    fontSize: override.fontSize ?? base.fontSize,
    fontWeight: override.fontWeight ?? base.fontWeight,
    textColor: override.textColor ?? base.textColor,
    backgroundColor: override.backgroundColor ?? base.backgroundColor,
    borderColor: override.borderColor ?? base.borderColor,
    borderWidth: override.borderWidth ?? base.borderWidth,
    paddingX: override.paddingX ?? base.paddingX,
    paddingY: override.paddingY ?? base.paddingY,
    offsetY: override.offsetY ?? base.offsetY,
    borderRadius: override.borderRadius ?? base.borderRadius,
  });
}

export function resolveRegionLabelAutoLiftOffsetPx(enabled: boolean | undefined, zoom: number, zoomRange: { minZoom: number; maxZoom: number } | null | undefined): number {
  if (!enabled) return 0;
  if (!zoomRange) return 0;

  const minZoom = Number(zoomRange.minZoom);
  const maxZoom = Number(zoomRange.maxZoom);
  if (!Number.isFinite(minZoom) || !Number.isFinite(maxZoom)) return 0;

  if (maxZoom - minZoom <= REGION_LABEL_AUTO_LIFT_MAX_EPSILON) return 0;
  if (!Number.isFinite(zoom)) return 0;
  return zoom >= maxZoom - REGION_LABEL_AUTO_LIFT_MAX_EPSILON ? REGION_LABEL_AUTO_LIFT_MAX_OFFSET_PX : 0;
}

function resolveDrawAreaTooltipStyle(style: Partial<DrawAreaTooltipStyle> | undefined): DrawAreaTooltipStyle {
  const fontSize = typeof style?.fontSize === "number" && Number.isFinite(style.fontSize) ? Math.max(8, style.fontSize) : DEFAULT_DRAW_AREA_TOOLTIP_STYLE.fontSize;
  const borderRadius = typeof style?.borderRadius === "number" && Number.isFinite(style.borderRadius) ? Math.max(0, style.borderRadius) : DEFAULT_DRAW_AREA_TOOLTIP_STYLE.borderRadius;
  const paddingX = typeof style?.paddingX === "number" && Number.isFinite(style.paddingX) ? Math.max(0, style.paddingX) : DEFAULT_DRAW_AREA_TOOLTIP_STYLE.paddingX;
  const paddingY = typeof style?.paddingY === "number" && Number.isFinite(style.paddingY) ? Math.max(0, style.paddingY) : DEFAULT_DRAW_AREA_TOOLTIP_STYLE.paddingY;
  return {
    fontFamily: style?.fontFamily || DEFAULT_DRAW_AREA_TOOLTIP_STYLE.fontFamily,
    fontSize,
    fontWeight: style?.fontWeight || DEFAULT_DRAW_AREA_TOOLTIP_STYLE.fontWeight,
    textColor: style?.textColor || DEFAULT_DRAW_AREA_TOOLTIP_STYLE.textColor,
    backgroundColor: style?.backgroundColor || DEFAULT_DRAW_AREA_TOOLTIP_STYLE.backgroundColor,
    borderRadius,
    paddingX,
    paddingY,
  };
}

function resolveTooltipCursorOffset(value: DrawAreaTooltipOptions["cursorOffset"]): { x: number; y: number } {
  const x = typeof value?.x === "number" && Number.isFinite(value.x) ? value.x : DEFAULT_DRAW_AREA_TOOLTIP_OFFSET.x;
  const y = typeof value?.y === "number" && Number.isFinite(value.y) ? value.y : DEFAULT_DRAW_AREA_TOOLTIP_OFFSET.y;
  return { x, y };
}

export function defaultDrawAreaTooltipFormatter(areaMm2: number): string {
  if (!Number.isFinite(areaMm2)) return "0.000 mm²";
  return `${Math.max(0, areaMm2).toFixed(3)} mm²`;
}

export function resolveDrawAreaTooltipOptions(options: DrawAreaTooltipOptions | undefined): ResolvedDrawAreaTooltipOptions {
  const format = typeof options?.format === "function" ? options.format : defaultDrawAreaTooltipFormatter;
  const cursorOffset = resolveTooltipCursorOffset(options?.cursorOffset);
  return {
    enabled: options?.enabled === true,
    format,
    style: resolveDrawAreaTooltipStyle(options?.style),
    cursorOffsetX: cursorOffset.x,
    cursorOffsetY: cursorOffset.y,
  };
}

export function drawRegionLabel(ctx: CanvasRenderingContext2D, text: string, anchor: DrawCoordinate, canvasWidth: number, canvasHeight: number, labelStyle: RegionLabelStyle): void {
  const label = text.trim();
  if (!label) return;

  ctx.save();
  ctx.font = `${labelStyle.fontWeight} ${labelStyle.fontSize}px ${labelStyle.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const textWidth = measureLabelTextWidth(label, labelStyle);
  const boxWidth = textWidth + labelStyle.paddingX * 2;
  const boxHeight = labelStyle.fontSize + labelStyle.paddingY * 2;

  const x = clamp(anchor[0], boxWidth * 0.5 + 1, canvasWidth - boxWidth * 0.5 - 1);
  const y = clamp(anchor[1] - labelStyle.offsetY, boxHeight * 0.5 + 1, canvasHeight - boxHeight * 0.5 - 1);
  const left = x - boxWidth * 0.5;
  const top = y - boxHeight * 0.5;

  ctx.fillStyle = labelStyle.backgroundColor;
  ctx.strokeStyle = labelStyle.borderColor;
  ctx.lineWidth = labelStyle.borderWidth;
  drawRoundedRect(ctx, left, top, boxWidth, boxHeight, labelStyle.borderRadius);
  ctx.fill();
  if (labelStyle.borderWidth > 0) {
    ctx.stroke();
  }

  ctx.fillStyle = labelStyle.textColor;
  ctx.fillText(label, x, y + 0.5);
  ctx.restore();
}

export function drawAreaTooltipBox(
  ctx: CanvasRenderingContext2D,
  text: string,
  cursorScreen: DrawCoordinate,
  canvasWidth: number,
  canvasHeight: number,
  style: DrawAreaTooltipStyle,
  offsetX: number,
  offsetY: number
): void {
  const label = text.trim();
  if (!label) return;

  ctx.save();
  ctx.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const textWidth = measureLabelTextWidth(label, style);
  const boxWidth = textWidth + style.paddingX * 2;
  const boxHeight = style.fontSize + style.paddingY * 2;

  const x = clamp(cursorScreen[0] + offsetX, boxWidth * 0.5 + 1, canvasWidth - boxWidth * 0.5 - 1);
  const y = clamp(cursorScreen[1] + offsetY, boxHeight * 0.5 + 1, canvasHeight - boxHeight * 0.5 - 1);
  const left = x - boxWidth * 0.5;
  const top = y - boxHeight * 0.5;

  ctx.fillStyle = style.backgroundColor;
  drawRoundedRect(ctx, left, top, boxWidth, boxHeight, style.borderRadius);
  ctx.fill();

  ctx.fillStyle = style.textColor;
  ctx.fillText(label, x, y + 0.5);
  ctx.restore();
}
