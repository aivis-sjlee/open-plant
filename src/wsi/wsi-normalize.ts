import type { WsiImageColorSettings } from "./types";
import { clamp } from "./utils";
import type { NormalizedImageColorSettings, PointSizeByZoom, PointSizeStop } from "./wsi-renderer-types";

export const DEFAULT_ROTATION_DRAG_SENSITIVITY = 0.35;
export const MIN_POINT_SIZE_PX = 0.5;
export const MAX_POINT_SIZE_PX = 256;

export const DEFAULT_POINT_SIZE_STOPS: readonly PointSizeStop[] = [
  { zoom: 1, size: 2.8 },
  { zoom: 2, size: 3.4 },
  { zoom: 3, size: 4.2 },
  { zoom: 4, size: 5.3 },
  { zoom: 5, size: 6.8 },
  { zoom: 6, size: 8.4 },
  { zoom: 7, size: 9.8 },
  { zoom: 8, size: 11.2 },
  { zoom: 9, size: 14.0 },
  { zoom: 10, size: 17.5 },
  { zoom: 11, size: 22.0 },
  { zoom: 12, size: 28.0 },
];

const MIN_STROKE_SCALE = 0.1;
const MAX_STROKE_SCALE = 5.0;
const MIN_IMAGE_COLOR_INPUT = -100;
const MAX_IMAGE_COLOR_INPUT = 100;
const MAX_VIEW_TRANSITION_DURATION_MS = 2000;

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function isSameArrayView(a: ArrayBufferView | null | undefined, b: ArrayBufferView | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.buffer === b.buffer && a.byteOffset === b.byteOffset && a.byteLength === b.byteLength;
}

export function clonePointSizeStops(stops: readonly PointSizeStop[]): PointSizeStop[] {
  return stops.map(stop => ({ zoom: stop.zoom, size: stop.size }));
}

export function normalizePointSizeStops(pointSizeByZoom: PointSizeByZoom | null | undefined): PointSizeStop[] {
  if (!pointSizeByZoom) return clonePointSizeStops(DEFAULT_POINT_SIZE_STOPS);

  const parsed = new Map<number, number>();
  for (const [zoomKey, rawSize] of Object.entries(pointSizeByZoom)) {
    const zoom = Number(zoomKey);
    const size = Number(rawSize);
    if (!Number.isFinite(zoom) || !Number.isFinite(size) || size <= 0) continue;
    parsed.set(zoom, size);
  }

  if (parsed.size === 0) {
    return clonePointSizeStops(DEFAULT_POINT_SIZE_STOPS);
  }

  return Array.from(parsed.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([zoom, size]) => ({ zoom, size }));
}

export function arePointSizeStopsEqual(a: readonly PointSizeStop[], b: readonly PointSizeStop[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].zoom !== b[i].zoom || a[i].size !== b[i].size) {
      return false;
    }
  }
  return true;
}

export function resolvePointSizeByZoomStops(continuousZoom: number, stops: readonly PointSizeStop[]): number {
  if (!Number.isFinite(continuousZoom)) return stops[0]?.size ?? MIN_POINT_SIZE_PX;
  if (stops.length === 0) return MIN_POINT_SIZE_PX;
  if (stops.length === 1) return stops[0].size;
  if (continuousZoom <= stops[0].zoom) return stops[0].size;

  for (let i = 1; i < stops.length; i += 1) {
    const prev = stops[i - 1];
    const next = stops[i];
    if (continuousZoom > next.zoom) continue;
    const span = Math.max(1e-6, next.zoom - prev.zoom);
    const t = clamp((continuousZoom - prev.zoom) / span, 0, 1);
    return prev.size + (next.size - prev.size) * t;
  }

  const last = stops[stops.length - 1];
  const prev = stops[stops.length - 2];
  const span = Math.max(1e-6, last.zoom - prev.zoom);
  const slope = (last.size - prev.size) / span;
  return last.size + (continuousZoom - last.zoom) * slope;
}

export function normalizeStrokeScale(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1.0;
  return clamp(value, MIN_STROKE_SCALE, MAX_STROKE_SCALE);
}

function normalizeImageColorInput(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return clamp(value, MIN_IMAGE_COLOR_INPUT, MAX_IMAGE_COLOR_INPUT);
}

export function toNormalizedImageColorSettings(settings: WsiImageColorSettings | null | undefined): NormalizedImageColorSettings {
  const brightnessInput = normalizeImageColorInput(settings?.brightness);
  const contrastInput = normalizeImageColorInput(settings?.contrast);
  const saturationInput = normalizeImageColorInput(settings?.saturation);
  return {
    brightness: brightnessInput / 200,
    contrast: contrastInput / 100,
    saturation: saturationInput / 100,
  };
}

export function linearEasing(t: number): number {
  return t;
}

export function normalizeViewTransitionDuration(duration: number | null | undefined): number {
  if (typeof duration !== "number" || !Number.isFinite(duration)) return 0;
  return clamp(duration, 0, MAX_VIEW_TRANSITION_DURATION_MS);
}

export function normalizeZoomOverride(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(1e-6, value);
}

export function normalizeTransitionEasing(easing: ((t: number) => number) | null | undefined): (t: number) => number {
  return typeof easing === "function" ? easing : linearEasing;
}
