import { useEffect, useMemo, useRef } from "react";
import type { PreparedRoiPolygon } from "../wsi/roi-geometry";
import { pointInAnyPreparedPolygon, prepareRoiPolygons, toRoiGeometry } from "../wsi/roi-geometry";
import { createSpatialIndex, type SpatialIndex } from "../wsi/spatial-index";
import type { WsiImageSource, WsiRegion } from "../wsi/types";
import { clamp } from "../wsi/utils";
import { tracePath } from "./draw-layer-utils";
import { HeatmapWebGLRenderer } from "./heatmap-webgl";
import { useViewerContext } from "./viewer-context";

export type HeatmapKernelScaleMode = "screen" | "fixed-zoom";

export interface HeatmapPointData {
  count: number;
  positions: Float32Array;
  weights?: Float32Array;
}

export interface HeatmapLayerStats {
  pointCount: number;
  renderTimeMs: number;
  visiblePointCount: number;
  renderedBinCount: number;
  sampleStride: number;
  maxDensity: number;
}

export interface HeatmapLayerProps {
  data: HeatmapPointData | null;
  visible?: boolean;
  opacity?: number;
  radius?: number;
  blur?: number;
  gradient?: readonly string[];
  backgroundColor?: string | null;
  scaleMode?: HeatmapKernelScaleMode;
  fixedZoom?: number;
  zoomThreshold?: number;
  densityContrast?: number;
  clipToRegions?: readonly WsiRegion[];
  zIndex?: number;
  maxRenderedPoints?: number;
  onStats?: (stats: HeatmapLayerStats) => void;
}

interface HeatmapCell {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  worldX: number;
  worldY: number;
  renderWorldX: number;
  renderWorldY: number;
  weight: number;
  count: number;
}

interface HeatmapLevel {
  cellWorldSize: number;
  bins: HeatmapCell[];
  index: SpatialIndex<number>;
  normalizationUpperWeight: number;
}

interface HeatmapSourceData {
  dataRef: HeatmapPointData | null;
  sourceRef: WsiImageSource | null;
  positionsRef: Float32Array;
  weightsRef?: Float32Array;
  inputCount: number;
  clipRef: readonly PreparedRoiPolygon[] | null;
  clipKey: string;
  pointCount: number;
  xs: Float32Array;
  ys: Float32Array;
  ws: Float32Array;
  pointIndex: SpatialIndex<number>;
  cellSizes: number[];
  levels: Array<HeatmapLevel | null>;
}

interface HeatmapFixedState {
  dataRef: HeatmapPointData | null;
  positionsRef: Float32Array;
  weightsRef?: Float32Array;
  inputCount: number;
  clipRef: readonly PreparedRoiPolygon[] | null;
  clipKey: string;
  referenceZoom: number;
  referenceRawZoom: number;
  heatmapScale: number;
  kernelWorldRadius: number;
  blurWorldRadius: number;
  sampleProbability: number;
  sampleStride: number;
  pointAlpha: number;
}

interface HeatmapRuntime {
  sourceData: HeatmapSourceData | null;
  fixedState: HeatmapFixedState | null;
  screenLevelIndex: number;
  screenSecondaryLevelIndex: number;
  screenSecondaryLevelWeight: number;
  screenPointAlpha: number;
  screenNormalizationMaxWeight: number;
  screenVisibilityStrength: number;
  webgl: HeatmapWebGLRenderer | null | undefined;
  webglWarningIssued: boolean;
  webglPositions: Float32Array | null;
  webglWeights: Float32Array | null;
  webglCapacity: number;
}

interface DrawState {
  data: HeatmapPointData | null;
  visible: boolean;
  opacity: number;
  radius: number;
  blur: number;
  gradient: readonly string[];
  backgroundColor: string | null;
  scaleMode: HeatmapKernelScaleMode;
  fixedZoom?: number;
  zoomThreshold: number;
  densityContrast: number;
  clipPolygons: readonly PreparedRoiPolygon[];
  clipKey: string;
  maxRenderedPoints: number;
  onStats?: (stats: HeatmapLayerStats) => void;
}

interface ViewportFrame {
  heatmapScale: number;
  rasterWidth: number;
  rasterHeight: number;
  rasterScaleX: number;
  rasterScaleY: number;
  rawZoom: number;
  kernelRadiusPx: number;
  blurRadiusPx: number;
  outerWorldRadius: number;
  desiredCellWorldSize: number;
}

const HEATMAP_DRAW_ID = "__open_plant_heatmap_layer__";
const DEFAULT_GRADIENT = ["#00000000", "#3876FF", "#4CDDDD", "#FFE75C", "#FF8434", "#FF3434"] as const;
const DEFAULT_RADIUS = 3;
const DEFAULT_BLUR = 2;
const DEFAULT_OPACITY = 0.9;
const DEFAULT_MAX_RENDERED_POINTS = 52000;
const DEFAULT_SCALE_MODE: HeatmapKernelScaleMode = "screen";
const DEFAULT_DENSITY_CONTRAST = 2.2;
const MIN_RASTER_SIZE = 128;
const MAX_RASTER_SIZE = 1600;
const BASE_RADIUS_UNIT_PX = 1.9;
const BASE_BLUR_UNIT_PX = 4.2;
const MIN_VISIBLE_BUDGET = 3000;
const PYRAMID_SCALE_STEP = Math.SQRT2;
const NORMALIZATION_SAMPLE_SIZE = 2048;
const NORMALIZATION_PERCENTILE = 0.9;
const MAX_DENSITY_CONTRAST = 16;
const MAX_ZOOM_THRESHOLD = 8;

function resolveContinuousZoom(rawZoom: number, source: WsiImageSource): number {
  return source.maxTierZoom + Math.log2(Math.max(1e-6, rawZoom));
}

function resolveRawZoomFromContinuousZoom(continuousZoom: number, source: WsiImageSource): number {
  return Math.max(1e-6, 2 ** (continuousZoom - source.maxTierZoom));
}

function applyZoomThreshold(rawZoom: number, source: WsiImageSource, zoomThreshold: number): number {
  if (!Number.isFinite(zoomThreshold) || Math.abs(zoomThreshold) < 1e-6) {
    return Math.max(1e-6, rawZoom);
  }
  const shiftedZoom = resolveContinuousZoom(rawZoom, source) - zoomThreshold;
  return resolveRawZoomFromContinuousZoom(shiftedZoom, source);
}

function resolveThresholdLevelBias(zoomThreshold: number): number {
  if (!Number.isFinite(zoomThreshold) || Math.abs(zoomThreshold) < 1e-6) {
    return 0;
  }
  return Math.round((zoomThreshold * 1.5) / Math.max(1e-6, Math.log2(PYRAMID_SCALE_STEP)));
}

function resolveDensityWeightExponent(densityContrast: number): number {
  const contrast = clamp(densityContrast, 0, MAX_DENSITY_CONTRAST);
  return clamp(0.55 + Math.sqrt(Math.max(0, contrast)) * 0.48, 0.55, 6);
}

function resolveCellSupportFactor(cellCount: number): number {
  const count = Math.max(0, cellCount);
  if (count <= 1) return 0.18;
  if (count <= 2) return 0.3;
  if (count <= 4) return 0.48;
  if (count <= 8) return 0.7;
  if (count <= 16) return 0.86;
  return 1;
}

function resolveDensityCutoff(densityContrast: number): number {
  const contrast = clamp(densityContrast, 0, MAX_DENSITY_CONTRAST);
  const t = contrast / MAX_DENSITY_CONTRAST;
  return 0.022 - t * 0.015;
}

function resolveDensityGain(densityContrast: number): number {
  const contrast = clamp(densityContrast, 0, MAX_DENSITY_CONTRAST);
  return 0.18 + Math.pow(Math.max(0, contrast), 0.72) * 0.42 + Math.log2(contrast + 1) * 0.24;
}

function resolveDensityGamma(densityContrast: number): number {
  return resolveDensityWeightExponent(densityContrast);
}

function resolveDensityBias(densityContrast: number): number {
  const contrast = clamp(densityContrast, 0, MAX_DENSITY_CONTRAST);
  const t = contrast / MAX_DENSITY_CONTRAST;
  return clamp(0.46 - t * 0.34, 0.12, 0.46);
}

function resolveDensityStretch(densityContrast: number, rawZoom: number, source: WsiImageSource): number {
  const contrast = clamp(densityContrast, 0, MAX_DENSITY_CONTRAST);
  const contrastT = contrast / MAX_DENSITY_CONTRAST;
  const continuousZoom = resolveContinuousZoom(rawZoom, source);
  const zoomStart = source.maxTierZoom - 3.2;
  const zoomEnd = source.maxTierZoom - 1.15;
  const zoomT = clamp((continuousZoom - zoomStart) / Math.max(1e-6, zoomEnd - zoomStart), 0, 1);
  const baseStretch = 1.12 + Math.pow(contrastT, 0.82) * 1.18;
  const zoomStretch = 1 + zoomT * (0.48 + contrastT * 0.92);
  return baseStretch * zoomStretch;
}

function resolveNormalizedDensityWeight(weight: number, normalizationMaxWeight: number, densityContrast: number): number {
  void densityContrast;
  const safeWeight = Math.max(0, weight);
  const safeMaxWeight = Math.max(1e-6, normalizationMaxWeight);
  const normalized = Math.log1p(safeWeight) / Math.log1p(safeMaxWeight);
  return clamp(normalized, 0, 1);
}

function resolveNormalizationPercentile(densityContrast: number): number {
  void densityContrast;
  return NORMALIZATION_PERCENTILE;
}

function resolveNormalizationUpperWeight(cells: readonly HeatmapCell[], densityContrast: number): number {
  if (cells.length === 0) return 1;

  const sampleCount = Math.min(cells.length, NORMALIZATION_SAMPLE_SIZE);
  const sampledWeights = new Array<number>(sampleCount);
  let maxWeight = 1;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const cellIndex = Math.min(
      cells.length - 1,
      Math.floor(((sampleIndex + 0.5) * cells.length) / sampleCount),
    );
    const weight = Math.max(0, cells[cellIndex]?.weight ?? 0);
    sampledWeights[sampleIndex] = weight;
    if (weight > maxWeight) maxWeight = weight;
  }

  for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
    const weight = Math.max(0, cells[cellIndex]?.weight ?? 0);
    if (weight > maxWeight) maxWeight = weight;
  }

  sampledWeights.sort((left, right) => left - right);
  const percentile = resolveNormalizationPercentile(densityContrast);
  const percentileIndex = Math.max(0, Math.min(
    sampledWeights.length - 1,
    Math.floor((sampledWeights.length - 1) * percentile),
  ));
  const percentileWeight = sampledWeights[percentileIndex] ?? maxWeight;
  const floorRatio = 0.14;
  const uplift = 1.08;
  return Math.max(1, Math.min(maxWeight, Math.max(percentileWeight * uplift, maxWeight * floorRatio)));
}

function resolveZoomVisibilityStrength(rawZoom: number, source: WsiImageSource, zoomThreshold: number): number {
  void zoomThreshold;
  const continuousZoom = resolveContinuousZoom(rawZoom, source);
  const fadeStart = source.maxTierZoom - 2.45;
  const fadeEnd = source.maxTierZoom - 1.2;
  const baseStrength =
    continuousZoom <= fadeStart ? 1 :
    continuousZoom >= fadeEnd ? 0 :
    (() => {
      const t = clamp((continuousZoom - fadeStart) / Math.max(1e-6, fadeEnd - fadeStart), 0, 1);
      const smooth = t * t * (3 - 2 * t);
      return 1 - smooth;
    })();
  return clamp(baseStrength, 0, 1);
}

function resolveSampleWeightBoost(sampleProbability: number): number {
  if (sampleProbability >= 1) return 1;
  const effectiveStride = 1 / Math.max(sampleProbability, 1e-6);
  return 1 + Math.log2(effectiveStride) * 0.28;
}

function resolveLowResScale(width: number, height: number, totalPointCount: number, rawZoom: number): number {
  const longestSide = Math.max(1, width, height);
  const deviceScale = typeof window === "undefined" ? 1 : clamp(window.devicePixelRatio || 1, 1, 2.4);
  const lowZoomBoost =
    rawZoom <= 0.35 ? 1.42 :
    rawZoom <= 0.55 ? 1.26 :
    rawZoom <= 0.8 ? 1.14 :
    1;
  const targetMaxSize =
    totalPointCount > 160000 ? 896 :
    totalPointCount > 80000 ? 1152 :
    totalPointCount > 30000 ? 1408 :
    MAX_RASTER_SIZE;
  const minScale = MIN_RASTER_SIZE / longestSide;
  const maxScale = MAX_RASTER_SIZE / longestSide;
  return clamp((targetMaxSize * deviceScale * lowZoomBoost) / longestSide, minScale, maxScale);
}

function buildViewportFrame(params: {
  logicalWidth: number;
  logicalHeight: number;
  totalPointCount: number;
  rawZoom: number;
  radius: number;
  blur: number;
  heatmapScale?: number;
}): ViewportFrame {
  const heatmapScale = params.heatmapScale ?? resolveLowResScale(params.logicalWidth, params.logicalHeight, params.totalPointCount, params.rawZoom);
  const rasterWidth = Math.max(MIN_RASTER_SIZE, Math.min(MAX_RASTER_SIZE, Math.round(params.logicalWidth * heatmapScale)));
  const rasterHeight = Math.max(MIN_RASTER_SIZE, Math.min(MAX_RASTER_SIZE, Math.round(params.logicalHeight * heatmapScale)));
  const rasterScaleX = rasterWidth / Math.max(1, params.logicalWidth);
  const rasterScaleY = rasterHeight / Math.max(1, params.logicalHeight);
  const effectiveScale = Math.min(rasterScaleX, rasterScaleY);
  const rawZoom = Math.max(1e-6, params.rawZoom);
  const kernelRadiusPx = Math.max(0.75, params.radius * BASE_RADIUS_UNIT_PX * effectiveScale);
  const blurRadiusPx = Math.max(0.6, params.blur * BASE_BLUR_UNIT_PX * effectiveScale);
  const outerWorldRadius = (kernelRadiusPx + blurRadiusPx) / Math.max(1e-6, rawZoom * effectiveScale);
  const desiredCellWorldSize = Math.max(
    outerWorldRadius * 0.4,
    0.62 / Math.max(1e-6, rawZoom * effectiveScale),
  );

  return {
    heatmapScale,
    rasterWidth,
    rasterHeight,
    rasterScaleX,
    rasterScaleY,
    rawZoom,
    kernelRadiusPx,
    blurRadiusPx,
    outerWorldRadius,
    desiredCellWorldSize,
  };
}

function resolvePointCount(data: HeatmapPointData | null): number {
  if (!data) return 0;
  const maxByPosition = Math.floor(data.positions.length / 2);
  const maxByWeight = data.weights ? data.weights.length : Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.min(Math.floor(data.count), maxByPosition, maxByWeight));
}

function hashCoordinate(value: number, seed: number): number {
  const normalized = Number.isFinite(value) ? Math.round(value * 1024) : 0;
  return Math.imul(seed ^ normalized, 0x45d9f3b) >>> 0;
}

function hashIntPair(x: number, y: number, seed = 0x9e3779b9): number {
  let hash = Math.imul(seed ^ (x | 0), 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ (y | 0), 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function hashToUnitFloat(hash: number): number {
  return (hash >>> 0) / 0xffffffff;
}

function resolveJitteredCoordinate(
  center: number,
  min: number,
  max: number,
  jitterUnit: number,
  paddingFraction: number,
  jitterFraction: number,
): number {
  const span = Math.max(1e-6, max - min);
  const padding = Math.min(span * clamp(paddingFraction, 0.12, 0.32), span * 0.5 - 1e-6);
  const jitterRange = Math.max(0, span * clamp(jitterFraction, 0.01, 0.22) - padding * 0.15);
  const jitter = (jitterUnit * 2 - 1) * jitterRange;
  return clamp(center + jitter, min + padding, max - padding);
}

function buildClipKey(polygons: readonly PreparedRoiPolygon[]): string {
  let hash = 0x811c9dc5;
  for (let polygonIndex = 0; polygonIndex < polygons.length; polygonIndex += 1) {
    const polygon = polygons[polygonIndex]!;
    hash = Math.imul(hash ^ polygon.outer.length, 0x01000193) >>> 0;
    for (let pointIndex = 0; pointIndex < polygon.outer.length; pointIndex += 1) {
      const point = polygon.outer[pointIndex]!;
      hash = hashCoordinate(point[0], hash);
      hash = hashCoordinate(point[1], hash);
    }
    hash = Math.imul(hash ^ polygon.holes.length, 0x01000193) >>> 0;
    for (let holeIndex = 0; holeIndex < polygon.holes.length; holeIndex += 1) {
      const hole = polygon.holes[holeIndex]!;
      hash = Math.imul(hash ^ hole.length, 0x01000193) >>> 0;
      for (let pointIndex = 0; pointIndex < hole.length; pointIndex += 1) {
        const point = hole[pointIndex]!;
        hash = hashCoordinate(point[0], hash);
        hash = hashCoordinate(point[1], hash);
      }
    }
  }
  return `${polygons.length}:${hash >>> 0}`;
}

function isSameHeatmapInput(
  input: Pick<HeatmapSourceData, "dataRef" | "positionsRef" | "weightsRef" | "inputCount" | "clipKey"> | Pick<HeatmapFixedState, "dataRef" | "positionsRef" | "weightsRef" | "inputCount" | "clipKey">,
  data: HeatmapPointData | null,
  clipKey: string,
): boolean {
  if (input.dataRef === data && input.clipKey === clipKey) {
    return true;
  }
  if (!data) return false;
  return input.clipKey === clipKey &&
    input.inputCount === resolvePointCount(data) &&
    input.positionsRef === data.positions &&
    input.weightsRef === data.weights;
}

function buildSourceData(data: HeatmapPointData | null, clipPolygons: readonly PreparedRoiPolygon[], clipKey: string, source: WsiImageSource | null): HeatmapSourceData | null {
  const pointCount = resolvePointCount(data);
  if (!data || pointCount <= 0) {
    return null;
  }

  let xs = new Float32Array(pointCount);
  let ys = new Float32Array(pointCount);
  let ws = new Float32Array(pointCount);
  let acceptedCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let index = 0; index < pointCount; index += 1) {
    const worldX = data.positions[index * 2];
    const worldY = data.positions[index * 2 + 1];
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) continue;
    if (clipPolygons.length > 0 && !pointInAnyPreparedPolygon(worldX, worldY, clipPolygons)) continue;

    const rawWeight = data.weights?.[index];
    const weight = typeof rawWeight === "number" && Number.isFinite(rawWeight) ? Math.max(0, rawWeight) : 1;
    if (weight <= 0) continue;

    xs[acceptedCount] = worldX;
    ys[acceptedCount] = worldY;
    ws[acceptedCount] = weight;
    acceptedCount += 1;
    if (worldX < minX) minX = worldX;
    if (worldX > maxX) maxX = worldX;
    if (worldY < minY) minY = worldY;
    if (worldY > maxY) maxY = worldY;
  }

  if (acceptedCount === 0 || !Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  if (acceptedCount < pointCount) {
    xs = xs.slice(0, acceptedCount);
    ys = ys.slice(0, acceptedCount);
    ws = ws.slice(0, acceptedCount);
  }

  const pointIndexItems: Array<{ minX: number; minY: number; maxX: number; maxY: number; value: number }> = [];
  for (let index = 0; index < acceptedCount; index += 1) {
    const x = xs[index]!;
    const y = ys[index]!;
    pointIndexItems.push({
      minX: x,
      minY: y,
      maxX: x,
      maxY: y,
      value: index,
    });
  }
  const pointIndex = createSpatialIndex<number>(64);
  pointIndex.load(pointIndexItems);

  const maxDimension = Math.max(
    source?.width ?? 0,
    source?.height ?? 0,
    maxX - minX,
    maxY - minY,
    1,
  );

  const cellSizes: number[] = [];
  let cellSize = 0.5;
  let guard = 0;
  while (cellSize <= maxDimension && guard < 32) {
    cellSizes.push(cellSize);
    cellSize *= PYRAMID_SCALE_STEP;
    guard += 1;
  }
  if (cellSizes.length === 0) {
    cellSizes.push(1);
  }

  return {
    dataRef: data,
    sourceRef: source,
    positionsRef: data.positions,
    weightsRef: data.weights,
    inputCount: pointCount,
    clipRef: clipPolygons,
    clipKey,
    pointCount: acceptedCount,
    xs,
    ys,
    ws,
    pointIndex,
    cellSizes,
    levels: Array.from({ length: cellSizes.length }, () => null),
  };
}

function estimateVisibleBinCount(viewBounds: [number, number, number, number], cellWorldSize: number): number {
  const width = Math.max(1, viewBounds[2] - viewBounds[0]);
  const height = Math.max(1, viewBounds[3] - viewBounds[1]);
  return Math.max(1, Math.round((width * height) / Math.max(1e-6, cellWorldSize * cellWorldSize)));
}

function buildLevel(sourceData: HeatmapSourceData, levelIndex: number): HeatmapLevel | null {
  if (levelIndex < 0 || levelIndex >= sourceData.cellSizes.length) return null;
  const cachedLevel = sourceData.levels[levelIndex];
  if (cachedLevel) return cachedLevel;

  const currentCellSize = sourceData.cellSizes[levelIndex];
  const levelT = sourceData.cellSizes.length <= 1 ? 0 : levelIndex / (sourceData.cellSizes.length - 1);
  const adaptivePaddingFraction = 0.24 - levelT * 0.08;
  const adaptiveJitterFraction = 0.035 + levelT * 0.11;
  const cells = new Map<string, {
    cellX: number;
    cellY: number;
    sumX: number;
    sumY: number;
    weight: number;
    count: number;
  }>();

  for (let pointIndex = 0; pointIndex < sourceData.pointCount; pointIndex += 1) {
    const worldX = sourceData.xs[pointIndex]!;
    const worldY = sourceData.ys[pointIndex]!;
    const weight = sourceData.ws[pointIndex]!;
    const cellX = Math.floor(worldX / currentCellSize);
    const cellY = Math.floor(worldY / currentCellSize);
    const key = `${cellX}:${cellY}`;
    const existing = cells.get(key);
    if (existing) {
      existing.sumX += worldX * weight;
      existing.sumY += worldY * weight;
      existing.weight += weight;
      existing.count += 1;
    } else {
      cells.set(key, {
        cellX,
        cellY,
        sumX: worldX * weight,
        sumY: worldY * weight,
        weight,
        count: 1,
      });
    }
  }

  const bins: HeatmapCell[] = [];
  const items: Array<{ minX: number; minY: number; maxX: number; maxY: number; value: number }> = [];
  cells.forEach(cell => {
    if (cell.weight <= 0) return;
    const cellMinX = cell.cellX * currentCellSize;
    const cellMinY = cell.cellY * currentCellSize;
    const centerX = cell.sumX / cell.weight;
    const centerY = cell.sumY / cell.weight;
    const jitterSeed = hashIntPair(cell.cellX, cell.cellY, Math.round(currentCellSize * 1024));
    const bin: HeatmapCell = {
      minX: cellMinX,
      minY: cellMinY,
      maxX: cellMinX + currentCellSize,
      maxY: cellMinY + currentCellSize,
      worldX: centerX,
      worldY: centerY,
      renderWorldX: resolveJitteredCoordinate(
        centerX,
        cellMinX,
        cellMinX + currentCellSize,
        hashToUnitFloat(jitterSeed),
        adaptivePaddingFraction,
        adaptiveJitterFraction,
      ),
      renderWorldY: resolveJitteredCoordinate(
        centerY,
        cellMinY,
        cellMinY + currentCellSize,
        hashToUnitFloat(hashIntPair(cell.cellY, cell.cellX, jitterSeed ^ 0x68bc21eb)),
        adaptivePaddingFraction,
        adaptiveJitterFraction,
      ),
      weight: cell.weight,
      count: cell.count,
    };
    const value = bins.length;
    bins.push(bin);
    items.push({
      minX: bin.minX,
      minY: bin.minY,
      maxX: bin.maxX,
      maxY: bin.maxY,
      value,
    });
  });

  const index = createSpatialIndex<number>(32);
  index.load(items);
  const level = {
    cellWorldSize: currentCellSize,
    bins,
    index,
    normalizationUpperWeight: resolveNormalizationUpperWeight(bins, 1),
  };
  sourceData.levels[levelIndex] = level;
  return level;
}

function findLevelIndex(cellSizes: readonly number[], desiredCellWorldSize: number, previousIndex: number): number {
  if (cellSizes.length === 0) return 0;

  if (previousIndex >= 0 && previousIndex < cellSizes.length) {
    const previousCellSize = cellSizes[previousIndex]!;
    if (desiredCellWorldSize >= previousCellSize * 0.52 && desiredCellWorldSize <= previousCellSize * 2.1) {
      return previousIndex;
    }
  }

  let bestIndex = 0;
  let bestDistance = Infinity;
  const desiredLog = Math.log2(Math.max(1e-6, desiredCellWorldSize));

  for (let index = 0; index < cellSizes.length; index += 1) {
    const distance = Math.abs(Math.log2(cellSizes[index]!) - desiredLog);
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    bestIndex = index;
  }
  return bestIndex;
}

function resolveLevelIndex(params: {
  cellSizes: readonly number[];
  desiredCellWorldSize: number;
  zoomThreshold: number;
  maxRenderedPoints: number;
  viewBounds: [number, number, number, number];
  previousIndex: number;
}): number {
  const { cellSizes, desiredCellWorldSize, zoomThreshold, maxRenderedPoints, viewBounds, previousIndex } = params;
  let index = findLevelIndex(cellSizes, desiredCellWorldSize, previousIndex);
  const budget = Math.max(MIN_VISIBLE_BUDGET, maxRenderedPoints);
  while (index < cellSizes.length - 1 && estimateVisibleBinCount(viewBounds, cellSizes[index]!) > budget * 1.28) {
    index += 1;
  }
  while (index > 0 && estimateVisibleBinCount(viewBounds, cellSizes[index - 1]!) <= budget * 0.76) {
    index -= 1;
  }
  return Math.max(0, Math.min(cellSizes.length - 1, index + resolveThresholdLevelBias(zoomThreshold)));
}

function resolveScreenLevelBlend(params: {
  cellSizes: readonly number[];
  desiredCellWorldSize: number;
  zoomThreshold: number;
  maxRenderedPoints: number;
  viewBounds: [number, number, number, number];
}): { lowerIndex: number; upperIndex: number; upperWeight: number } {
  const { cellSizes, desiredCellWorldSize, zoomThreshold, maxRenderedPoints, viewBounds } = params;
  if (cellSizes.length === 0) {
    return { lowerIndex: 0, upperIndex: 0, upperWeight: 0 };
  }

  const stepLog = Math.log2(PYRAMID_SCALE_STEP);
  const firstCellLog = Math.log2(Math.max(1e-6, cellSizes[0]!));
  let desiredPosition =
    (Math.log2(Math.max(1e-6, desiredCellWorldSize)) - firstCellLog) / Math.max(1e-6, stepLog) +
    resolveThresholdLevelBias(zoomThreshold);

  const budget = Math.max(MIN_VISIBLE_BUDGET, maxRenderedPoints);
  let minimumBudgetIndex = 0;
  while (
    minimumBudgetIndex < cellSizes.length - 1 &&
    estimateVisibleBinCount(viewBounds, cellSizes[minimumBudgetIndex]!) > budget * 1.12
  ) {
    minimumBudgetIndex += 1;
  }

  desiredPosition = clamp(desiredPosition, minimumBudgetIndex, cellSizes.length - 1);
  const lowerIndex = Math.floor(desiredPosition);
  const upperIndex = Math.min(cellSizes.length - 1, Math.ceil(desiredPosition));
  const upperWeight = upperIndex === lowerIndex ? 0 : desiredPosition - lowerIndex;
  return { lowerIndex, upperIndex, upperWeight };
}

function collectVisibleCells(level: HeatmapLevel, viewBounds: [number, number, number, number], outerWorldRadius: number): HeatmapCell[] {
  const hits = level.index.search([
    viewBounds[0] - outerWorldRadius,
    viewBounds[1] - outerWorldRadius,
    viewBounds[2] + outerWorldRadius,
    viewBounds[3] + outerWorldRadius,
  ]);
  const visible: HeatmapCell[] = [];
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    if (!hit) continue;
    const cell = level.bins[hit.value];
    if (!cell) continue;
    visible.push(cell);
  }
  return visible;
}

function collectVisiblePointIndices(sourceData: HeatmapSourceData, viewBounds: [number, number, number, number], outerWorldRadius: number): number[] {
  const hits = sourceData.pointIndex.search([
    viewBounds[0] - outerWorldRadius,
    viewBounds[1] - outerWorldRadius,
    viewBounds[2] + outerWorldRadius,
    viewBounds[3] + outerWorldRadius,
  ]);
  const visible = new Array<number>(hits.length);
  let count = 0;
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    if (!hit) continue;
    visible[count] = hit.value;
    count += 1;
  }
  visible.length = count;
  return visible;
}

function resolveSampleProbability(visiblePointCount: number, maxRenderedPoints: number): number {
  const budget = Math.max(MIN_VISIBLE_BUDGET, maxRenderedPoints);
  if (visiblePointCount <= budget) return 1;
  return clamp(budget / Math.max(1, visiblePointCount), 1 / 65536, 1);
}

function resolveSampleStride(sampleProbability: number): number {
  if (sampleProbability >= 1) return 1;
  return Math.max(1, Math.round(1 / Math.max(1e-6, sampleProbability)));
}

function shouldKeepSample(pointIndex: number, sampleProbability: number): boolean {
  if (sampleProbability >= 1) return true;
  const sampleHash = hashIntPair(pointIndex, 0x51ed270b, 0x68bc21eb);
  return hashToUnitFloat(sampleHash) <= clamp(sampleProbability, 0, 1);
}

function resolvePointAlpha(binCount: number, kernelOuterRadiusPx: number, rasterWidth: number, rasterHeight: number): number {
  const rasterArea = Math.max(1, rasterWidth * rasterHeight);
  const kernelArea = Math.PI * kernelOuterRadiusPx * kernelOuterRadiusPx;
  const coverage = (Math.max(1, binCount) * kernelArea) / rasterArea;
  return clamp(0.085 / Math.sqrt(Math.max(1, coverage)), 0.012, 0.075);
}

function smoothHeatmapValue(previousValue: number, nextValue: number, riseFactor: number, fallFactor: number): number {
  if (!Number.isFinite(previousValue) || previousValue <= 0) {
    return nextValue;
  }
  const factor = nextValue >= previousValue ? riseFactor : fallFactor;
  return previousValue + (nextValue - previousValue) * clamp(factor, 0, 1);
}

function shouldFreezeScreenHeatmapAtMinZoom(
  renderer: NonNullable<ReturnType<typeof useViewerContext>["rendererRef"]["current"]>,
  rawZoom: number,
): boolean {
  if (!renderer.isViewAnimating()) return false;
  const zoomRange = renderer.getZoomRange();
  const minZoom = Math.max(1e-6, zoomRange.minZoom);
  return rawZoom <= minZoom * 1.075;
}

function getWebglRenderer(runtime: HeatmapRuntime): HeatmapWebGLRenderer | null {
  if (runtime.webgl !== undefined) {
    return runtime.webgl;
  }
  if (typeof document === "undefined") {
    runtime.webgl = null;
    return null;
  }
  try {
    runtime.webgl = new HeatmapWebGLRenderer();
  } catch (error) {
    if (!runtime.webglWarningIssued && typeof console !== "undefined" && typeof console.warn === "function") {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[open-plant] HeatmapLayer disabled because WebGL2 heatmap initialization failed: ${reason}`);
      runtime.webglWarningIssued = true;
    }
    runtime.webgl = null;
  }
  return runtime.webgl;
}

function projectClipRing(renderer: NonNullable<ReturnType<typeof useViewerContext>["rendererRef"]["current"]>, ring: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let index = 0; index < ring.length; index += 1) {
    const point = ring[index];
    if (!point) continue;
    const projected = renderer.worldToScreen(point[0], point[1]);
    if (!Array.isArray(projected) || projected.length < 2) continue;
    const x = Number(projected[0]);
    const y = Number(projected[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push([x, y]);
  }
  return out;
}

function applyClipPath(ctx: CanvasRenderingContext2D, renderer: NonNullable<ReturnType<typeof useViewerContext>["rendererRef"]["current"]>, polygons: readonly PreparedRoiPolygon[]): void {
  if (polygons.length === 0) return;
  ctx.beginPath();
  for (let index = 0; index < polygons.length; index += 1) {
    const polygon = polygons[index]!;
    const outer = projectClipRing(renderer, polygon.outer);
    if (outer.length >= 3) {
      tracePath(ctx, outer, true);
    }
    for (let holeIndex = 0; holeIndex < polygon.holes.length; holeIndex += 1) {
      const hole = projectClipRing(renderer, polygon.holes[holeIndex]!);
      if (hole.length >= 3) {
        tracePath(ctx, hole, true);
      }
    }
  }
  ctx.clip("evenodd");
}

function ensureSourceData(runtime: HeatmapRuntime, data: HeatmapPointData | null, clipPolygons: readonly PreparedRoiPolygon[], clipKey: string, source: WsiImageSource | null): HeatmapSourceData | null {
  const current = runtime.sourceData;
  if (current && current.sourceRef === source && isSameHeatmapInput(current, data, clipKey)) {
    return current;
  }
  runtime.sourceData = buildSourceData(data, clipPolygons, clipKey, source);
  runtime.fixedState = null;
  runtime.screenLevelIndex = -1;
  return runtime.sourceData;
}

function buildFixedState(params: {
  runtime: HeatmapRuntime;
  sourceData: HeatmapSourceData;
  renderer: NonNullable<ReturnType<typeof useViewerContext>["rendererRef"]["current"]>;
  source: WsiImageSource;
  logicalWidth: number;
  logicalHeight: number;
  radius: number;
  blur: number;
  fixedZoom?: number;
  zoomThreshold: number;
  densityContrast: number;
  maxRenderedPoints: number;
}): HeatmapFixedState | null {
  const { sourceData, renderer, source, logicalWidth, logicalHeight, radius, blur, fixedZoom, maxRenderedPoints } = params;

  const currentRawZoom = Math.max(1e-6, renderer.getViewState().zoom);
  const referenceZoom = fixedZoom ?? resolveContinuousZoom(currentRawZoom, source);
  const referenceRawZoom = resolveRawZoomFromContinuousZoom(referenceZoom, source);
  const frame = buildViewportFrame({
    logicalWidth,
    logicalHeight,
    totalPointCount: sourceData.pointCount,
    rawZoom: referenceRawZoom,
    radius,
    blur,
  });
  const viewBounds = renderer.getViewBounds();
  const visiblePointIndices = collectVisiblePointIndices(sourceData, viewBounds, frame.outerWorldRadius);
  const sampleProbability = resolveSampleProbability(visiblePointIndices.length, maxRenderedPoints);
  const sampleStride = resolveSampleStride(sampleProbability);
  const effectiveScale = Math.min(frame.rasterScaleX, frame.rasterScaleY);

  return {
    dataRef: sourceData.dataRef,
    positionsRef: sourceData.positionsRef,
    weightsRef: sourceData.weightsRef,
    inputCount: sourceData.inputCount,
    clipRef: sourceData.clipRef,
    clipKey: sourceData.clipKey,
    referenceZoom,
    referenceRawZoom,
    heatmapScale: frame.heatmapScale,
    kernelWorldRadius: frame.kernelRadiusPx / Math.max(1e-6, referenceRawZoom * effectiveScale),
    blurWorldRadius: frame.blurRadiusPx / Math.max(1e-6, referenceRawZoom * effectiveScale),
    sampleProbability,
    sampleStride,
    pointAlpha: resolvePointAlpha(visiblePointIndices.length, frame.kernelRadiusPx + frame.blurRadiusPx, frame.rasterWidth, frame.rasterHeight),
  };
}

function drawHeatmapWebgl(params: {
  ctx: CanvasRenderingContext2D;
  runtime: HeatmapRuntime;
  renderer: NonNullable<ReturnType<typeof useViewerContext>["rendererRef"]["current"]>;
  source: WsiImageSource;
  logicalWidth: number;
  logicalHeight: number;
  frame: ViewportFrame;
  cells: readonly HeatmapCell[];
  normalizationMaxWeight: number;
  pointAlpha: number;
  gradient: readonly string[];
  opacity: number;
  densityContrast: number;
  backgroundColor: string | null;
  clipPolygons: readonly PreparedRoiPolygon[];
}): number {
  const { ctx, runtime, renderer, logicalWidth, logicalHeight, frame, cells, normalizationMaxWeight, pointAlpha, gradient, opacity, densityContrast, backgroundColor, clipPolygons } = params;
  const { source } = params;
  const webgl = getWebglRenderer(runtime);
  if (!webgl || cells.length === 0) {
    return 0;
  }

  if (cells.length > runtime.webglCapacity) {
    runtime.webglCapacity = cells.length;
    runtime.webglPositions = new Float32Array(cells.length * 2);
    runtime.webglWeights = new Float32Array(cells.length);
  }
  const positions = runtime.webglPositions;
  const weights = runtime.webglWeights;
  if (!positions || !weights) {
    return 0;
  }

  const outerRadiusPx = frame.kernelRadiusPx + frame.blurRadiusPx;
  let drawCount = 0;

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index]!;
    const projected = renderer.worldToScreen(cell.renderWorldX, cell.renderWorldY);
    if (!Array.isArray(projected) || projected.length < 2) continue;

    const screenX = Number(projected[0]);
    const screenY = Number(projected[1]);
    if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) continue;

    const rasterX = screenX * frame.rasterScaleX;
    const rasterY = screenY * frame.rasterScaleY;
    if (
      rasterX < -outerRadiusPx ||
      rasterY < -outerRadiusPx ||
      rasterX > frame.rasterWidth + outerRadiusPx ||
      rasterY > frame.rasterHeight + outerRadiusPx
    ) {
      continue;
    }

    const offset = drawCount * 2;
    const supportFactor = resolveCellSupportFactor(cell.count);
    const normalizedWeight = resolveNormalizedDensityWeight(cell.weight, normalizationMaxWeight, densityContrast);
    const effectiveWeight = normalizedWeight * supportFactor;
    if (effectiveWeight <= 0.025) continue;

    positions[offset] = rasterX;
    positions[offset + 1] = rasterY;
    weights[drawCount] = effectiveWeight;
    drawCount += 1;
  }

  if (drawCount <= 0) {
    return 0;
  }

  const rendered = webgl.render({
    width: frame.rasterWidth,
    height: frame.rasterHeight,
    positions,
    weights,
    count: drawCount,
    kernelRadiusPx: frame.kernelRadiusPx,
    blurRadiusPx: frame.blurRadiusPx,
    pointAlpha,
    gradient,
    opacity,
    cutoff: resolveDensityCutoff(densityContrast),
    gain: resolveDensityGain(densityContrast),
    gamma: resolveDensityGamma(densityContrast),
    bias: resolveDensityBias(densityContrast),
    stretch: resolveDensityStretch(densityContrast, frame.rawZoom, source),
  });
  if (!rendered) {
    return 0;
  }

  ctx.save();
  if (clipPolygons.length > 0) {
    applyClipPath(ctx, renderer, clipPolygons);
  }
  if (backgroundColor) {
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, logicalWidth, logicalHeight);
  }
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(webgl.canvas, 0, 0, frame.rasterWidth, frame.rasterHeight, 0, 0, logicalWidth, logicalHeight);
  ctx.restore();

  return drawCount;
}

function drawHeatmapWebglPoints(params: {
  ctx: CanvasRenderingContext2D;
  runtime: HeatmapRuntime;
  renderer: NonNullable<ReturnType<typeof useViewerContext>["rendererRef"]["current"]>;
  source: WsiImageSource;
  logicalWidth: number;
  logicalHeight: number;
  frame: ViewportFrame;
  sourceData: HeatmapSourceData;
  visiblePointIndices: readonly number[];
  sampleProbability: number;
  sampleStride: number;
  pointAlpha: number;
  gradient: readonly string[];
  opacity: number;
  densityContrast: number;
  backgroundColor: string | null;
  clipPolygons: readonly PreparedRoiPolygon[];
}): number {
  const {
    ctx,
    runtime,
    renderer,
    source,
    logicalWidth,
    logicalHeight,
    frame,
    sourceData,
    visiblePointIndices,
    sampleProbability,
    sampleStride,
    pointAlpha,
    gradient,
    opacity,
    densityContrast,
    backgroundColor,
    clipPolygons,
  } = params;
  const webgl = getWebglRenderer(runtime);
  if (!webgl || visiblePointIndices.length === 0) {
    return 0;
  }

  const targetCapacity = Math.min(
    visiblePointIndices.length,
    Math.max(64, Math.ceil(visiblePointIndices.length * Math.min(1, sampleProbability * 1.15))),
  );
  if (targetCapacity > runtime.webglCapacity) {
    runtime.webglCapacity = targetCapacity;
    runtime.webglPositions = new Float32Array(targetCapacity * 2);
    runtime.webglWeights = new Float32Array(targetCapacity);
  }
  const positions = runtime.webglPositions;
  const weights = runtime.webglWeights;
  if (!positions || !weights) {
    return 0;
  }

  const outerRadiusPx = frame.kernelRadiusPx + frame.blurRadiusPx;
  const sampleWeightBoost = resolveSampleWeightBoost(sampleProbability);
  let drawCount = 0;

  for (let visibleIndex = 0; visibleIndex < visiblePointIndices.length; visibleIndex += 1) {
    const pointIndex = visiblePointIndices[visibleIndex]!;
    if (!shouldKeepSample(pointIndex, sampleProbability)) continue;

    const worldX = sourceData.xs[pointIndex];
    const worldY = sourceData.ys[pointIndex];
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) continue;

    const projected = renderer.worldToScreen(worldX, worldY);
    if (!Array.isArray(projected) || projected.length < 2) continue;

    const screenX = Number(projected[0]);
    const screenY = Number(projected[1]);
    if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) continue;

    const rasterX = screenX * frame.rasterScaleX;
    const rasterY = screenY * frame.rasterScaleY;
    if (
      rasterX < -outerRadiusPx ||
      rasterY < -outerRadiusPx ||
      rasterX > frame.rasterWidth + outerRadiusPx ||
      rasterY > frame.rasterHeight + outerRadiusPx
    ) {
      continue;
    }

    const offset = drawCount * 2;
    positions[offset] = rasterX;
    positions[offset + 1] = rasterY;
    weights[drawCount] = Math.max(0, (sourceData.ws[pointIndex] ?? 0) * sampleWeightBoost);
    drawCount += 1;
  }

  if (drawCount <= 0) {
    return 0;
  }

  const rendered = webgl.render({
    width: frame.rasterWidth,
    height: frame.rasterHeight,
    positions,
    weights,
    count: drawCount,
    kernelRadiusPx: frame.kernelRadiusPx,
    blurRadiusPx: frame.blurRadiusPx,
    pointAlpha,
    gradient,
    opacity,
    cutoff: resolveDensityCutoff(densityContrast),
    gain: resolveDensityGain(densityContrast),
    gamma: resolveDensityGamma(densityContrast),
    bias: resolveDensityBias(densityContrast),
    stretch: resolveDensityStretch(densityContrast, frame.rawZoom, source),
  });
  if (!rendered) {
    return 0;
  }

  ctx.save();
  if (clipPolygons.length > 0) {
    applyClipPath(ctx, renderer, clipPolygons);
  }
  if (backgroundColor) {
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, logicalWidth, logicalHeight);
  }
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(webgl.canvas, 0, 0, frame.rasterWidth, frame.rasterHeight, 0, 0, logicalWidth, logicalHeight);
  ctx.restore();

  return drawCount;
}

function drawHeatmap(params: {
  ctx: CanvasRenderingContext2D;
  runtime: HeatmapRuntime;
  renderer: NonNullable<ReturnType<typeof useViewerContext>["rendererRef"]["current"]>;
  source: WsiImageSource;
  logicalWidth: number;
  logicalHeight: number;
  state: DrawState;
}): HeatmapLayerStats | null {
  const { ctx, runtime, renderer, source, logicalWidth, logicalHeight, state } = params;
  const sourceData = ensureSourceData(runtime, state.data, state.clipPolygons, state.clipKey, source);
  if (!sourceData || sourceData.cellSizes.length === 0 || sourceData.pointCount <= 0) {
    return null;
  }

  const rawZoom = Math.max(1e-6, renderer.getViewState().zoom);
  const zoomVisibilityStrength = resolveZoomVisibilityStrength(rawZoom, source, state.zoomThreshold);
  const viewBounds = renderer.getViewBounds();
  if (zoomVisibilityStrength <= 0.001) {
    return {
      pointCount: sourceData.pointCount,
      renderTimeMs: 0,
      visiblePointCount: 0,
      renderedBinCount: 0,
      sampleStride: 1,
      maxDensity: 0,
    };
  }

  if (state.scaleMode !== "fixed-zoom") {
    const frame = buildViewportFrame({
      logicalWidth,
      logicalHeight,
      totalPointCount: sourceData.pointCount,
      rawZoom,
      radius: state.radius,
      blur: state.blur,
    });
    const visiblePointIndices = collectVisiblePointIndices(sourceData, viewBounds, frame.outerWorldRadius);
    if (visiblePointIndices.length === 0) {
      return {
        pointCount: sourceData.pointCount,
        renderTimeMs: 0,
        visiblePointCount: 0,
        renderedBinCount: 0,
        sampleStride: 1,
        maxDensity: 0,
      };
    }

    const sampleProbability = resolveSampleProbability(visiblePointIndices.length, state.maxRenderedPoints);
    const sampleStride = resolveSampleStride(sampleProbability);
    const targetPointAlpha = resolvePointAlpha(
      visiblePointIndices.length,
      frame.kernelRadiusPx + frame.blurRadiusPx,
      frame.rasterWidth,
      frame.rasterHeight,
    );
    runtime.screenLevelIndex = -1;
    runtime.screenSecondaryLevelIndex = -1;
    runtime.screenSecondaryLevelWeight = 0;
    runtime.screenNormalizationMaxWeight = 1;
    runtime.screenPointAlpha = smoothHeatmapValue(runtime.screenPointAlpha, targetPointAlpha, 0.12, 0.08);
    runtime.screenVisibilityStrength = renderer.isViewAnimating()
      ? smoothHeatmapValue(runtime.screenVisibilityStrength, zoomVisibilityStrength, 0.16, 0.12)
      : zoomVisibilityStrength;

    const renderedPointCount = drawHeatmapWebglPoints({
      ctx,
      runtime,
      renderer,
      source,
      logicalWidth,
      logicalHeight,
      frame,
      sourceData,
      visiblePointIndices,
      sampleProbability,
      sampleStride,
      pointAlpha: runtime.screenPointAlpha * Math.max(0.08, runtime.screenVisibilityStrength),
      gradient: state.gradient,
      opacity: state.opacity * runtime.screenVisibilityStrength,
      densityContrast: state.densityContrast,
      backgroundColor: state.backgroundColor,
      clipPolygons: state.clipPolygons,
    });

    return {
      pointCount: sourceData.pointCount,
      renderTimeMs: 0,
      visiblePointCount: visiblePointIndices.length,
      renderedBinCount: renderedPointCount,
      sampleStride,
      maxDensity: Math.round(runtime.screenPointAlpha * 255),
    };
  }

  const fixedState = runtime.fixedState;
  if (!fixedState) return null;

  const frame = buildViewportFrame({
    logicalWidth,
    logicalHeight,
    totalPointCount: sourceData.pointCount,
    rawZoom,
    radius: state.radius,
    blur: state.blur,
    heatmapScale: fixedState.heatmapScale,
  });
  const effectiveScale = Math.min(frame.rasterScaleX, frame.rasterScaleY);
  frame.kernelRadiusPx = Math.max(0.75, fixedState.kernelWorldRadius * rawZoom * effectiveScale);
  frame.blurRadiusPx = Math.max(0.6, fixedState.blurWorldRadius * rawZoom * effectiveScale);
  frame.outerWorldRadius = fixedState.kernelWorldRadius + fixedState.blurWorldRadius;

  const visiblePointIndices = collectVisiblePointIndices(sourceData, viewBounds, frame.outerWorldRadius);
  if (visiblePointIndices.length === 0) {
    return {
      pointCount: sourceData.pointCount,
      renderTimeMs: 0,
      visiblePointCount: 0,
      renderedBinCount: 0,
      sampleStride: 1,
      maxDensity: 0,
    };
  }

  runtime.screenPointAlpha = fixedState.pointAlpha;
  runtime.screenVisibilityStrength = zoomVisibilityStrength;

  const renderedPointCount = drawHeatmapWebglPoints({
    ctx,
    runtime,
    renderer,
    source,
    logicalWidth,
    logicalHeight,
    frame,
    sourceData,
    visiblePointIndices,
    sampleProbability: fixedState.sampleProbability,
    sampleStride: fixedState.sampleStride,
    pointAlpha: fixedState.pointAlpha * Math.max(0.08, zoomVisibilityStrength),
    gradient: state.gradient,
    opacity: state.opacity * zoomVisibilityStrength,
    densityContrast: state.densityContrast,
    backgroundColor: state.backgroundColor,
    clipPolygons: state.clipPolygons,
  });

  return {
    pointCount: sourceData.pointCount,
    renderTimeMs: 0,
    visiblePointCount: visiblePointIndices.length,
    renderedBinCount: renderedPointCount,
    sampleStride: fixedState.sampleStride,
    maxDensity: Math.round(fixedState.pointAlpha * 255),
  };
}

export function HeatmapLayer({
  data,
  visible = true,
  opacity = DEFAULT_OPACITY,
  radius = DEFAULT_RADIUS,
  blur = DEFAULT_BLUR,
  gradient = DEFAULT_GRADIENT,
  backgroundColor = null,
  scaleMode = DEFAULT_SCALE_MODE,
  fixedZoom,
  zoomThreshold = 0,
  densityContrast = DEFAULT_DENSITY_CONTRAST,
  clipToRegions,
  zIndex = 5,
  maxRenderedPoints = DEFAULT_MAX_RENDERED_POINTS,
  onStats,
}: HeatmapLayerProps): null {
  const { rendererRef, source, registerDrawCallback, unregisterDrawCallback, requestOverlayRedraw } = useViewerContext();

  const clipPolygons = useMemo(() => {
    const geometries = (clipToRegions ?? [])
      .map(region => toRoiGeometry(region?.coordinates))
      .filter((geometry): geometry is NonNullable<typeof geometry> => geometry != null);
    return prepareRoiPolygons(geometries);
  }, [clipToRegions]);
  const clipKey = useMemo(() => buildClipKey(clipPolygons), [clipPolygons]);

  const runtimeRef = useRef<HeatmapRuntime>({
    sourceData: null,
    fixedState: null,
    screenLevelIndex: -1,
    screenSecondaryLevelIndex: -1,
    screenSecondaryLevelWeight: 0,
    screenPointAlpha: 0,
    screenNormalizationMaxWeight: 1,
    screenVisibilityStrength: 1,
    webgl: undefined,
    webglWarningIssued: false,
    webglPositions: null,
    webglWeights: null,
    webglCapacity: 0,
  });

  const stateRef = useRef<DrawState>({
    data,
    visible,
    opacity,
    radius: clamp(radius, 0.05, 128),
    blur: clamp(blur, 0.05, 128),
    gradient,
    backgroundColor,
    scaleMode,
    fixedZoom,
    zoomThreshold,
    densityContrast: clamp(densityContrast, 0, MAX_DENSITY_CONTRAST),
    clipPolygons,
    clipKey,
    maxRenderedPoints: Math.max(MIN_VISIBLE_BUDGET, Math.floor(maxRenderedPoints)),
    onStats,
  });

  stateRef.current = {
    data,
    visible,
    opacity,
    radius: clamp(radius, 0.05, 128),
    blur: clamp(blur, 0.05, 128),
    gradient,
    backgroundColor,
    scaleMode,
    fixedZoom,
    zoomThreshold,
    densityContrast: clamp(densityContrast, 0, MAX_DENSITY_CONTRAST),
    clipPolygons,
    clipKey,
    maxRenderedPoints: Math.max(MIN_VISIBLE_BUDGET, Math.floor(maxRenderedPoints)),
    onStats,
  };

  useEffect(() => {
    const draw = (ctx: CanvasRenderingContext2D, logicalWidth: number, logicalHeight: number): void => {
      const state = stateRef.current;
      const runtime = runtimeRef.current;
      const renderer = rendererRef.current;
      if (!state.visible || !state.data || !renderer || !source) return;

      const sourceData = ensureSourceData(runtime, state.data, state.clipPolygons, state.clipKey, source);
      if (!sourceData) return;

      const needsFixedState =
        state.scaleMode === "fixed-zoom" &&
        (!runtime.fixedState ||
          !isSameHeatmapInput(runtime.fixedState, state.data, state.clipKey) ||
          (state.fixedZoom !== undefined && Math.abs(runtime.fixedState.referenceZoom - state.fixedZoom) > 1e-6));

      if (needsFixedState) {
        runtime.fixedState = buildFixedState({
          runtime,
          sourceData,
          renderer,
          source,
          logicalWidth,
          logicalHeight,
          radius: state.radius,
          blur: state.blur,
          fixedZoom: state.fixedZoom,
          zoomThreshold: state.zoomThreshold,
          densityContrast: state.densityContrast,
          maxRenderedPoints: state.maxRenderedPoints,
        });
      } else if (state.scaleMode !== "fixed-zoom") {
        runtime.fixedState = null;
      }

      const startedAt = performance.now();
      const stats = drawHeatmap({
        ctx,
        runtime,
        renderer,
        source,
        logicalWidth,
        logicalHeight,
        state,
      });
      if (!stats || !state.onStats) return;
      state.onStats({
        ...stats,
        renderTimeMs: performance.now() - startedAt,
      });
    };

    registerDrawCallback(HEATMAP_DRAW_ID, zIndex, draw);
    return () => {
      unregisterDrawCallback(HEATMAP_DRAW_ID);
      runtimeRef.current.sourceData = null;
      runtimeRef.current.fixedState = null;
      runtimeRef.current.screenLevelIndex = -1;
      runtimeRef.current.screenSecondaryLevelIndex = -1;
      runtimeRef.current.screenSecondaryLevelWeight = 0;
      runtimeRef.current.screenPointAlpha = 0;
      runtimeRef.current.screenNormalizationMaxWeight = 1;
      runtimeRef.current.screenVisibilityStrength = 1;
      runtimeRef.current.webgl?.destroy();
      runtimeRef.current.webgl = undefined;
      runtimeRef.current.webglPositions = null;
      runtimeRef.current.webglWeights = null;
      runtimeRef.current.webglCapacity = 0;
    };
  }, [registerDrawCallback, unregisterDrawCallback, rendererRef, source, zIndex]);

  useEffect(() => {
    runtimeRef.current.sourceData = null;
    runtimeRef.current.fixedState = null;
    runtimeRef.current.screenLevelIndex = -1;
    runtimeRef.current.screenSecondaryLevelIndex = -1;
    runtimeRef.current.screenSecondaryLevelWeight = 0;
    runtimeRef.current.screenPointAlpha = 0;
    runtimeRef.current.screenNormalizationMaxWeight = 1;
    runtimeRef.current.screenVisibilityStrength = 1;
    requestOverlayRedraw();
  }, [data?.positions, data?.weights, data?.count, clipKey, requestOverlayRedraw]);

  useEffect(() => {
    runtimeRef.current.fixedState = null;
    runtimeRef.current.screenSecondaryLevelIndex = -1;
    runtimeRef.current.screenSecondaryLevelWeight = 0;
    runtimeRef.current.screenPointAlpha = 0;
    runtimeRef.current.screenNormalizationMaxWeight = 1;
    runtimeRef.current.screenVisibilityStrength = 1;
    requestOverlayRedraw();
  }, [radius, blur, scaleMode, fixedZoom, zoomThreshold, densityContrast, maxRenderedPoints, requestOverlayRedraw]);

  useEffect(() => {
    requestOverlayRedraw();
  }, [visible, opacity, gradient, backgroundColor, requestOverlayRedraw]);

  return null;
}

export const __heatmapLayerInternals = {
  applyZoomThreshold,
  buildClipKey,
  resolveCellSupportFactor,
  resolveContinuousZoom,
  resolveDensityCutoff,
  resolveDensityBias,
  resolveDensityGain,
  resolveDensityGamma,
  resolveDensityStretch,
  resolveNormalizedDensityWeight,
  resolveNormalizationUpperWeight,
  resolveDensityWeightExponent,
  resolveRawZoomFromContinuousZoom,
  resolvePointCount,
  resolveThresholdLevelBias,
  resolveZoomVisibilityStrength,
  isSameHeatmapInput,
};
