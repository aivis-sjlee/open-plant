import { type CSSProperties, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef } from "react";
import { buildBrushStrokePolygon } from "../wsi/brush-stroke";
import { calcScaleResolution } from "../wsi/utils";
import { drawBrushCursor, drawBrushStrokePreview, resolveBrushOptions } from "./draw-layer-brush";
import {
  drawAreaTooltipBox,
  drawRegionLabel,
  getTopAnchorFromPolygons,
  mergeRegionLabelStyle,
  resolveDrawAreaTooltipOptions,
  resolveRegionLabelAutoLiftOffsetPx,
  resolveRegionLabelStyle,
} from "./draw-layer-label";
import { drawOverlayShapes } from "./draw-layer-overlay";
import { buildStampCoords, isStampTool, resolveStampOptions } from "./draw-layer-stamp";
import {
  BRUSH_RASTER_DIAMETER_SAMPLES,
  BRUSH_SCREEN_STEP,
  DEFAULT_DRAW_PREVIEW_FILL,
  DEFAULT_PATCH_STROKE_STYLE,
  type DrawLayerProps,
  type DrawRegion,
  type DrawSession,
  type DrawTool,
  EMPTY_DASH,
  EMPTY_REGIONS,
  FREEHAND_MIN_POINTS,
  FREEHAND_SCREEN_STEP,
  MICRONS_PER_MM,
  MIN_AREA_PX,
  MIN_BRUSH_RASTER_STEP,
  type PreparedRenderedRegion,
  REGION_INTERACTION_SHADOW_COLOR,
  REGION_INTERACTION_SHADOW_WIDTH,
  type StampDrawTool,
  WHEEL_ZOOM_IN_FACTOR,
  WHEEL_ZOOM_OUT_FACTOR,
} from "./draw-layer-types";
import {
  clamp,
  clampWorld,
  closeRing,
  computeBounds,
  createCircle,
  createRectangle,
  drawPath,
  isSameRegionId,
  mergeStrokeStyle,
  normalizeDrawRegionPolygons,
  polygonArea,
  resolveStrokeStyle,
  toCoord,
} from "./draw-layer-utils";

export { mergeRegionLabelStyle, resolveRegionLabelAutoLiftOffsetPx, resolveRegionLabelStyle } from "./draw-layer-label";
export type {
  BrushOptions,
  DrawAreaTooltipOptions,
  DrawAreaTooltipStyle,
  DrawBounds,
  DrawCoordinate,
  DrawIntent,
  DrawOverlayCoordinates,
  DrawOverlayInvertedFillStyle,
  DrawOverlayShape,
  DrawProjector,
  DrawRegion,
  DrawRegionCoordinates,
  DrawResult,
  DrawTool,
  PatchDrawResult,
  RegionLabelStyle,
  RegionLabelStyleContext,
  RegionLabelStyleResolver,
  RegionStrokeStyle,
  RegionStrokeStyleResolver,
  RegionStyleContext,
  StampDrawTool,
  StampOptions,
} from "./draw-layer-types";
export { closeRing, createCircle, createRectangle } from "./draw-layer-utils";

function resolveRegionInteractionShadowStyle(strokeStyle: import("./draw-layer-types").RegionStrokeStyle): import("./draw-layer-types").RegionStrokeStyle {
  return {
    color: REGION_INTERACTION_SHADOW_COLOR,
    width: REGION_INTERACTION_SHADOW_WIDTH,
    lineDash: EMPTY_DASH,
    lineJoin: strokeStyle.lineJoin,
    lineCap: strokeStyle.lineCap,
    shadowColor: "rgba(0, 0, 0, 0)",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  };
}

function resolveDrawPreviewFillColor(value: string | undefined): string {
  if (typeof value !== "string") return DEFAULT_DRAW_PREVIEW_FILL;
  const next = value.trim();
  return next.length > 0 ? next : DEFAULT_DRAW_PREVIEW_FILL;
}

function isValidPolygon(coords: import("./draw-layer-types").DrawCoordinate[]): boolean {
  return Array.isArray(coords) && coords.length >= 4 && polygonArea(coords) > MIN_AREA_PX;
}

export function DrawLayer({
  tool,
  imageWidth,
  imageHeight,
  imageMpp,
  imageZoom,
  stampOptions,
  brushOptions,
  projectorRef,
  onBrushTap,
  onDrawComplete,
  onPatchComplete,
  enabled,
  viewStateSignal,
  persistedRegions,
  patchRegions,
  persistedPolygons,
  drawFillColor,
  regionStrokeStyle,
  regionStrokeHoverStyle,
  regionStrokeActiveStyle,
  patchStrokeStyle,
  resolveRegionStrokeStyle,
  resolveRegionLabelStyle: resolveRegionLabelStyleProp,
  overlayShapes,
  hoveredRegionId = null,
  activeRegionId = null,
  regionLabelStyle,
  drawAreaTooltip,
  autoLiftRegionLabelAtMaxZoom = false,
  regionLabelAutoLiftOffsetPx,
  invalidateRef,
  className,
  style,
}: DrawLayerProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawPendingRef = useRef(false);
  const overlayDebugSnapshotRef = useRef<Map<string, string>>(new Map());
  const lastToolRef = useRef<DrawTool>(tool);
  const sessionRef = useRef<DrawSession>({
    isDrawing: false,
    pointerId: null,
    start: null,
    current: null,
    cursor: null,
    cursorScreen: null,
    points: [],
    screenPoints: [],
    stampCenter: null,
  });

  const active = enabled ?? tool !== "cursor";
  const mergedPersistedRegions = useMemo<DrawRegion[]>(() => {
    if (persistedRegions && persistedRegions.length > 0) {
      return persistedRegions;
    }
    if (!persistedPolygons || persistedPolygons.length === 0) {
      return EMPTY_REGIONS;
    }
    return persistedPolygons.map((coordinates, index) => ({
      id: index,
      coordinates,
    }));
  }, [persistedRegions, persistedPolygons]);
  const mergedPatchRegions = useMemo<DrawRegion[]>(() => patchRegions ?? EMPTY_REGIONS, [patchRegions]);
  const preparedPersistedRegions = useMemo<PreparedRenderedRegion[]>(() => {
    const out: PreparedRenderedRegion[] = [];
    for (let i = 0; i < mergedPersistedRegions.length; i += 1) {
      const region = mergedPersistedRegions[i];
      const polygons = normalizeDrawRegionPolygons(region.coordinates);
      if (polygons.length === 0) continue;
      out.push({
        region,
        regionIndex: i,
        regionKey: region.id ?? i,
        polygons,
      });
    }
    return out;
  }, [mergedPersistedRegions]);
  const preparedPatchRegions = useMemo<PreparedRenderedRegion[]>(() => {
    const out: PreparedRenderedRegion[] = [];
    for (let i = 0; i < mergedPatchRegions.length; i += 1) {
      const region = mergedPatchRegions[i];
      const polygons = normalizeDrawRegionPolygons(region.coordinates);
      if (polygons.length === 0) continue;
      out.push({
        region,
        regionIndex: i,
        regionKey: region.id ?? i,
        polygons,
      });
    }
    return out;
  }, [mergedPatchRegions]);

  const resolvedStrokeStyle = useMemo(() => resolveStrokeStyle(regionStrokeStyle), [regionStrokeStyle]);
  const resolvedHoverStrokeStyle = useMemo(() => mergeStrokeStyle(resolvedStrokeStyle, regionStrokeHoverStyle), [resolvedStrokeStyle, regionStrokeHoverStyle]);
  const resolvedActiveStrokeStyle = useMemo(() => mergeStrokeStyle(resolvedStrokeStyle, regionStrokeActiveStyle), [resolvedStrokeStyle, regionStrokeActiveStyle]);
  const resolvedPatchStrokeStyle = useMemo(() => mergeStrokeStyle(DEFAULT_PATCH_STROKE_STYLE, patchStrokeStyle), [patchStrokeStyle]);
  const resolvedDrawPreviewFillColor = useMemo(() => resolveDrawPreviewFillColor(drawFillColor), [drawFillColor]);

  const resolvedLabelStyle = useMemo(() => resolveRegionLabelStyle(regionLabelStyle), [regionLabelStyle]);
  const resolvedDrawAreaTooltipOptions = useMemo(() => resolveDrawAreaTooltipOptions(drawAreaTooltip), [drawAreaTooltip]);
  const resolvedStampOptions = useMemo(() => resolveStampOptions(stampOptions), [stampOptions]);
  const resolvedBrushOptions = useMemo(() => resolveBrushOptions(brushOptions), [brushOptions]);

  const mergedStyle = useMemo<CSSProperties>(
    () => ({
      position: "absolute",
      inset: 0,
      zIndex: 2,
      width: "100%",
      height: "100%",
      display: "block",
      touchAction: "none",
      pointerEvents: active ? "auto" : "none",
      cursor: active ? (tool === "brush" ? "none" : "crosshair") : "default",
      ...style,
    }),
    [active, tool, style]
  );

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }, []);

  const worldToScreenPoints = useCallback(
    (points: import("./draw-layer-types").DrawCoordinate[]): import("./draw-layer-types").DrawCoordinate[] => {
      const projector = projectorRef.current;
      if (!projector || points.length === 0) return [];

      const out = new Array<import("./draw-layer-types").DrawCoordinate>(points.length);
      for (let i = 0; i < points.length; i += 1) {
        const coord = toCoord(projector.worldToScreen(points[i][0], points[i][1]));
        if (!coord) return [];
        out[i] = coord;
      }
      return out;
    },
    [projectorRef]
  );

  const localScreenToWorld = useCallback(
    (screen: import("./draw-layer-types").DrawCoordinate): import("./draw-layer-types").DrawCoordinate | null => {
      const projector = projectorRef.current;
      const canvas = canvasRef.current;
      if (!projector || !canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const raw = toCoord(projector.screenToWorld(rect.left + screen[0], rect.top + screen[1]));
      if (!raw) return null;
      return clampWorld(raw, imageWidth, imageHeight);
    },
    [projectorRef, imageWidth, imageHeight]
  );

  const getRectangleProjection = useCallback(() => {
    const projector = projectorRef.current;
    const rotationDeg = projector?.getViewState?.().rotationDeg ?? 0;
    if (Math.abs(rotationDeg % 360) < 0.01 || !projector) return undefined;

    return {
      worldToScreen: (x: number, y: number): import("./draw-layer-types").DrawCoordinate | null => toCoord(projector.worldToScreen(x, y)),
      screenToWorld: localScreenToWorld,
    };
  }, [projectorRef, localScreenToWorld]);

  const micronsToWorldPixels = useCallback(
    (lengthUm: number): number => {
      if (!Number.isFinite(lengthUm) || lengthUm <= 0) return 0;

      const mppValue = typeof imageMpp === "number" && Number.isFinite(imageMpp) && imageMpp > 0 ? imageMpp : 1;
      const imageZoomValue = typeof imageZoom === "number" && Number.isFinite(imageZoom) ? imageZoom : 0;
      const viewZoomRaw = projectorRef.current?.getViewState?.().zoom;
      const viewZoom = typeof viewZoomRaw === "number" && Number.isFinite(viewZoomRaw) && viewZoomRaw > 0 ? viewZoomRaw : 1;
      const continuousZoom = imageZoomValue + Math.log2(viewZoom);
      const umPerScreenPixel = Math.max(1e-9, calcScaleResolution(mppValue, imageZoomValue, continuousZoom));
      const screenPixels = lengthUm / umPerScreenPixel;
      return screenPixels / viewZoom;
    },
    [imageMpp, imageZoom, projectorRef]
  );

  const buildStampCoordsCallback = useCallback(
    (stampTool: StampDrawTool, center: import("./draw-layer-types").DrawCoordinate | null): import("./draw-layer-types").DrawCoordinate[] => {
      return buildStampCoords({
        stampTool,
        center,
        resolvedStampOptions,
        imageWidth,
        imageHeight,
        micronsToWorldPixels,
        getRectangleProjection,
      });
    },
    [micronsToWorldPixels, imageWidth, imageHeight, resolvedStampOptions, getRectangleProjection]
  );

  const buildPreviewCoords = useCallback((): import("./draw-layer-types").DrawCoordinate[] => {
    const session = sessionRef.current;
    if (isStampTool(tool)) {
      return buildStampCoordsCallback(tool, session.stampCenter);
    }
    if (tool === "brush") {
      return [];
    }
    if (!session.isDrawing) return [];

    if (tool === "freehand") {
      return session.points;
    }
    if (tool === "rectangle") {
      return createRectangle(session.start, session.current, getRectangleProjection());
    }
    if (tool === "circular") {
      return createCircle(session.start, session.current);
    }

    return [];
  }, [tool, buildStampCoordsCallback, getRectangleProjection]);

  const drawOverlay = useCallback(() => {
    resizeCanvas();

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const canvasWidth = canvas.width / dpr;
    const canvasHeight = canvas.height / dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (preparedPersistedRegions.length > 0) {
      for (const entry of preparedPersistedRegions) {
        const { region, polygons, regionIndex, regionKey } = entry;
        const state: "default" | "hover" | "active" = isSameRegionId(activeRegionId, regionKey) ? "active" : isSameRegionId(hoveredRegionId, regionKey) ? "hover" : "default";
        let strokeStyle = state === "active" ? resolvedActiveStrokeStyle : state === "hover" ? resolvedHoverStrokeStyle : resolvedStrokeStyle;

        if (resolveRegionStrokeStyle) {
          const resolved = resolveRegionStrokeStyle({
            region,
            regionId: regionKey,
            regionIndex,
            state,
          });
          strokeStyle = mergeStrokeStyle(strokeStyle, resolved || undefined);
        }
        const interactionShadowStyle = state === "default" ? null : resolveRegionInteractionShadowStyle(strokeStyle);

        for (const polygon of polygons) {
          const screenOuter = worldToScreenPoints(polygon.outer);
          if (screenOuter.length >= 4) {
            if (interactionShadowStyle) {
              drawPath(ctx, screenOuter, interactionShadowStyle, true, false);
            }
            drawPath(ctx, screenOuter, strokeStyle, true, false);
          }
          for (const hole of polygon.holes) {
            const screenHole = worldToScreenPoints(hole);
            if (screenHole.length >= 4) {
              if (interactionShadowStyle) {
                drawPath(ctx, screenHole, interactionShadowStyle, true, false);
              }
              drawPath(ctx, screenHole, strokeStyle, true, false);
            }
          }
        }
      }
    }

    if (preparedPatchRegions.length > 0) {
      for (const entry of preparedPatchRegions) {
        for (const polygon of entry.polygons) {
          const screenOuter = worldToScreenPoints(polygon.outer);
          if (screenOuter.length >= 4) {
            drawPath(ctx, screenOuter, resolvedPatchStrokeStyle, true, false);
          }
          for (const hole of polygon.holes) {
            const screenHole = worldToScreenPoints(hole);
            if (screenHole.length >= 4) {
              drawPath(ctx, screenHole, resolvedPatchStrokeStyle, true, false);
            }
          }
        }
      }
    }

    if (Array.isArray(overlayShapes) && overlayShapes.length > 0) {
      const imageOuterRing = worldToScreenPoints(
        closeRing([
          [0, 0],
          [imageWidth, 0],
          [imageWidth, imageHeight],
          [0, imageHeight],
        ])
      );
      drawOverlayShapes({
        ctx,
        overlayShapes,
        imageOuterRing,
        worldToScreenPoints,
        baseStrokeStyle: resolvedStrokeStyle,
        onInvertedFillDebug: (globalThis as { __OPEN_PLANT_DEBUG_OVERLAY__?: boolean }).__OPEN_PLANT_DEBUG_OVERLAY__
          ? info => {
              const debugKey = String(info.id);
              const debugSignature = `${info.outerRingPoints}|${info.sourceRingCount}|${info.holeRingCount}|${info.fillColor}`;
              if (overlayDebugSnapshotRef.current.get(debugKey) !== debugSignature) {
                overlayDebugSnapshotRef.current.set(debugKey, debugSignature);
                console.debug("[open-plant] invertedFill", info);
              }
            }
          : undefined,
      });
    }

    const preview = buildPreviewCoords();

    if (active) {
      if (tool === "brush") {
        drawBrushStrokePreview(ctx, sessionRef.current, resolvedBrushOptions);
        drawBrushCursor(ctx, sessionRef.current, projectorRef.current, resolvedBrushOptions);
      } else if (preview.length > 0) {
        if (tool === "freehand") {
          const line = worldToScreenPoints(preview);
          if (line.length >= 2) {
            drawPath(ctx, line, resolvedStrokeStyle, false, false);
          }
          if (line.length >= 3) {
            drawPath(ctx, worldToScreenPoints(closeRing(preview)), resolvedStrokeStyle, true, true, resolvedDrawPreviewFillColor);
          }
        } else {
          const polygon = worldToScreenPoints(preview);
          if (polygon.length >= 4) {
            drawPath(ctx, polygon, resolvedStrokeStyle, true, true, resolvedDrawPreviewFillColor);
          }
        }
      }
    }

    if (preparedPersistedRegions.length > 0) {
      const zoom = Math.max(1e-6, projectorRef.current?.getViewState?.().zoom ?? 1);
      const labelAutoLiftOffset =
        typeof regionLabelAutoLiftOffsetPx === "number" && Number.isFinite(regionLabelAutoLiftOffsetPx)
          ? Math.max(0, regionLabelAutoLiftOffsetPx)
          : resolveRegionLabelAutoLiftOffsetPx(autoLiftRegionLabelAtMaxZoom, zoom, projectorRef.current?.getZoomRange?.());
      for (const entry of preparedPersistedRegions) {
        if (!entry.region.label) continue;
        const anchorWorld = getTopAnchorFromPolygons(entry.polygons);
        if (!anchorWorld) continue;
        const anchorScreen = toCoord(projectorRef.current?.worldToScreen(anchorWorld[0], anchorWorld[1]) ?? []);
        if (!anchorScreen) continue;
        let dynamicLabelStyle = mergeRegionLabelStyle(
          resolvedLabelStyle,
          resolveRegionLabelStyleProp?.({
            region: entry.region,
            regionId: entry.regionKey,
            regionIndex: entry.regionIndex,
            zoom,
          })
        );
        if (labelAutoLiftOffset > 0) {
          dynamicLabelStyle = {
            ...dynamicLabelStyle,
            offsetY: dynamicLabelStyle.offsetY + labelAutoLiftOffset,
          };
        }
        drawRegionLabel(ctx, entry.region.label, anchorScreen, canvasWidth, canvasHeight, dynamicLabelStyle);
      }
    }

    if (resolvedDrawAreaTooltipOptions.enabled && active && (tool === "freehand" || tool === "rectangle" || tool === "circular")) {
      const session = sessionRef.current;
      if (session.isDrawing) {
        const areaCoords = tool === "freehand" ? closeRing(preview) : preview;
        if (areaCoords.length >= 4) {
          const areaPx = polygonArea(areaCoords);
          const mpp = typeof imageMpp === "number" && Number.isFinite(imageMpp) && imageMpp > 0 ? imageMpp : 0;
          const areaMm2 = mpp > 0 ? (areaPx * mpp * mpp) / (MICRONS_PER_MM * MICRONS_PER_MM) : 0;
          const text = resolvedDrawAreaTooltipOptions.format(areaMm2);

          const cursor = session.cursorScreen ?? (session.current ? toCoord(projectorRef.current?.worldToScreen(session.current[0], session.current[1]) ?? []) : null);
          if (cursor) {
            drawAreaTooltipBox(
              ctx,
              text,
              cursor,
              canvasWidth,
              canvasHeight,
              resolvedDrawAreaTooltipOptions.style,
              resolvedDrawAreaTooltipOptions.cursorOffsetX,
              resolvedDrawAreaTooltipOptions.cursorOffsetY
            );
          }
        }
      }
    }
  }, [
    active,
    tool,
    buildPreviewCoords,
    resizeCanvas,
    worldToScreenPoints,
    imageWidth,
    imageHeight,
    projectorRef,
    preparedPersistedRegions,
    overlayShapes,
    hoveredRegionId,
    activeRegionId,
    resolvedStrokeStyle,
    resolvedHoverStrokeStyle,
    resolvedActiveStrokeStyle,
    resolvedDrawPreviewFillColor,
    preparedPatchRegions,
    resolvedPatchStrokeStyle,
    resolveRegionStrokeStyle,
    resolveRegionLabelStyleProp,
    resolvedLabelStyle,
    resolvedDrawAreaTooltipOptions,
    autoLiftRegionLabelAtMaxZoom,
    regionLabelAutoLiftOffsetPx,
    imageMpp,
    resolvedBrushOptions,
  ]);

  const requestDraw = useCallback(() => {
    if (drawPendingRef.current) return;
    drawPendingRef.current = true;
    requestAnimationFrame(() => {
      drawPendingRef.current = false;
      drawOverlay();
    });
  }, [drawOverlay]);

  const resetSession = useCallback((preserveCursor = false) => {
    const session = sessionRef.current;
    const canvas = canvasRef.current;

    if (canvas && session.pointerId !== null && canvas.hasPointerCapture(session.pointerId)) {
      canvas.releasePointerCapture(session.pointerId);
    }

    session.isDrawing = false;
    session.pointerId = null;
    session.start = null;
    session.current = null;
    session.points = [];
    session.screenPoints = [];
    session.stampCenter = null;
    if (!preserveCursor) {
      session.cursor = null;
      session.cursorScreen = null;
    }
  }, []);

  const toWorld = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): import("./draw-layer-types").DrawCoordinate | null => {
      const projector = projectorRef.current;
      if (!projector || imageWidth <= 0 || imageHeight <= 0) return null;

      const raw = toCoord(projector.screenToWorld(event.clientX, event.clientY));
      if (!raw) return null;
      return clampWorld(raw, imageWidth, imageHeight);
    },
    [projectorRef, imageWidth, imageHeight]
  );

  const toLocalScreen = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): import("./draw-layer-types").DrawCoordinate | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [x, y];
  }, []);

  const finishSession = useCallback(() => {
    const session = sessionRef.current;
    if (!session.isDrawing) {
      resetSession(true);
      requestDraw();
      return;
    }

    let coordinates: import("./draw-layer-types").DrawCoordinate[] = [];
    if (tool === "freehand") {
      if (session.points.length >= FREEHAND_MIN_POINTS) {
        coordinates = closeRing(session.points);
      }
    } else if (tool === "rectangle") {
      coordinates = createRectangle(session.start, session.current, getRectangleProjection());
    } else if (tool === "circular") {
      coordinates = createCircle(session.start, session.current);
    } else if (tool === "brush") {
      const tapPoint = session.points[session.points.length - 1] ?? session.current ?? session.start;
      if (resolvedBrushOptions.clickSelectRoi && tapPoint && session.points.length <= 1 && onBrushTap?.(tapPoint)) {
        resetSession(true);
        requestDraw();
        return;
      }
      const edgeDetail = resolvedBrushOptions.edgeDetail;
      const minRasterStep = Math.max(MIN_BRUSH_RASTER_STEP, (resolvedBrushOptions.radius * 2) / (BRUSH_RASTER_DIAMETER_SAMPLES * edgeDetail));
      const screenPath = session.screenPoints.length > 0 ? session.screenPoints : worldToScreenPoints(session.points);
      const screenPolygon = buildBrushStrokePolygon(screenPath, {
        radius: resolvedBrushOptions.radius,
        minRasterStep,
        circleSides: Math.max(24, Math.round(64 * edgeDetail)),
        simplifyTolerance: minRasterStep * 0.25,
        smoothingPasses: resolvedBrushOptions.edgeSmoothing,
      }) as import("./draw-layer-types").DrawCoordinate[];
      const worldPolygon: import("./draw-layer-types").DrawCoordinate[] = [];
      for (const point of screenPolygon) {
        const world = localScreenToWorld(point);
        if (!world) continue;
        worldPolygon.push(world);
      }
      coordinates = closeRing(worldPolygon);
    }

    if ((tool === "freehand" || tool === "rectangle" || tool === "circular" || tool === "brush") && isValidPolygon(coordinates) && onDrawComplete) {
      const intent: import("./draw-layer-types").DrawIntent = tool === "brush" ? "brush" : "roi";
      onDrawComplete({
        tool,
        intent,
        coordinates,
        bbox: computeBounds(coordinates),
        areaPx: polygonArea(coordinates),
      });
    }

    resetSession(true);
    requestDraw();
  }, [
    tool,
    onDrawComplete,
    resetSession,
    requestDraw,
    worldToScreenPoints,
    localScreenToWorld,
    getRectangleProjection,
    resolvedBrushOptions.radius,
    resolvedBrushOptions.edgeDetail,
    resolvedBrushOptions.edgeSmoothing,
    resolvedBrushOptions.clickSelectRoi,
    onBrushTap,
  ]);

  const handleStampAt = useCallback(
    (stampTool: StampDrawTool, center: import("./draw-layer-types").DrawCoordinate): void => {
      const coordinates = buildStampCoordsCallback(stampTool, center);
      if (!isValidPolygon(coordinates)) return;
      const intent: import("./draw-layer-types").DrawIntent = stampTool === "stamp-rectangle-4096px" ? "patch" : "roi";
      const result: import("./draw-layer-types").DrawResult = {
        tool: stampTool,
        intent,
        coordinates,
        bbox: computeBounds(coordinates),
        areaPx: polygonArea(coordinates),
      };
      onDrawComplete?.(result);
      if (intent === "patch" && onPatchComplete) {
        onPatchComplete(result as import("./draw-layer-types").PatchDrawResult);
      }
    },
    [buildStampCoordsCallback, onDrawComplete, onPatchComplete]
  );

  const appendBrushPoint = useCallback((session: DrawSession, world: import("./draw-layer-types").DrawCoordinate, screen: import("./draw-layer-types").DrawCoordinate): void => {
    const minScreenStep2 = BRUSH_SCREEN_STEP * BRUSH_SCREEN_STEP;
    const prevScreen = session.screenPoints[session.screenPoints.length - 1];
    if (!prevScreen) {
      session.points.push(world);
      session.screenPoints.push(screen);
      session.current = world;
      return;
    }
    const dx = screen[0] - prevScreen[0];
    const dy = screen[1] - prevScreen[1];
    if (dx * dx + dy * dy >= minScreenStep2) {
      session.points.push(world);
      session.screenPoints.push(screen);
    } else {
      session.points[session.points.length - 1] = world;
      session.screenPoints[session.screenPoints.length - 1] = screen;
    }
    session.current = world;
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!active) return;
      if (tool === "cursor") return;
      if (event.button !== 0) return;

      const world = toWorld(event);
      if (!world) return;
      const screen = toLocalScreen(event);
      if (!screen) return;

      event.preventDefault();
      event.stopPropagation();

      if (isStampTool(tool)) {
        const session = sessionRef.current;
        session.stampCenter = world;
        handleStampAt(tool, world);
        requestDraw();
        return;
      }

      const canvas = canvasRef.current;
      if (canvas) {
        canvas.setPointerCapture(event.pointerId);
      }

      const session = sessionRef.current;
      session.isDrawing = true;
      session.pointerId = event.pointerId;
      session.start = world;
      session.current = world;
      session.cursor = world;
      session.cursorScreen = screen;
      session.points = tool === "freehand" || tool === "brush" ? [world] : [];
      session.screenPoints = tool === "brush" ? [screen] : [];
      requestDraw();
    },
    [active, tool, toWorld, toLocalScreen, handleStampAt, requestDraw]
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!active) return;
      if (tool === "cursor") return;

      const world = toWorld(event);
      if (!world) return;
      const screen = toLocalScreen(event);
      if (!screen) return;

      const session = sessionRef.current;
      session.cursor = world;
      session.cursorScreen = screen;

      if (isStampTool(tool)) {
        session.stampCenter = world;
        event.preventDefault();
        event.stopPropagation();
        requestDraw();
        return;
      }

      if (tool === "brush") {
        if (!session.isDrawing || session.pointerId !== event.pointerId) {
          requestDraw();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        appendBrushPoint(session, world, screen);
        requestDraw();
        return;
      }

      if (!session.isDrawing || session.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      if (tool === "freehand") {
        const projector = projectorRef.current;
        const zoom = Math.max(1e-6, projector?.getViewState?.().zoom ?? 1);
        const minWorldStep = FREEHAND_SCREEN_STEP / zoom;
        const minWorldStep2 = minWorldStep * minWorldStep;
        const prev = session.points[session.points.length - 1];

        if (!prev) {
          session.points.push(world);
        } else {
          const dx = world[0] - prev[0];
          const dy = world[1] - prev[1];
          if (dx * dx + dy * dy >= minWorldStep2) {
            session.points.push(world);
          }
        }
      } else {
        session.current = world;
      }

      requestDraw();
    },
    [active, tool, toWorld, toLocalScreen, requestDraw, projectorRef, appendBrushPoint]
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const session = sessionRef.current;
      if (!session.isDrawing || session.pointerId !== event.pointerId) return;

      event.preventDefault();
      event.stopPropagation();
      const world = toWorld(event);
      const screen = toLocalScreen(event);
      if (world) {
        session.cursor = world;
        if (screen) {
          session.cursorScreen = screen;
        }
        if (tool === "brush") {
          if (screen) {
            appendBrushPoint(session, world, screen);
          }
        } else {
          session.current = world;
        }
      }
      const canvas = canvasRef.current;
      if (canvas && canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }

      finishSession();
    },
    [finishSession, toWorld, toLocalScreen, tool, appendBrushPoint]
  );

  const handlePointerLeave = useCallback(() => {
    const session = sessionRef.current;
    let changed = false;
    if (tool === "brush" && !session.isDrawing && session.cursor) {
      session.cursor = null;
      session.cursorScreen = null;
      changed = true;
    }
    if (isStampTool(tool) && session.stampCenter) {
      session.stampCenter = null;
      changed = true;
    }
    if (changed) {
      requestDraw();
    }
  }, [tool, requestDraw]);

  useEffect(() => {
    resizeCanvas();
    requestDraw();

    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const observer = new ResizeObserver(() => {
      resizeCanvas();
      requestDraw();
    });
    observer.observe(canvas);

    return () => {
      observer.disconnect();
    };
  }, [resizeCanvas, requestDraw]);

  useEffect(() => {
    if (!active) {
      resetSession();
    }
    requestDraw();
  }, [active, requestDraw, resetSession]);

  useEffect(() => {
    if (lastToolRef.current === tool) {
      return;
    }
    lastToolRef.current = tool;
    resetSession();
    requestDraw();
  }, [tool, resetSession, requestDraw]);

  useEffect(() => {
    requestDraw();
  }, [viewStateSignal, mergedPersistedRegions, overlayShapes, requestDraw]);

  useEffect(() => {
    if (!invalidateRef) return undefined;
    invalidateRef.current = requestDraw;
    return () => {
      if (invalidateRef.current === requestDraw) {
        invalidateRef.current = null;
      }
    };
  }, [invalidateRef, requestDraw]);

  useEffect(() => {
    if (!active) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      resetSession();
      requestDraw();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [active, resetSession, requestDraw]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={mergedStyle}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onContextMenu={event => {
        if (active) event.preventDefault();
      }}
      onWheel={event => {
        if (!active) return;
        const canvas = canvasRef.current;
        const projector = projectorRef.current;
        if (!canvas || typeof projector?.zoomBy !== "function") return;
        event.preventDefault();
        event.stopPropagation();
        const rect = canvas.getBoundingClientRect();
        const screenX = event.clientX - rect.left;
        const screenY = event.clientY - rect.top;
        projector.zoomBy(event.deltaY < 0 ? WHEEL_ZOOM_IN_FACTOR : WHEEL_ZOOM_OUT_FACTOR, screenX, screenY);
        requestDraw();
      }}
    />
  );
}
