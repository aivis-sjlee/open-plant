import { OrthoCamera } from "../core/ortho-camera";
import { TileScheduler } from "./tile-scheduler";
import type { WsiImageColorSettings, WsiImageSource, WsiPointData, WsiRenderStats, WsiViewState } from "./types";
import { clamp, isSameViewState, nowMs } from "./utils";
import { addRendererCanvasEventListeners, type RendererCanvasHandlers, removeRendererCanvasEventListeners, resizeCanvasViewport } from "./wsi-canvas-lifecycle";
import { cancelDrag as cancelInputDrag, createRendererInputHandlers } from "./wsi-input-handlers";
import { destroyRenderer, handleContextLost } from "./wsi-lifecycle-ops";
import {
  arePointSizeStopsEqual,
  clonePointSizeStops,
  DEFAULT_POINT_SIZE_STOPS,
  DEFAULT_ROTATION_DRAG_SENSITIVITY,
  linearEasing,
  MAX_POINT_SIZE_PX,
  MIN_POINT_SIZE_PX,
  normalizePointInnerFillOpacity,
  normalizePointSizeStops,
  normalizeStrokeScale,
  normalizeTransitionEasing,
  normalizeViewTransitionDuration,
  normalizeZoomOverride,
  resolvePointSizeByZoomStops,
  toNormalizedImageColorSettings,
} from "./wsi-normalize";
import type { PointBufferRuntime } from "./wsi-point-data";
import { setPointData as setManagedPointData, setPointPalette as setManagedPointPalette } from "./wsi-point-data";
import { renderFrame } from "./wsi-render-pass";
import type {
  Bounds,
  CachedTile,
  InteractionState,
  NormalizedImageColorSettings,
  PointProgram,
  PointSizeByZoom,
  PointSizeStop,
  TileVertexProgram,
  ViewAnimationRuntimeState,
  WorldPoint,
  WsiTileErrorEvent,
  WsiTileRendererOptions,
  WsiViewTransitionOptions,
  ZoomSnapState,
} from "./wsi-renderer-types";
import { initPointProgram, initTileProgram } from "./wsi-shaders";
import { handleTileLoaded as cacheTileLoaded } from "./wsi-tile-cache";
import {
  clampViewState as clampManagedViewState,
  getViewBounds as getManagedViewBounds,
  getVisibleTiles as getManagedVisibleTiles,
  getVisibleTilesForTier as getManagedVisibleTilesForTier,
  intersectsBounds as intersectsManagedBounds,
} from "./wsi-tile-visibility";
import { cancelViewAnimation as cancelManagedViewAnimation, startViewAnimation } from "./wsi-view-animation";
import { computeFitToImageTarget, computeZoomByTarget, computeZoomToTarget, resolveTargetViewState as resolveManagedTargetViewState, resolveZoomBounds } from "./wsi-view-ops";
import { normalizeZoomSnaps, resolveSnapTarget, SNAP_ZOOM_DURATION_MS, startZoomPivotAnimation, type ZoomPivotAnimationContext } from "./wsi-zoom-snap";

export type { PointSizeByZoom, WsiTileErrorEvent, WsiTileRendererOptions, WsiTileSchedulerConfig, WsiViewTransitionOptions } from "./wsi-renderer-types";

export class WsiTileRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly source: WsiImageSource;
  private readonly gl: WebGL2RenderingContext;
  private readonly camera = new OrthoCamera();
  private readonly onViewStateChange?: (next: WsiViewState) => void;
  private readonly onStats?: (stats: WsiRenderStats) => void;
  private readonly onTileError?: (event: WsiTileErrorEvent) => void;
  private readonly onContextLost?: () => void;
  private readonly onContextRestored?: () => void;
  private readonly resizeObserver: ResizeObserver;
  private tileProgram: TileVertexProgram;
  private pointProgram: PointProgram;
  private readonly tileScheduler: TileScheduler;

  private zoomStack: { cnt: number; direction: "in" | "out" | null } = {
    cnt: 0,
    direction: null,
  };

  private authToken: string;
  private destroyed = false;
  private contextLost = false;
  private frame: number | null = null;
  private frameSerial = 0;
  private interactionState: InteractionState = {
    dragging: false,
    mode: "none",
    rotateLastAngleRad: null,
    pointerId: null,
    lastPointerX: 0,
    lastPointerY: 0,
  };
  private interactionLocked = false;
  private ctrlDragRotate = true;
  private rotationDragSensitivityDegPerPixel = DEFAULT_ROTATION_DRAG_SENSITIVITY;
  private maxCacheTiles: number;
  private fitZoom = 1;
  private minZoom = 1e-6;
  private maxZoom = 1;
  private minZoomOverride: number | null = null;
  private maxZoomOverride: number | null = null;
  private viewTransitionDurationMs = 0;
  private viewTransitionEasing: (t: number) => number = linearEasing;
  private viewAnimationState: ViewAnimationRuntimeState = {
    animation: null,
    frame: null,
  };
  private pointCount = 0;
  private usePointIndices = false;
  private pointBuffersDirty = true;
  private pointPaletteSize = 1;
  private pointSizeStops: PointSizeStop[] = clonePointSizeStops(DEFAULT_POINT_SIZE_STOPS);
  private pointStrokeScale = 1.0;
  private pointInnerFillOpacity = 0;
  private imageColorSettings: NormalizedImageColorSettings = {
    brightness: 0,
    contrast: 0,
    saturation: 0,
  };
  private lastPointData: WsiPointData | null = null;
  private lastPointPalette: Uint8Array<ArrayBufferLike> | null = null;
  private zeroFillModes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private cache = new Map<string, CachedTile>();
  private zoomSnaps: number[] = [];
  private zoomSnapFitAsMin = false;
  private zoomSnapState: ZoomSnapState = { accumulatedDelta: 0, lastSnapTimeMs: 0 };

  private readonly boundPointerDown: (event: PointerEvent) => void;
  private readonly boundPointerMove: (event: PointerEvent) => void;
  private readonly boundPointerUp: (event: PointerEvent) => void;
  private readonly boundWheel: (event: WheelEvent) => void;
  private readonly boundDoubleClick: (event: MouseEvent) => void;
  private readonly boundContextMenu: (event: MouseEvent) => void;
  private readonly boundContextLost: (event: Event) => void;
  private readonly boundContextRestored: (event: Event) => void;

  private getCanvasHandlers(): RendererCanvasHandlers {
    return {
      pointerDown: this.boundPointerDown,
      pointerMove: this.boundPointerMove,
      pointerUp: this.boundPointerUp,
      wheel: this.boundWheel,
      doubleClick: this.boundDoubleClick,
      contextMenu: this.boundContextMenu,
      contextLost: this.boundContextLost,
      contextRestored: this.boundContextRestored,
    };
  }

  constructor(canvas: HTMLCanvasElement, source: WsiImageSource, options: WsiTileRendererOptions = {}) {
    this.canvas = canvas;
    this.source = source;
    this.onViewStateChange = options.onViewStateChange;
    this.onStats = options.onStats;
    this.onTileError = options.onTileError;
    this.onContextLost = options.onContextLost;
    this.onContextRestored = options.onContextRestored;
    this.authToken = options.authToken ?? "";
    this.maxCacheTiles = Math.max(32, Math.floor(options.maxCacheTiles ?? 320));
    this.ctrlDragRotate = options.ctrlDragRotate ?? true;
    this.rotationDragSensitivityDegPerPixel =
      typeof options.rotationDragSensitivityDegPerPixel === "number" && Number.isFinite(options.rotationDragSensitivityDegPerPixel)
        ? Math.max(0, options.rotationDragSensitivityDegPerPixel)
        : DEFAULT_ROTATION_DRAG_SENSITIVITY;
    this.pointSizeStops = normalizePointSizeStops(options.pointSizeByZoom);
    this.pointStrokeScale = normalizeStrokeScale(options.pointStrokeScale);
    this.pointInnerFillOpacity = normalizePointInnerFillOpacity(options.pointInnerFillOpacity);
    this.imageColorSettings = toNormalizedImageColorSettings(options.imageColorSettings);
    this.minZoomOverride = normalizeZoomOverride(options.minZoom);
    this.maxZoomOverride = normalizeZoomOverride(options.maxZoom);
    this.viewTransitionDurationMs = normalizeViewTransitionDuration(options.viewTransition?.duration);
    this.viewTransitionEasing = normalizeTransitionEasing(options.viewTransition?.easing);
    this.zoomSnaps = normalizeZoomSnaps(options.zoomSnaps, this.source.mpp);
    this.zoomSnapFitAsMin = Boolean(options.zoomSnapFitAsMin);

    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    });
    if (!gl) {
      throw new Error("WebGL2 not supported");
    }
    this.gl = gl;

    this.tileProgram = initTileProgram(this.gl);
    this.pointProgram = initPointProgram(this.gl);
    this.tileScheduler = new TileScheduler({
      authToken: this.authToken,
      maxConcurrency: options.tileScheduler?.maxConcurrency ?? 12,
      maxRetries: options.tileScheduler?.maxRetries ?? 2,
      retryBaseDelayMs: options.tileScheduler?.retryBaseDelayMs ?? 120,
      retryMaxDelayMs: options.tileScheduler?.retryMaxDelayMs ?? 1200,
      onTileLoad: (tile, bitmap) =>
        cacheTileLoaded({
          gl: this.gl,
          cache: this.cache,
          tile,
          bitmap,
          frameSerial: this.frameSerial,
          maxCacheTiles: this.maxCacheTiles,
          destroyed: this.destroyed,
          contextLost: this.contextLost,
          requestRender: () => this.requestRender(),
        }),
      onTileError: (tile, error, attemptCount) => {
        this.onTileError?.({ tile, error, attemptCount });
        console.warn("tile load failed", tile.url, error);
      },
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);

    const inputHandlers = createRendererInputHandlers({
      canvas: this.canvas,
      state: this.interactionState,
      getInteractionLocked: () => this.interactionLocked,
      getCtrlDragRotate: () => this.ctrlDragRotate,
      getRotationDragSensitivityDegPerPixel: () => this.rotationDragSensitivityDegPerPixel,
      cancelViewAnimation: () => this.cancelViewAnimation(),
      camera: this.camera,
      source: this.source,
      emitViewState: () => this.onViewStateChange?.(this.camera.getViewState()),
      requestRender: () => this.requestRender(),
      zoomBy: (factor, x, y) => this.zoomBy(factor, x, y),
      getUseZoomSnaps: () => this.zoomSnaps.length > 0,
      onSnapZoom: (direction, x, y) => this.handleSnapZoom(direction, x, y),
      zoomSnapState: this.zoomSnapState,
    });
    this.boundPointerDown = inputHandlers.pointerDown;
    this.boundPointerMove = inputHandlers.pointerMove;
    this.boundPointerUp = inputHandlers.pointerUp;
    this.boundWheel = inputHandlers.wheel;
    this.boundDoubleClick = inputHandlers.doubleClick;
    this.boundContextMenu = inputHandlers.contextMenu;
    this.boundContextLost = (event: Event) => this.onWebGlContextLost(event);
    this.boundContextRestored = (event: Event) => this.onWebGlContextRestored(event);

    addRendererCanvasEventListeners(canvas, this.getCanvasHandlers());

    this.fitToImage({ duration: 0 });
    this.resize();
  }

  private applyZoomBounds(): void {
    const bounds = resolveZoomBounds(this.fitZoom, this.minZoomOverride, this.maxZoomOverride);
    this.minZoom = bounds.minZoom;
    this.maxZoom = bounds.maxZoom;
  }

  private resolveTargetViewState(next: Partial<WsiViewState>): WsiViewState {
    return resolveManagedTargetViewState(this.camera, this.minZoom, this.maxZoom, next, () => clampManagedViewState(this.camera, this.source));
  }

  private cancelViewAnimation(): void {
    cancelManagedViewAnimation(this.viewAnimationState);
  }

  private startViewAnimation(target: WsiViewState, durationMs: number, easing: (t: number) => number): void {
    startViewAnimation({
      state: this.viewAnimationState,
      camera: this.camera,
      target,
      durationMs,
      easing,
      onUpdate: () => {
        clampManagedViewState(this.camera, this.source);
        this.onViewStateChange?.(this.camera.getViewState());
        this.requestRender();
      },
    });
  }

  private getPointBufferRuntime(): PointBufferRuntime {
    return {
      pointCount: this.pointCount,
      usePointIndices: this.usePointIndices,
      pointBuffersDirty: this.pointBuffersDirty,
      lastPointData: this.lastPointData,
      zeroFillModes: this.zeroFillModes,
      lastPointPalette: this.lastPointPalette,
      pointPaletteSize: this.pointPaletteSize,
    };
  }

  private applyPointBufferRuntime(runtime: PointBufferRuntime): void {
    this.pointCount = runtime.pointCount;
    this.usePointIndices = runtime.usePointIndices;
    this.pointBuffersDirty = runtime.pointBuffersDirty;
    this.lastPointData = runtime.lastPointData;
    this.zeroFillModes = runtime.zeroFillModes;
    this.lastPointPalette = runtime.lastPointPalette;
    this.pointPaletteSize = runtime.pointPaletteSize;
  }

  private applyViewStateAndRender(next: WsiViewState, cancelAnimation = true): void {
    if (cancelAnimation) {
      this.cancelViewAnimation();
    }
    this.camera.setViewState(next);
    this.onViewStateChange?.(this.camera.getViewState());
    this.requestRender();
  }

  setAuthToken(token: string): void {
    this.authToken = String(token ?? "");
    this.tileScheduler.setAuthToken(this.authToken);
  }

  setZoomRange(minZoom: number | null | undefined, maxZoom: number | null | undefined): void {
    const nextMinOverride = normalizeZoomOverride(minZoom);
    const nextMaxOverride = normalizeZoomOverride(maxZoom);
    if (this.minZoomOverride === nextMinOverride && this.maxZoomOverride === nextMaxOverride) {
      return;
    }

    this.minZoomOverride = nextMinOverride;
    this.maxZoomOverride = nextMaxOverride;
    this.applyZoomBounds();

    const target = this.resolveTargetViewState({});
    const current = this.camera.getViewState();
    if (isSameViewState(current, target)) {
      return;
    }
    this.applyViewStateAndRender(target);
  }

  setViewTransition(options: WsiViewTransitionOptions | null | undefined): void {
    this.viewTransitionDurationMs = normalizeViewTransitionDuration(options?.duration);
    this.viewTransitionEasing = normalizeTransitionEasing(options?.easing);
  }

  setViewState(next: Partial<WsiViewState>, transition?: WsiViewTransitionOptions): void {
    const target = this.resolveTargetViewState(next);
    const current = this.camera.getViewState();
    if (isSameViewState(current, target)) return;

    const durationMs = normalizeViewTransitionDuration(transition?.duration ?? this.viewTransitionDurationMs);
    const easing = normalizeTransitionEasing(transition?.easing ?? this.viewTransitionEasing);
    if (durationMs <= 0) {
      this.applyViewStateAndRender(target);
      return;
    }

    this.startViewAnimation(target, durationMs, easing);
  }

  getViewState(): WsiViewState {
    return this.camera.getViewState();
  }

  getZoomRange(): { minZoom: number; maxZoom: number } {
    return { minZoom: this.minZoom, maxZoom: this.maxZoom };
  }

  isViewAnimating(): boolean {
    return this.viewAnimationState.animation !== null;
  }

  setPointPalette(colors: Uint8Array | null | undefined): void {
    const nextRuntime = setManagedPointPalette(this.getPointBufferRuntime(), this.gl, this.pointProgram, this.contextLost, colors);
    this.applyPointBufferRuntime(nextRuntime);
    if (!colors || colors.length === 0) {
      return;
    }
    this.requestRender();
  }

  setPointData(points: WsiPointData | null | undefined): void {
    const nextRuntime = setManagedPointData(this.getPointBufferRuntime(), this.gl, this.pointProgram, this.contextLost, points);
    this.applyPointBufferRuntime(nextRuntime);
    this.requestRender();
  }

  setInteractionLock(locked: boolean): void {
    const next = Boolean(locked);
    if (this.interactionLocked === next) return;
    this.interactionLocked = next;
    if (next) this.cancelDrag();
  }

  setPointSizeByZoom(pointSizeByZoom: PointSizeByZoom | null | undefined): void {
    const nextStops = normalizePointSizeStops(pointSizeByZoom);
    if (arePointSizeStopsEqual(this.pointSizeStops, nextStops)) return;
    this.pointSizeStops = nextStops;
    this.requestRender();
  }

  setPointStrokeScale(scale: number | null | undefined): void {
    const next = normalizeStrokeScale(scale);
    if (this.pointStrokeScale === next) return;
    this.pointStrokeScale = next;
    this.requestRender();
  }

  setPointInnerFillOpacity(opacity: number | null | undefined): void {
    const next = normalizePointInnerFillOpacity(opacity);
    if (this.pointInnerFillOpacity === next) return;
    this.pointInnerFillOpacity = next;
    this.requestRender();
  }

  setImageColorSettings(settings: WsiImageColorSettings | null | undefined): void {
    const next = toNormalizedImageColorSettings(settings);
    const prev = this.imageColorSettings;
    if (prev.brightness === next.brightness && prev.contrast === next.contrast && prev.saturation === next.saturation) {
      return;
    }
    this.imageColorSettings = next;
    this.requestRender();
  }

  cancelDrag(): void {
    cancelInputDrag(this.canvas, this.interactionState);
  }

  screenToWorld(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return this.camera.screenToWorld(sx, sy);
  }

  worldToScreen(worldX: number, worldY: number): [number, number] {
    return this.camera.worldToScreen(worldX, worldY);
  }

  setViewCenter(worldX: number, worldY: number, transition?: WsiViewTransitionOptions): void {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return;
    const state = this.camera.getViewState();
    const zoom = Math.max(1e-6, state.zoom);
    const vp = this.camera.getViewportSize();
    this.setViewState(
      {
        offsetX: worldX - vp.width / (2 * zoom),
        offsetY: worldY - vp.height / (2 * zoom),
      },
      transition
    );
  }

  getViewCorners(): [WorldPoint, WorldPoint, WorldPoint, WorldPoint] {
    return this.camera.getViewCorners();
  }

  getViewBounds(): Bounds {
    return getManagedViewBounds(this.camera);
  }

  resetRotation(transition?: WsiViewTransitionOptions): void {
    const state = this.camera.getViewState();
    if (Math.abs(state.rotationDeg) < 1e-6) return;
    this.setViewState({ rotationDeg: 0 }, transition);
  }

  getPointSizeByZoom(): number {
    const zoom = Math.max(1e-6, this.camera.getViewState().zoom);
    const continuousZoom = this.source.maxTierZoom + Math.log2(zoom);
    const size = resolvePointSizeByZoomStops(continuousZoom, this.pointSizeStops);
    return clamp(size, MIN_POINT_SIZE_PX, MAX_POINT_SIZE_PX);
  }

  fitToImage(transition?: WsiViewTransitionOptions): void {
    const rect = this.canvas.getBoundingClientRect();
    const vw = Math.max(1, rect.width || 1);
    const vh = Math.max(1, rect.height || 1);
    const fitTarget = computeFitToImageTarget(this.source, vw, vh, this.minZoom, this.maxZoom);
    this.fitZoom = fitTarget.fitZoom;
    this.applyZoomBounds();
    this.setViewState(fitTarget.target, transition);
  }

  zoomBy(factor: number, screenX: number, screenY: number, transition?: WsiViewTransitionOptions): void {
    const target = computeZoomByTarget(this.camera, this.minZoom, this.maxZoom, factor, screenX, screenY);
    if (!target) return;
    this.setViewState(target, transition);
  }

  zoomTo(zoom: number, screenX: number, screenY: number, transition?: WsiViewTransitionOptions): void {
    const target = computeZoomToTarget(this.camera, this.minZoom, this.maxZoom, zoom, screenX, screenY);
    if (!target) return;
    this.setViewState(target, transition);
  }

  setZoomSnaps(magnifications: number[] | null | undefined, fitAsMin?: boolean): void {
    this.zoomSnaps = normalizeZoomSnaps(magnifications, this.source.mpp);
    this.zoomSnapFitAsMin = Boolean(fitAsMin);
  }

  private getZoomPivotAnimationContext(): ZoomPivotAnimationContext {
    return {
      camera: this.camera,
      viewAnimationState: this.viewAnimationState,
      minZoom: this.minZoom,
      maxZoom: this.maxZoom,
      cancelViewAnimation: () => this.cancelViewAnimation(),
      clampViewState: () => clampManagedViewState(this.camera, this.source),
      onViewStateChange: state => this.onViewStateChange?.(state),
      requestRender: () => this.requestRender(),
    };
  }

  private handleSnapZoom(direction: "in" | "out", screenX: number, screenY: number): void {
    const ongoing = this.viewAnimationState.animation;
    const baseZoom = ongoing ? ongoing.to.zoom : this.camera.getViewState().zoom;

    const validSnaps = this.zoomSnaps.filter(z => z >= this.minZoom && z <= this.maxZoom);

    const zoomStack = this.zoomStack;

    if (zoomStack.cnt > 0 && validSnaps.length - 1 === zoomStack.cnt && zoomStack.direction === direction) {
      return;
    }

    if (zoomStack.direction !== direction) {
      zoomStack.cnt = 0;
      zoomStack.direction = direction;
    }

    zoomStack.cnt += 1;

    const result = resolveSnapTarget(validSnaps, baseZoom, direction, this.zoomSnapFitAsMin);
    if (!result) return;

    if (result.type === "fit") {
      const rect = this.canvas.getBoundingClientRect();
      const vw = Math.max(1, rect.width || 1);
      const vh = Math.max(1, rect.height || 1);
      const fitTarget = computeFitToImageTarget(this.source, vw, vh, this.minZoom, this.maxZoom);
      this.fitZoom = fitTarget.fitZoom;
      this.applyZoomBounds();
      startZoomPivotAnimation(this.getZoomPivotAnimationContext(), fitTarget.target.zoom, screenX, screenY, SNAP_ZOOM_DURATION_MS);
      return;
    }

    startZoomPivotAnimation(this.getZoomPivotAnimationContext(), result.zoom, screenX, screenY, SNAP_ZOOM_DURATION_MS);
  }

  render(): void {
    if (this.destroyed || this.contextLost || this.gl.isContextLost()) return;
    const frameStartMs = this.onStats ? nowMs() : 0;
    this.frameSerial += 1;

    const result = renderFrame({
      gl: this.gl,
      camera: this.camera,
      source: this.source,
      cache: this.cache,
      frameSerial: this.frameSerial,
      tileProgram: this.tileProgram,
      pointProgram: this.pointProgram,
      imageColorSettings: this.imageColorSettings,
      pointCount: this.pointCount,
      usePointIndices: this.usePointIndices,
      pointPaletteSize: this.pointPaletteSize,
      pointStrokeScale: this.pointStrokeScale,
      pointInnerFillOpacity: this.pointInnerFillOpacity,
      pointSizePx: this.getPointSizeByZoom() * Math.max(1, window.devicePixelRatio || 1),
      tileScheduler: this.tileScheduler,
      getVisibleTiles: () => getManagedVisibleTiles(this.camera, this.source),
      getVisibleTilesForTier: tier => getManagedVisibleTilesForTier(this.camera, this.source, tier),
      getViewBounds: () => getManagedViewBounds(this.camera),
      intersectsBounds: intersectsManagedBounds,
    });
    if (this.onStats) {
      const schedulerStats = this.tileScheduler.getSnapshot();
      this.onStats({
        tier: result.tier,
        visible: result.visible,
        rendered: result.rendered,
        points: result.points,
        fallback: result.fallback,
        cache: this.cache.size,
        inflight: schedulerStats.inflight,
        queued: schedulerStats.queued,
        retries: schedulerStats.retries,
        failed: schedulerStats.failed,
        aborted: schedulerStats.aborted,
        cacheHits: result.cacheHits,
        cacheMisses: result.cacheMisses,
        drawCalls: result.drawCalls,
        frameMs: nowMs() - frameStartMs,
      });
    }
  }

  requestRender(): void {
    if (this.frame !== null || this.destroyed || this.contextLost || this.gl.isContextLost()) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  }

  resize(): void {
    resizeCanvasViewport(this.canvas, this.gl, this.camera);
    this.requestRender();
  }

  private onWebGlContextLost(event: Event): void {
    const result = handleContextLost({
      event,
      destroyed: this.destroyed,
      contextLost: this.contextLost,
      frame: this.frame,
      cancelViewAnimation: () => this.cancelViewAnimation(),
      cancelDrag: () => this.cancelDrag(),
      tileScheduler: this.tileScheduler,
      cache: this.cache,
      onContextLost: this.onContextLost,
    });
    if (!result.handled) return;
    this.frame = result.frame;
    this.contextLost = true;
    this.pointBuffersDirty = true;
  }

  private onWebGlContextRestored(_event: Event): void {
    if (this.destroyed) return;
    this.contextLost = false;
    this.cache.clear();

    this.tileProgram = initTileProgram(this.gl);
    this.pointProgram = initPointProgram(this.gl);
    this.pointBuffersDirty = true;

    if (this.lastPointPalette && this.lastPointPalette.length > 0) {
      this.setPointPalette(this.lastPointPalette);
    }
    if (this.lastPointData) {
      this.setPointData(this.lastPointData);
    } else {
      this.pointCount = 0;
    }

    this.resize();
    this.onContextRestored?.();
  }

  destroy(): void {
    const result = destroyRenderer({
      destroyed: this.destroyed,
      frame: this.frame,
      cancelViewAnimation: () => this.cancelViewAnimation(),
      resizeObserver: this.resizeObserver,
      removeCanvasEventListeners: () => removeRendererCanvasEventListeners(this.canvas, this.getCanvasHandlers()),
      cancelDrag: () => this.cancelDrag(),
      tileScheduler: this.tileScheduler,
      contextLost: this.contextLost,
      gl: this.gl,
      cache: this.cache,
      tileProgram: this.tileProgram,
      pointProgram: this.pointProgram,
    });
    if (!result.didDestroy) return;
    this.destroyed = true;
    this.frame = result.frame;
  }
}
