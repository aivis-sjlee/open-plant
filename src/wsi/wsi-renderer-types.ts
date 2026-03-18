import type { ScheduledTile, TileBounds } from "./tile-scheduler";
import type { WsiImageColorSettings, WsiImageSource, WsiRenderStats, WsiViewState } from "./types";

export type Bounds = TileBounds;
export type WorldPoint = [number, number];

export interface CachedTile {
  key: string;
  texture: WebGLTexture;
  bounds: Bounds;
  tier: number;
  lastUsed: number;
}

export interface TileVertexProgram {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  uCamera: WebGLUniformLocation;
  uBounds: WebGLUniformLocation;
  uTexture: WebGLUniformLocation;
  uBrightness: WebGLUniformLocation;
  uContrast: WebGLUniformLocation;
  uSaturation: WebGLUniformLocation;
}

export interface PointProgram {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  posBuffer: WebGLBuffer;
  termBuffer: WebGLBuffer;
  fillModeBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  paletteTexture: WebGLTexture;
  uCamera: WebGLUniformLocation;
  uPointSize: WebGLUniformLocation;
  uPalette: WebGLUniformLocation;
  uPaletteSize: WebGLUniformLocation;
  uPointStrokeScale: WebGLUniformLocation;
  uPointInnerFillAlpha: WebGLUniformLocation;
}

export interface PointSizeStop {
  zoom: number;
  size: number;
}

export type PointSizeByZoom = Readonly<Record<number, number>>;

export interface WsiViewTransitionOptions {
  duration?: number;
  easing?: (t: number) => number;
}

export interface WsiTileSchedulerConfig {
  maxConcurrency?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

export interface WsiTileErrorEvent {
  tile: ScheduledTile;
  error: unknown;
  attemptCount: number;
}

export interface WsiTileRendererOptions {
  onViewStateChange?: (next: WsiViewState) => void;
  onStats?: (stats: WsiRenderStats) => void;
  authToken?: string;
  imageColorSettings?: WsiImageColorSettings | null;
  minZoom?: number;
  maxZoom?: number;
  viewTransition?: WsiViewTransitionOptions;
  pointSizeByZoom?: PointSizeByZoom;
  pointStrokeScale?: number;
  pointInnerFillOpacity?: number;
  maxCacheTiles?: number;
  ctrlDragRotate?: boolean;
  rotationDragSensitivityDegPerPixel?: number;
  tileScheduler?: WsiTileSchedulerConfig;
  onTileError?: (event: WsiTileErrorEvent) => void;
  onContextLost?: () => void;
  onContextRestored?: () => void;
  zoomSnaps?: number[];
  zoomSnapFitAsMin?: boolean;
}

export interface ViewAnimationState {
  startMs: number;
  durationMs: number;
  from: WsiViewState;
  to: WsiViewState;
  easing: (t: number) => number;
}

export interface NormalizedImageColorSettings {
  brightness: number;
  contrast: number;
  saturation: number;
}

export interface InteractionState {
  dragging: boolean;
  mode: "none" | "pan" | "rotate";
  rotateLastAngleRad: number | null;
  pointerId: number | null;
  lastPointerX: number;
  lastPointerY: number;
}

export interface ZoomSnapState {
  accumulatedDelta: number;
  lastSnapTimeMs: number;
  blockedDirection: "in" | "out" | null;
}

export interface InteractionConfig {
  ctrlDragRotate: boolean;
  rotationDragSensitivityDegPerPixel: number;
}

export interface ViewAnimationRuntimeState {
  animation: ViewAnimationState | null;
  frame: number | null;
}

export interface HandleTileLoadedOptions {
  gl: WebGL2RenderingContext;
  cache: Map<string, CachedTile>;
  tile: ScheduledTile;
  bitmap: ImageBitmap;
  frameSerial: number;
  maxCacheTiles: number;
  destroyed: boolean;
  contextLost: boolean;
  requestRender: () => void;
}

export interface TileCacheTrimOptions {
  gl: WebGL2RenderingContext;
  cache: Map<string, CachedTile>;
  maxCacheTiles: number;
}

export interface ViewAnimationStartOptions {
  state: ViewAnimationRuntimeState;
  camera: {
    getViewState: () => WsiViewState;
    setViewState: (next: Partial<WsiViewState>) => void;
  };
  target: WsiViewState;
  durationMs: number;
  easing: (t: number) => number;
  onUpdate: () => void;
}
