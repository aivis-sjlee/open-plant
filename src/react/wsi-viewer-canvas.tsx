import {
  type CSSProperties,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { filterPointDataByPolygons, type RoiPolygon } from "../wsi/point-clip";
import { filterPointDataByPolygonsHybrid } from "../wsi/point-clip-hybrid";
import { filterPointDataByPolygonsInWorker, type PointClipMode } from "../wsi/point-clip-worker-client";
import { buildPointSpatialIndexAsync, type FlatPointSpatialIndex, lookupCellIndex } from "../wsi/point-hit-index-worker-client";
import { type PreparedRoiPolygon, toRoiGeometry } from "../wsi/roi-geometry";
import { computeRoiPointGroups, type RoiPointGroupStats } from "../wsi/roi-term-stats";
import type { WsiImageColorSettings, WsiImageSource, WsiPointData, WsiRegion, WsiRenderStats, WsiViewState } from "../wsi/types";
import { clamp } from "../wsi/utils";
import { type PointSizeByZoom, type WsiTileErrorEvent, WsiTileRenderer, type WsiViewTransitionOptions } from "../wsi/wsi-tile-renderer";
import type {
  BrushOptions,
  DrawAreaTooltipOptions,
  DrawCoordinate,
  DrawOverlayShape,
  DrawRegionCoordinates,
  DrawResult,
  DrawTool,
  PatchDrawResult,
  RegionLabelStyle,
  RegionLabelStyleResolver,
  RegionStrokeStyle,
  RegionStrokeStyleResolver,
  StampOptions,
} from "./draw-layer";
import { DrawLayer, resolveRegionLabelAutoLiftOffsetPx, resolveRegionLabelStyle } from "./draw-layer";
import { toDrawCoordinate } from "./draw-layer-utils";
import { OverviewMap, type OverviewMapOptions } from "./overview-map";
import { type PreparedRegionHit, pickPreparedRegionAt, prepareRegionHits, resolveRegionId } from "./wsi-region-hit-utils";

const EMPTY_ROI_REGIONS: WsiRegion[] = [];
const EMPTY_ROI_POLYGONS: DrawRegionCoordinates[] = [];
const EMPTY_CLIPPED_POINTS: WsiPointData = {
  count: 0,
  positions: new Float32Array(0),
  paletteIndices: new Uint16Array(0),
};
const POINT_HIT_RADIUS_SCALE = 0.65;
const MIN_POINT_HIT_RADIUS_PX = 4;
const REGION_LABEL_AUTO_LIFT_ANIMATION_DURATION_MS = 180;
const REGION_LABEL_AUTO_LIFT_MAX_OFFSET_PX = 20;

export interface RegionHoverEvent {
  region: WsiRegion | null;
  regionId: string | number | null;
  regionIndex: number;
  coordinate: DrawCoordinate | null;
}

export interface RegionClickEvent {
  region: WsiRegion;
  regionId: string | number;
  regionIndex: number;
  coordinate: DrawCoordinate;
}

export interface PointHitEvent {
  index: number;
  id: number | null;
  coordinate: DrawCoordinate;
  pointCoordinate: DrawCoordinate;
}

export interface PointClickEvent extends PointHitEvent {
  button: number;
}

export interface PointHoverEvent {
  index: number | null;
  id: number | null;
  coordinate: DrawCoordinate | null;
  pointCoordinate: DrawCoordinate | null;
}

export interface PointClipStatsEvent {
  mode: PointClipMode;
  durationMs: number;
  inputCount: number;
  outputCount: number;
  polygonCount: number;
  usedWebGpu?: boolean;
  candidateCount?: number;
  bridgedToDraw?: boolean;
}

export interface PointerWorldMoveEvent {
  coordinate: DrawCoordinate | null;
  clientX: number;
  clientY: number;
  insideImage: boolean;
}

export interface WsiCustomLayerContext {
  source: WsiImageSource;
  viewState: WsiViewState;
  drawTool: DrawTool;
  interactionLock: boolean;
  worldToScreen: (worldX: number, worldY: number) => DrawCoordinate | null;
  screenToWorld: (clientX: number, clientY: number) => DrawCoordinate | null;
  requestRedraw: () => void;
}

export interface WsiCustomLayer {
  id?: string | number;
  zIndex?: number;
  pointerEvents?: CSSProperties["pointerEvents"];
  className?: string;
  style?: CSSProperties;
  render: (context: WsiCustomLayerContext) => ReactNode;
}

function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export interface OverviewMapConfig {
  show?: boolean;
  options?: Partial<OverviewMapOptions>;
  className?: string;
  style?: CSSProperties;
}

export interface WsiViewerCanvasProps {
  source: WsiImageSource | null;
  viewState?: Partial<WsiViewState> | null;
  imageColorSettings?: WsiImageColorSettings | null;
  onViewStateChange?: (next: WsiViewState) => void;
  onStats?: (stats: WsiRenderStats) => void;
  onTileError?: (event: WsiTileErrorEvent) => void;
  onContextLost?: () => void;
  onContextRestored?: () => void;
  debugOverlay?: boolean;
  debugOverlayStyle?: CSSProperties;
  fitNonce?: number;
  rotationResetNonce?: number;
  authToken?: string;
  ctrlDragRotate?: boolean;
  pointData?: WsiPointData | null;
  pointPalette?: Uint8Array | null;
  pointSizeByZoom?: PointSizeByZoom;
  pointStrokeScale?: number;
  minZoom?: number;
  maxZoom?: number;
  viewTransition?: WsiViewTransitionOptions;
  roiRegions?: WsiRegion[];
  roiPolygons?: DrawRegionCoordinates[];
  clipPointsToRois?: boolean;
  clipMode?: PointClipMode;
  onClipStats?: (event: PointClipStatsEvent) => void;
  onRoiPointGroups?: (stats: RoiPointGroupStats) => void;
  roiPaletteIndexToTermId?: ReadonlyMap<number, string> | readonly string[];
  interactionLock?: boolean;
  drawTool?: DrawTool;
  stampOptions?: StampOptions;
  brushOptions?: BrushOptions;
  drawFillColor?: string;
  regionStrokeStyle?: Partial<RegionStrokeStyle>;
  regionStrokeHoverStyle?: Partial<RegionStrokeStyle>;
  regionStrokeActiveStyle?: Partial<RegionStrokeStyle>;
  patchStrokeStyle?: Partial<RegionStrokeStyle>;
  resolveRegionStrokeStyle?: RegionStrokeStyleResolver;
  resolveRegionLabelStyle?: RegionLabelStyleResolver;
  overlayShapes?: DrawOverlayShape[];
  customLayers?: WsiCustomLayer[];
  patchRegions?: WsiRegion[];
  regionLabelStyle?: Partial<RegionLabelStyle>;
  drawAreaTooltip?: DrawAreaTooltipOptions;
  autoLiftRegionLabelAtMaxZoom?: boolean;
  onPointerWorldMove?: (event: PointerWorldMoveEvent) => void;
  onPointHover?: (event: PointHoverEvent) => void;
  onPointClick?: (event: PointClickEvent) => void;
  onRegionHover?: (event: RegionHoverEvent) => void;
  onRegionClick?: (event: RegionClickEvent) => void;
  activeRegionId?: string | number | null;
  onActiveRegionChange?: (regionId: string | number | null) => void;
  getCellByCoordinatesRef?: MutableRefObject<((coordinate: DrawCoordinate) => PointHitEvent | null) | null>;
  onDrawComplete?: (result: DrawResult) => void;
  onPatchComplete?: (result: PatchDrawResult) => void;
  overviewMapConfig?: OverviewMapConfig;
  className?: string;
  style?: CSSProperties;
}

export function WsiViewerCanvas({
  source,
  viewState,
  imageColorSettings = null,
  onViewStateChange,
  onStats,
  onTileError,
  onContextLost,
  onContextRestored,
  debugOverlay = false,
  debugOverlayStyle,
  fitNonce = 0,
  rotationResetNonce = 0,
  authToken = "",
  ctrlDragRotate = true,
  pointData = null,
  pointPalette = null,
  pointSizeByZoom,
  pointStrokeScale,
  minZoom,
  maxZoom,
  viewTransition,
  roiRegions,
  roiPolygons,
  clipPointsToRois = false,
  clipMode = "worker",
  onClipStats,
  onRoiPointGroups,
  roiPaletteIndexToTermId,
  interactionLock = false,
  drawTool = "cursor",
  stampOptions,
  brushOptions,
  drawFillColor,
  regionStrokeStyle,
  regionStrokeHoverStyle,
  regionStrokeActiveStyle,
  patchStrokeStyle,
  resolveRegionStrokeStyle,
  resolveRegionLabelStyle: resolveRegionLabelStyleProp,
  overlayShapes,
  customLayers,
  patchRegions,
  regionLabelStyle,
  drawAreaTooltip,
  autoLiftRegionLabelAtMaxZoom = false,
  onPointerWorldMove,
  onPointHover,
  onPointClick,
  onRegionHover,
  onRegionClick,
  activeRegionId: controlledActiveRegionId,
  onActiveRegionChange,
  getCellByCoordinatesRef,
  onDrawComplete,
  onPatchComplete,
  overviewMapConfig,
  className,
  style,
}: WsiViewerCanvasProps): React.ReactElement {
  const showOverviewMap = overviewMapConfig?.show ?? false;
  const overviewMapOptions = overviewMapConfig?.options;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<WsiTileRenderer | null>(null);
  const drawInvalidateRef = useRef<(() => void) | null>(null);
  const overviewInvalidateRef = useRef<(() => void) | null>(null);
  const onViewStateChangeRef = useRef<typeof onViewStateChange>(onViewStateChange);
  const onStatsRef = useRef<typeof onStats>(onStats);
  const debugOverlayRef = useRef(debugOverlay);
  const [hoveredRegionId, setHoveredRegionId] = useState<string | number | null>(null);
  const [uncontrolledActiveRegionId, setUncontrolledActiveRegionId] = useState<string | number | null>(() => controlledActiveRegionId ?? null);
  const isActiveRegionControlled = controlledActiveRegionId !== undefined;
  const activeRegionId = isActiveRegionControlled ? (controlledActiveRegionId ?? null) : uncontrolledActiveRegionId;
  const [customLayerViewState, setCustomLayerViewState] = useState<WsiViewState | null>(null);
  const [debugStats, setDebugStats] = useState<WsiRenderStats | null>(null);
  const [regionLabelAutoLiftOffsetPx, setRegionLabelAutoLiftOffsetPx] = useState(0);
  const hoveredRegionIdRef = useRef<string | number | null>(null);
  const hoveredPointIndexRef = useRef<number | null>(null);
  const hoveredPointIdRef = useRef<number | null>(null);
  const regionLabelAutoLiftOffsetRef = useRef(0);
  const regionLabelAutoLiftAnimationRef = useRef<{ rafId: number | null; startMs: number; from: number; to: number }>({
    rafId: null,
    startMs: 0,
    from: 0,
    to: 0,
  });
  const clipRunIdRef = useRef(0);
  const safeRoiRegions = roiRegions ?? EMPTY_ROI_REGIONS;
  const safePatchRegions = patchRegions ?? EMPTY_ROI_REGIONS;
  const safeRoiPolygons = roiPolygons ?? EMPTY_ROI_POLYGONS;
  const shouldTrackCustomLayerViewState = (customLayers?.length ?? 0) > 0;

  const mergedStyle = useMemo<CSSProperties>(() => ({ position: "relative", width: "100%", height: "100%", ...style }), [style]);
  const mergedDebugOverlayStyle = useMemo<CSSProperties>(
    () => ({
      position: "absolute",
      top: 8,
      left: 8,
      zIndex: 7,
      margin: 0,
      padding: "8px 10px",
      maxWidth: "min(420px, 80%)",
      pointerEvents: "none",
      whiteSpace: "pre-wrap",
      lineHeight: 1.35,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 11,
      color: "#cde6ff",
      background: "rgba(6, 12, 20, 0.82)",
      border: "1px solid rgba(173, 216, 255, 0.28)",
      borderRadius: 8,
      boxShadow: "0 8px 22px rgba(0,0,0,0.35)",
      ...debugOverlayStyle,
    }),
    [debugOverlayStyle]
  );

  const effectiveRoiRegions = useMemo<WsiRegion[]>(() => {
    if (safeRoiRegions.length > 0) {
      return safeRoiRegions;
    }
    if (safeRoiPolygons.length === 0) {
      return EMPTY_ROI_REGIONS;
    }
    return safeRoiPolygons.map((coordinates, index) => ({
      id: index,
      coordinates,
    }));
  }, [safeRoiRegions, safeRoiPolygons]);
  const preparedRegionHits = useMemo(() => prepareRegionHits(effectiveRoiRegions), [effectiveRoiRegions]);
  const resolvedRegionLabelStyle = useMemo(() => resolveRegionLabelStyle(regionLabelStyle), [regionLabelStyle]);

  const applyRegionLabelAutoLiftOffset = useCallback((next: number) => {
    const clamped = clamp(next, 0, REGION_LABEL_AUTO_LIFT_MAX_OFFSET_PX);
    if (Math.abs(regionLabelAutoLiftOffsetRef.current - clamped) < 1e-4) return;
    regionLabelAutoLiftOffsetRef.current = clamped;
    setRegionLabelAutoLiftOffsetPx(clamped);
  }, []);

  const cancelRegionLabelAutoLiftAnimation = useCallback(() => {
    const animation = regionLabelAutoLiftAnimationRef.current;
    if (animation.rafId !== null) {
      cancelAnimationFrame(animation.rafId);
      animation.rafId = null;
    }
  }, []);

  const animateRegionLabelAutoLiftTo = useCallback(
    (target: number) => {
      const clampedTarget = clamp(target, 0, REGION_LABEL_AUTO_LIFT_MAX_OFFSET_PX);
      const animation = regionLabelAutoLiftAnimationRef.current;
      const from = regionLabelAutoLiftOffsetRef.current;
      if (Math.abs(from - clampedTarget) < 1e-4) {
        cancelRegionLabelAutoLiftAnimation();
        animation.to = clampedTarget;
        applyRegionLabelAutoLiftOffset(clampedTarget);
        return;
      }

      cancelRegionLabelAutoLiftAnimation();
      animation.startMs = performance.now();
      animation.from = from;
      animation.to = clampedTarget;

      const step = (timestamp: number) => {
        const current = regionLabelAutoLiftAnimationRef.current;
        const elapsed = Math.max(0, timestamp - current.startMs);
        const rawT = REGION_LABEL_AUTO_LIFT_ANIMATION_DURATION_MS <= 0 ? 1 : clamp(elapsed / REGION_LABEL_AUTO_LIFT_ANIMATION_DURATION_MS, 0, 1);
        const eased = smoothstep01(rawT);
        const nextValue = current.from + (current.to - current.from) * eased;
        applyRegionLabelAutoLiftOffset(nextValue);
        drawInvalidateRef.current?.();

        if (rawT >= 1) {
          current.rafId = null;
          applyRegionLabelAutoLiftOffset(current.to);
          return;
        }
        current.rafId = requestAnimationFrame(step);
      };

      animation.rafId = requestAnimationFrame(step);
    },
    [applyRegionLabelAutoLiftOffset, cancelRegionLabelAutoLiftAnimation]
  );

  const syncRegionLabelAutoLiftTarget = useCallback(
    (zoom: number | null | undefined) => {
      const renderer = rendererRef.current;
      if (!renderer || typeof zoom !== "number" || !Number.isFinite(zoom)) {
        animateRegionLabelAutoLiftTo(0);
        return;
      }
      const target = resolveRegionLabelAutoLiftOffsetPx(autoLiftRegionLabelAtMaxZoom, zoom, renderer.getZoomRange());
      animateRegionLabelAutoLiftTo(target);
    },
    [autoLiftRegionLabelAtMaxZoom, animateRegionLabelAutoLiftTo]
  );

  const clipPolygons = useMemo<RoiPolygon[]>(() => effectiveRoiRegions.map(region => toRoiGeometry(region.coordinates)).filter((p): p is RoiPolygon => p != null), [effectiveRoiRegions]);

  const [renderPointData, setRenderPointData] = useState<WsiPointData | null>(pointData);

  useEffect(() => {
    const runId = ++clipRunIdRef.current;
    let cancelled = false;

    if (!clipPointsToRois) {
      setRenderPointData(pointData);
      return () => {
        cancelled = true;
      };
    }

    if (!pointData || !pointData.count || !pointData.positions || !pointData.paletteIndices) {
      setRenderPointData(null);
      return () => {
        cancelled = true;
      };
    }

    if (clipPolygons.length === 0) {
      setRenderPointData(EMPTY_CLIPPED_POINTS);
      onClipStats?.({
        mode: clipMode,
        durationMs: 0,
        inputCount: pointData.count,
        outputCount: 0,
        polygonCount: 0,
      });
      return () => {
        cancelled = true;
      };
    }

    const applyResult = (data: WsiPointData | null, stats: Omit<PointClipStatsEvent, "inputCount" | "outputCount" | "polygonCount">) => {
      if (cancelled || runId !== clipRunIdRef.current) return;
      const inputCount = pointData.count;
      const outputCount = data?.drawIndices ? data.drawIndices.length : (data?.count ?? 0);
      setRenderPointData(data);
      onClipStats?.({
        mode: stats.mode,
        durationMs: stats.durationMs,
        inputCount,
        outputCount,
        polygonCount: clipPolygons.length,
        usedWebGpu: stats.usedWebGpu,
        candidateCount: stats.candidateCount,
        bridgedToDraw: stats.bridgedToDraw,
      });
    };

    const run = async (): Promise<void> => {
      if (clipMode === "sync") {
        const start = performance.now();
        const data = filterPointDataByPolygons(pointData, clipPolygons);
        applyResult(data, {
          mode: "sync",
          durationMs: performance.now() - start,
        });
        return;
      }

      if (clipMode === "hybrid-webgpu") {
        const result = await filterPointDataByPolygonsHybrid(pointData, clipPolygons, { bridgeToDraw: true });
        applyResult(result.data, {
          mode: result.meta.mode,
          durationMs: result.meta.durationMs,
          usedWebGpu: result.meta.usedWebGpu,
          candidateCount: result.meta.candidateCount,
          bridgedToDraw: result.meta.bridgedToDraw,
        });
        return;
      }

      try {
        const result = await filterPointDataByPolygonsInWorker(pointData, clipPolygons);
        applyResult(result.data, {
          mode: result.meta.mode,
          durationMs: result.meta.durationMs,
        });
      } catch {
        const start = performance.now();
        const data = filterPointDataByPolygons(pointData, clipPolygons);
        applyResult(data, {
          mode: "sync",
          durationMs: performance.now() - start,
        });
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [clipPointsToRois, clipMode, pointData, clipPolygons, onClipStats]);

  const shouldEnablePointHitTest = Boolean(onPointHover || onPointClick || getCellByCoordinatesRef);
  const [pointSpatialIndex, setPointSpatialIndex] = useState<FlatPointSpatialIndex | null>(null);

  useEffect(() => {
    if (!shouldEnablePointHitTest || !renderPointData) {
      setPointSpatialIndex(null);
      return;
    }
    let cancelled = false;

    buildPointSpatialIndexAsync(renderPointData, source).then(nextIndex => {
      if (!cancelled) setPointSpatialIndex(nextIndex);
    });

    return () => {
      cancelled = true;
    };
  }, [shouldEnablePointHitTest, renderPointData, source]);

  const getCellByCoordinates = useCallback(
    (coordinate: DrawCoordinate): PointHitEvent | null => {
      const renderer = rendererRef.current;
      if (!renderer || !pointSpatialIndex) return null;

      const x = Number(coordinate[0]);
      const y = Number(coordinate[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

      const zoom = Math.max(1e-6, renderer.getViewState().zoom);
      const pointSizePx = renderer.getPointSizeByZoom();
      const hitRadiusPx = Math.max(MIN_POINT_HIT_RADIUS_PX, pointSizePx * POINT_HIT_RADIUS_SCALE);
      const hitRadiusWorld = hitRadiusPx / zoom;
      if (!Number.isFinite(hitRadiusWorld) || hitRadiusWorld <= 0) return null;

      const { cellSize, cellOffsets, cellLengths, pointIndices: idxBuf, positions: posBuf, safeCount } = pointSpatialIndex;
      const baseCellX = Math.floor(x / cellSize);
      const baseCellY = Math.floor(y / cellSize);
      const cellRadius = Math.max(1, Math.ceil(hitRadiusWorld / cellSize));
      const maxDist2 = hitRadiusWorld * hitRadiusWorld;

      let nearestIndex = -1;
      let nearestDist2 = maxDist2;
      let nearestX = 0;
      let nearestY = 0;

      for (let cx = baseCellX - cellRadius; cx <= baseCellX + cellRadius; cx += 1) {
        for (let cy = baseCellY - cellRadius; cy <= baseCellY + cellRadius; cy += 1) {
          const ci = lookupCellIndex(pointSpatialIndex, cx, cy);
          if (ci < 0) continue;

          const off = cellOffsets[ci];
          const end = off + cellLengths[ci];
          for (let i = off; i < end; i += 1) {
            const pointIndex = idxBuf[i];
            if (pointIndex >= safeCount) continue;

            const px = posBuf[pointIndex * 2];
            const py = posBuf[pointIndex * 2 + 1];
            const dx = px - x;
            const dy = py - y;
            const dist2 = dx * dx + dy * dy;
            if (dist2 > nearestDist2) continue;

            nearestDist2 = dist2;
            nearestIndex = pointIndex;
            nearestX = px;
            nearestY = py;
          }
        }
      }

      if (nearestIndex < 0) return null;
      const pointId = pointSpatialIndex.ids ? Number(pointSpatialIndex.ids[nearestIndex]) : null;
      return {
        index: nearestIndex,
        id: pointId,
        coordinate: [x, y],
        pointCoordinate: [nearestX, nearestY],
      };
    },
    [pointSpatialIndex]
  );

  const emitPointHover = useCallback(
    (hit: PointHitEvent | null, coordinate: DrawCoordinate | null) => {
      if (!onPointHover) return;
      const nextIndex = hit?.index ?? null;
      const nextId = hit?.id ?? null;
      if (hoveredPointIndexRef.current === nextIndex && hoveredPointIdRef.current === nextId) return;
      hoveredPointIndexRef.current = nextIndex;
      hoveredPointIdRef.current = nextId;
      onPointHover({
        index: nextIndex,
        id: nextId,
        coordinate,
        pointCoordinate: hit?.pointCoordinate ?? null,
      });
    },
    [onPointHover]
  );

  const emitPointClick = useCallback(
    (coordinate: DrawCoordinate, button: number) => {
      if (!onPointClick) return;
      const hit = getCellByCoordinates(coordinate);
      if (!hit) return;
      onPointClick({
        ...hit,
        button,
      });
    },
    [onPointClick, getCellByCoordinates]
  );

  useEffect(() => {
    if (!getCellByCoordinatesRef) return;
    getCellByCoordinatesRef.current = getCellByCoordinates;
    return () => {
      if (getCellByCoordinatesRef.current === getCellByCoordinates) {
        getCellByCoordinatesRef.current = null;
      }
    };
  }, [getCellByCoordinatesRef, getCellByCoordinates]);

  useEffect(() => {
    if (!isActiveRegionControlled) return;
    setUncontrolledActiveRegionId(controlledActiveRegionId ?? null);
  }, [isActiveRegionControlled, controlledActiveRegionId]);

  const commitActiveRegion = useCallback(
    (next: string | number | null) => {
      if (String(activeRegionId) === String(next)) return;
      if (!isActiveRegionControlled) {
        setUncontrolledActiveRegionId(next);
      }
      onActiveRegionChange?.(next);
    },
    [activeRegionId, isActiveRegionControlled, onActiveRegionChange]
  );

  useEffect(() => {
    onViewStateChangeRef.current = onViewStateChange;
  }, [onViewStateChange]);

  useEffect(() => {
    onStatsRef.current = onStats;
  }, [onStats]);

  useEffect(() => {
    debugOverlayRef.current = debugOverlay;
    if (!debugOverlay) setDebugStats(null);
  }, [debugOverlay]);

  useEffect(() => {
    return () => {
      cancelRegionLabelAutoLiftAnimation();
    };
  }, [cancelRegionLabelAutoLiftAnimation]);

  const handleRendererStats = useCallback((stats: WsiRenderStats): void => {
    onStatsRef.current?.(stats);
    if (debugOverlayRef.current) {
      setDebugStats(stats);
    }
  }, []);

  const debugOverlayText = useMemo(() => {
    if (!debugStats) {
      return "stats: waiting for first frame...";
    }
    return [
      `tier ${debugStats.tier} | frame ${debugStats.frameMs?.toFixed(2) ?? "-"} ms | drawCalls ${debugStats.drawCalls ?? "-"}`,
      `tiles visible ${debugStats.visible} | rendered ${debugStats.rendered} | fallback ${debugStats.fallback}`,
      `cache size ${debugStats.cache} | hit ${debugStats.cacheHits ?? "-"} | miss ${debugStats.cacheMisses ?? "-"}`,
      `queue inflight ${debugStats.inflight} | queued ${debugStats.queued ?? "-"} | retries ${debugStats.retries ?? "-"} | failed ${debugStats.failed ?? "-"} | aborted ${debugStats.aborted ?? "-"}`,
      `points ${debugStats.points}`,
    ].join("\n");
  }, [debugStats]);

  useEffect(() => {
    const hasActive = activeRegionId === null ? true : effectiveRoiRegions.some((region, index) => String(resolveRegionId(region, index)) === String(activeRegionId));
    if (!hasActive && activeRegionId !== null) {
      commitActiveRegion(null);
    }

    const currentHover = hoveredRegionIdRef.current;
    const hasHover = currentHover === null ? true : effectiveRoiRegions.some((region, index) => String(resolveRegionId(region, index)) === String(currentHover));

    if (!hasHover && currentHover !== null) {
      hoveredRegionIdRef.current = null;
      setHoveredRegionId(null);
      onRegionHover?.({
        region: null,
        regionId: null,
        regionIndex: -1,
        coordinate: null,
      });
    }
  }, [effectiveRoiRegions, activeRegionId, onRegionHover, commitActiveRegion]);

  useEffect(() => {
    const hoveredPointIndex = hoveredPointIndexRef.current;
    if (hoveredPointIndex === null) return;
    if (pointSpatialIndex && hoveredPointIndex < pointSpatialIndex.safeCount) return;
    hoveredPointIndexRef.current = null;
    hoveredPointIdRef.current = null;
    onPointHover?.({
      index: null,
      id: null,
      coordinate: null,
      pointCoordinate: null,
    });
  }, [pointSpatialIndex, onPointHover]);

  const emitViewStateChange = useCallback(
    (next: WsiViewState): void => {
      syncRegionLabelAutoLiftTarget(next.zoom);
      if (shouldTrackCustomLayerViewState) {
        setCustomLayerViewState(next);
      }
      const callback = onViewStateChangeRef.current;
      if (callback) {
        callback(next);
      }
      drawInvalidateRef.current?.();
      overviewInvalidateRef.current?.();
    },
    [shouldTrackCustomLayerViewState, syncRegionLabelAutoLiftTarget]
  );

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    syncRegionLabelAutoLiftTarget(renderer.getViewState().zoom);
  }, [syncRegionLabelAutoLiftTarget, minZoom, maxZoom]);

  useEffect(() => {
    if (drawTool === "cursor") return;
    if (hoveredRegionIdRef.current === null) return;
    hoveredRegionIdRef.current = null;
    setHoveredRegionId(null);
    onRegionHover?.({
      region: null,
      regionId: null,
      regionIndex: -1,
      coordinate: null,
    });
  }, [drawTool, onRegionHover]);

  useEffect(() => {
    if (drawTool === "cursor") return;
    if (hoveredPointIndexRef.current === null) return;
    hoveredPointIndexRef.current = null;
    hoveredPointIdRef.current = null;
    onPointHover?.({
      index: null,
      id: null,
      coordinate: null,
      pointCoordinate: null,
    });
  }, [drawTool, onPointHover]);

  const resolveWorldCoord = useCallback((clientX: number, clientY: number): DrawCoordinate | null => {
    const renderer = rendererRef.current;
    if (!renderer) return null;
    const raw = renderer.screenToWorld(clientX, clientY);
    if (!Array.isArray(raw) || raw.length < 2) return null;
    const x = Number(raw[0]);
    const y = Number(raw[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [x, y];
  }, []);

  const resolveScreenCoord = useCallback((worldX: number, worldY: number): DrawCoordinate | null => {
    const renderer = rendererRef.current;
    if (!renderer) return null;
    const raw = renderer.worldToScreen(worldX, worldY);
    return toDrawCoordinate(raw);
  }, []);

  const resolveCanvasPointerSnapshot = useCallback((clientX: number, clientY: number): { screenCoord: DrawCoordinate; canvasWidth: number; canvasHeight: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;
    if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
      return null;
    }
    return {
      screenCoord: [screenX, screenY],
      canvasWidth: Math.max(1, rect.width),
      canvasHeight: Math.max(1, rect.height),
    };
  }, []);

  const pickRegionHit = useCallback(
    (coord: DrawCoordinate, screenCoord: DrawCoordinate, canvasWidth: number, canvasHeight: number) => {
      const renderer = rendererRef.current;
      if (!renderer) return null;
      return pickPreparedRegionAt(coord, screenCoord, preparedRegionHits, renderer, resolvedRegionLabelStyle, resolveRegionLabelStyleProp, regionLabelAutoLiftOffsetPx, canvasWidth, canvasHeight);
    },
    [preparedRegionHits, resolvedRegionLabelStyle, resolveRegionLabelStyleProp, regionLabelAutoLiftOffsetPx]
  );

  const requestCustomLayerRedraw = useCallback(() => {
    rendererRef.current?.requestRender();
    drawInvalidateRef.current?.();
    overviewInvalidateRef.current?.();
  }, []);

  const effectiveCustomLayerViewState = useMemo<WsiViewState | null>(() => {
    return customLayerViewState ?? rendererRef.current?.getViewState() ?? null;
  }, [customLayerViewState]);

  const customLayerContext = useMemo<WsiCustomLayerContext | null>(() => {
    if (!source) return null;
    const viewStateForLayer = effectiveCustomLayerViewState;
    if (!viewStateForLayer) return null;
    return {
      source,
      viewState: viewStateForLayer,
      drawTool,
      interactionLock,
      worldToScreen: resolveScreenCoord,
      screenToWorld: resolveWorldCoord,
      requestRedraw: requestCustomLayerRedraw,
    };
  }, [source, effectiveCustomLayerViewState, drawTool, interactionLock, resolveScreenCoord, resolveWorldCoord, requestCustomLayerRedraw]);

  const handleRegionPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const isCanvasEvent = event.target === canvasRef.current;
      const coord = resolveWorldCoord(event.clientX, event.clientY);
      if (onPointerWorldMove) {
        const insideImage = !!coord && coord[0] >= 0 && coord[1] >= 0 && !!source && coord[0] <= source.width && coord[1] <= source.height;
        onPointerWorldMove({
          coordinate: coord,
          clientX: event.clientX,
          clientY: event.clientY,
          insideImage,
        });
      }

      if (drawTool !== "cursor") return;
      if (!isCanvasEvent) {
        emitPointHover(null, null);
        if (hoveredRegionIdRef.current !== null) {
          hoveredRegionIdRef.current = null;
          setHoveredRegionId(null);
          onRegionHover?.({
            region: null,
            regionId: null,
            regionIndex: -1,
            coordinate: null,
          });
        }
        return;
      }
      if (!coord) {
        emitPointHover(null, null);
        return;
      }

      if (onPointHover) {
        emitPointHover(getCellByCoordinates(coord), coord);
      }
      if (!preparedRegionHits.length) return;

      const pointerSnapshot = resolveCanvasPointerSnapshot(event.clientX, event.clientY);
      if (!pointerSnapshot) return;

      const hit = pickRegionHit(coord, pointerSnapshot.screenCoord, pointerSnapshot.canvasWidth, pointerSnapshot.canvasHeight);
      const nextHoverId = hit?.regionId ?? null;
      const prevHoverId = hoveredRegionIdRef.current;
      if (String(prevHoverId) === String(nextHoverId)) return;

      hoveredRegionIdRef.current = nextHoverId;
      setHoveredRegionId(nextHoverId);
      onRegionHover?.({
        region: hit?.region ?? null,
        regionId: nextHoverId,
        regionIndex: hit?.regionIndex ?? -1,
        coordinate: coord,
      });
    },
    [drawTool, preparedRegionHits, resolveWorldCoord, onRegionHover, onPointerWorldMove, source, emitPointHover, getCellByCoordinates, onPointHover, resolveCanvasPointerSnapshot, pickRegionHit]
  );

  const handleRegionPointerLeave = useCallback(() => {
    onPointerWorldMove?.({
      coordinate: null,
      clientX: -1,
      clientY: -1,
      insideImage: false,
    });
    emitPointHover(null, null);
    if (hoveredRegionIdRef.current === null) return;
    hoveredRegionIdRef.current = null;
    setHoveredRegionId(null);
    onRegionHover?.({
      region: null,
      regionId: null,
      regionIndex: -1,
      coordinate: null,
    });
  }, [onRegionHover, onPointerWorldMove, emitPointHover]);

  const handleRegionClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (drawTool !== "cursor") return;
      if (event.target !== canvasRef.current) return;

      const coord = resolveWorldCoord(event.clientX, event.clientY);
      if (!coord) return;
      emitPointClick(coord, event.button);

      if (!preparedRegionHits.length) {
        commitActiveRegion(null);
        return;
      }

      const pointerSnapshot = resolveCanvasPointerSnapshot(event.clientX, event.clientY);
      if (!pointerSnapshot) return;

      const hit = pickRegionHit(coord, pointerSnapshot.screenCoord, pointerSnapshot.canvasWidth, pointerSnapshot.canvasHeight);
      if (!hit) {
        commitActiveRegion(null);
        return;
      }

      const nextActive: string | number | null = activeRegionId !== null && String(activeRegionId) === String(hit.regionId) ? null : hit.regionId;
      commitActiveRegion(nextActive);
      onRegionClick?.({
        region: hit.region,
        regionId: hit.regionId,
        regionIndex: hit.regionIndex,
        coordinate: coord,
      });
    },
    [drawTool, preparedRegionHits, resolveWorldCoord, onRegionClick, activeRegionId, commitActiveRegion, emitPointClick, resolveCanvasPointerSnapshot, pickRegionHit]
  );

  const handleBrushTap = useCallback(
    (coord: DrawCoordinate): boolean => {
      if (drawTool !== "brush") return false;
      if (brushOptions?.clickSelectRoi !== true) return false;
      if (!preparedRegionHits.length) return false;

      const renderer = rendererRef.current;
      const canvas = canvasRef.current;
      if (!renderer || !canvas) return false;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;

      const screenCoord = toDrawCoordinate(renderer.worldToScreen(coord[0], coord[1]));
      if (!screenCoord) return false;
      const hit = pickRegionHit(coord, screenCoord, rect.width, rect.height);
      if (!hit) return false;

      const nextActive: string | number | null = activeRegionId !== null && String(activeRegionId) === String(hit.regionId) ? null : hit.regionId;
      commitActiveRegion(nextActive);
      onRegionClick?.({
        region: hit.region,
        regionId: hit.regionId,
        regionIndex: hit.regionIndex,
        coordinate: coord,
      });
      return true;
    },
    [drawTool, brushOptions?.clickSelectRoi, preparedRegionHits, activeRegionId, commitActiveRegion, onRegionClick, pickRegionHit]
  );

  const handleRegionContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!onPointClick) return;
      if (drawTool !== "cursor") return;
      if (event.target !== canvasRef.current) return;
      event.preventDefault();
      const coord = resolveWorldCoord(event.clientX, event.clientY);
      if (!coord) return;
      emitPointClick(coord, event.button);
    },
    [drawTool, resolveWorldCoord, emitPointClick, onPointClick]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source) {
      return;
    }

    const renderer = new WsiTileRenderer(canvas, source, {
      onViewStateChange: emitViewStateChange,
      onStats: handleRendererStats,
      onTileError,
      onContextLost,
      onContextRestored,
      authToken,
      imageColorSettings,
      ctrlDragRotate,
      pointSizeByZoom,
      pointStrokeScale,
      minZoom,
      maxZoom,
      viewTransition,
    });

    rendererRef.current = renderer;
    if (viewState) {
      renderer.setViewState(viewState);
    }
    syncRegionLabelAutoLiftTarget(renderer.getViewState().zoom);
    renderer.setInteractionLock(interactionLock);
    if (shouldTrackCustomLayerViewState) {
      setCustomLayerViewState(renderer.getViewState());
    }

    return () => {
      cancelRegionLabelAutoLiftAnimation();
      applyRegionLabelAutoLiftOffset(0);
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [
    source,
    handleRendererStats,
    onTileError,
    onContextLost,
    onContextRestored,
    authToken,
    ctrlDragRotate,
    pointSizeByZoom,
    pointStrokeScale,
    emitViewStateChange,
    shouldTrackCustomLayerViewState,
    syncRegionLabelAutoLiftTarget,
    cancelRegionLabelAutoLiftAnimation,
    applyRegionLabelAutoLiftOffset,
  ]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !viewState) {
      return;
    }
    renderer.setViewState(viewState);
  }, [viewState]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }
    renderer.fitToImage();
  }, [fitNonce]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.resetRotation();
  }, [rotationResetNonce]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !pointPalette) {
      return;
    }
    renderer.setPointPalette(pointPalette);
  }, [pointPalette]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }
    renderer.setPointSizeByZoom(pointSizeByZoom);
  }, [pointSizeByZoom]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setPointStrokeScale(pointStrokeScale);
  }, [pointStrokeScale]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setZoomRange(minZoom, maxZoom);
    syncRegionLabelAutoLiftTarget(renderer.getViewState().zoom);
  }, [minZoom, maxZoom, syncRegionLabelAutoLiftTarget]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setViewTransition(viewTransition);
  }, [viewTransition]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setImageColorSettings(imageColorSettings);
  }, [imageColorSettings]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }
    renderer.setPointData(renderPointData);
  }, [renderPointData]);

  useEffect(() => {
    if (!onRoiPointGroups) return;
    const sourcePoints = clipPointsToRois ? renderPointData : pointData;
    const stats = computeRoiPointGroups(sourcePoints, effectiveRoiRegions, {
      paletteIndexToTermId: roiPaletteIndexToTermId,
      includeEmptyRegions: true,
    });
    onRoiPointGroups(stats);
  }, [onRoiPointGroups, clipPointsToRois, pointData, renderPointData, effectiveRoiRegions, roiPaletteIndexToTermId]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }
    renderer.setInteractionLock(interactionLock);
  }, [interactionLock]);

  return (
    <div
      className={className}
      style={mergedStyle}
      onPointerMove={handleRegionPointerMove}
      onPointerLeave={handleRegionPointerLeave}
      onClick={handleRegionClick}
      onContextMenu={handleRegionContextMenu}
    >
      <canvas
        ref={canvasRef}
        className="wsi-render-canvas"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1,
          width: "100%",
          height: "100%",
          display: "block",
          touchAction: "none",
          cursor: drawTool === "cursor" && hoveredRegionId !== null ? "pointer" : interactionLock ? "crosshair" : "grab",
        }}
      />
      {source && customLayerContext && Array.isArray(customLayers) && customLayers.length > 0
        ? customLayers.map((layer, index) => (
            <div
              key={layer.id ?? index}
              className={layer.className}
              style={{
                position: "absolute",
                inset: 0,
                zIndex: layer.zIndex ?? 3,
                pointerEvents: layer.pointerEvents ?? "none",
                ...layer.style,
              }}
            >
              {layer.render(customLayerContext)}
            </div>
          ))
        : null}
      {source ? (
        <DrawLayer
          tool={drawTool}
          enabled={drawTool !== "cursor"}
          imageWidth={source.width}
          imageHeight={source.height}
          imageMpp={source.mpp}
          imageZoom={source.maxTierZoom}
          stampOptions={stampOptions}
          brushOptions={brushOptions}
          drawFillColor={drawFillColor}
          projectorRef={rendererRef}
          onBrushTap={handleBrushTap}
          viewStateSignal={viewState}
          persistedRegions={effectiveRoiRegions}
          patchRegions={safePatchRegions}
          regionStrokeStyle={regionStrokeStyle}
          regionStrokeHoverStyle={regionStrokeHoverStyle}
          regionStrokeActiveStyle={regionStrokeActiveStyle}
          patchStrokeStyle={patchStrokeStyle}
          resolveRegionStrokeStyle={resolveRegionStrokeStyle}
          resolveRegionLabelStyle={resolveRegionLabelStyleProp}
          overlayShapes={overlayShapes}
          hoveredRegionId={hoveredRegionId}
          activeRegionId={activeRegionId}
          regionLabelStyle={regionLabelStyle}
          drawAreaTooltip={drawAreaTooltip}
          autoLiftRegionLabelAtMaxZoom={autoLiftRegionLabelAtMaxZoom}
          regionLabelAutoLiftOffsetPx={regionLabelAutoLiftOffsetPx}
          invalidateRef={drawInvalidateRef}
          onDrawComplete={onDrawComplete}
          onPatchComplete={onPatchComplete}
        />
      ) : null}
      {debugOverlay ? (
        <pre data-open-plant-debug-overlay style={mergedDebugOverlayStyle}>
          {debugOverlayText}
        </pre>
      ) : null}
      {source && showOverviewMap && (
        <OverviewMap
          source={source}
          projectorRef={rendererRef}
          authToken={authToken}
          options={overviewMapOptions}
          invalidateRef={overviewInvalidateRef}
          className={overviewMapConfig?.className}
          style={overviewMapConfig?.style}
        />
      )}
    </div>
  );
}
