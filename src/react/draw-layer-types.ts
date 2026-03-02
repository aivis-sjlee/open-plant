import type { CSSProperties, MutableRefObject, RefObject } from "react";

export type StampDrawTool =
  | "stamp-rectangle"
  | "stamp-circle"
  | "stamp-rectangle-4096px"
  | "stamp-rectangle-2mm2"
  | "stamp-circle-2mm2"
  | "stamp-circle-hpf-0.2mm2";

export type DrawTool = "cursor" | "freehand" | "rectangle" | "circular" | "brush" | StampDrawTool;

export type DrawCoordinate = [number, number];

export type DrawBounds = [number, number, number, number];
export type DrawRegionCoordinates = DrawCoordinate[] | DrawCoordinate[][] | DrawCoordinate[][][];

export type DrawIntent = "roi" | "patch" | "brush";

export interface DrawResult {
  tool: Exclude<DrawTool, "cursor">;
  intent: DrawIntent;
  coordinates: DrawCoordinate[];
  bbox: DrawBounds;
  areaPx: number;
}

export type PatchDrawResult = DrawResult & {
  tool: "stamp-rectangle-4096px";
  intent: "patch";
};

export interface DrawRegion {
  id?: string | number;
  coordinates: DrawRegionCoordinates;
  label?: string;
}

export interface RegionStyleContext {
  region: DrawRegion;
  regionId: string | number;
  regionIndex: number;
  state: "default" | "hover" | "active";
}

export type RegionStrokeStyleResolver = (context: RegionStyleContext) => Partial<RegionStrokeStyle> | null | undefined;

export interface RegionLabelStyleContext {
  region: DrawRegion;
  regionId: string | number;
  regionIndex: number;
  zoom: number;
}

export type RegionLabelStyleResolver = (context: RegionLabelStyleContext) => Partial<RegionLabelStyle> | null | undefined;

export type DrawOverlayCoordinates = DrawCoordinate[] | DrawCoordinate[][] | DrawCoordinate[][][];

export interface DrawOverlayShape {
  id?: string | number;
  coordinates: DrawOverlayCoordinates;
  closed?: boolean;
  fill?: boolean;
  stroke?: Partial<RegionStrokeStyle>;
  strokeStyle?: Partial<RegionStrokeStyle>;
  invertedFill?: DrawOverlayInvertedFillStyle;
  visible?: boolean;
}

export interface DrawOverlayInvertedFillStyle {
  fillColor: string;
}

export interface RegionStrokeStyle {
  color: string;
  width: number;
  lineDash: number[];
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
}

export interface RegionLabelStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: string | number;
  textColor: string;
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
  paddingX: number;
  paddingY: number;
  offsetY: number;
  borderRadius: number;
}

export interface DrawAreaTooltipStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: string | number;
  textColor: string;
  backgroundColor: string;
  borderRadius: number;
  paddingX: number;
  paddingY: number;
}

export interface DrawAreaTooltipOptions {
  enabled?: boolean;
  format?: (areaMm2: number) => string;
  style?: Partial<DrawAreaTooltipStyle>;
  cursorOffset?: {
    x: number;
    y: number;
  };
}

export interface DrawProjector {
  screenToWorld(clientX: number, clientY: number): DrawCoordinate | number[];
  worldToScreen(worldX: number, worldY: number): DrawCoordinate | number[];
  getViewState?: () => { zoom: number; rotationDeg?: number };
  getZoomRange?: () => { minZoom: number; maxZoom: number };
  zoomBy?: (factor: number, screenX: number, screenY: number) => void;
}

export interface StampOptions {
  rectangleAreaMm2?: number;
  circleAreaMm2?: number;
  rectanglePixelSize?: number;
}

export interface BrushOptions {
  radius: number;
  edgeDetail?: number;
  edgeSmoothing?: number;
  clickSelectRoi?: boolean;
  fillColor?: string;
  fillOpacity?: number;
  cursorColor?: string;
  cursorActiveColor?: string;
  cursorLineWidth?: number;
  cursorLineDash?: number[];
}

export interface DrawLayerProps {
  tool: DrawTool;
  imageWidth: number;
  imageHeight: number;
  imageMpp?: number;
  imageZoom?: number;
  stampOptions?: StampOptions;
  brushOptions?: BrushOptions;
  projectorRef: RefObject<DrawProjector | null>;
  onBrushTap?: (coordinate: DrawCoordinate) => boolean;
  onDrawComplete?: (result: DrawResult) => void;
  onPatchComplete?: (result: PatchDrawResult) => void;
  enabled?: boolean;
  viewStateSignal?: unknown;
  persistedRegions?: DrawRegion[];
  patchRegions?: DrawRegion[];
  persistedPolygons?: DrawRegionCoordinates[];
  drawFillColor?: string;
  regionStrokeStyle?: Partial<RegionStrokeStyle>;
  regionStrokeHoverStyle?: Partial<RegionStrokeStyle>;
  regionStrokeActiveStyle?: Partial<RegionStrokeStyle>;
  patchStrokeStyle?: Partial<RegionStrokeStyle>;
  resolveRegionStrokeStyle?: RegionStrokeStyleResolver;
  resolveRegionLabelStyle?: RegionLabelStyleResolver;
  overlayShapes?: DrawOverlayShape[];
  hoveredRegionId?: string | number | null;
  activeRegionId?: string | number | null;
  regionLabelStyle?: Partial<RegionLabelStyle>;
  drawAreaTooltip?: DrawAreaTooltipOptions;
  autoLiftRegionLabelAtMaxZoom?: boolean;
  regionLabelAutoLiftOffsetPx?: number;
  invalidateRef?: MutableRefObject<(() => void) | null>;
  className?: string;
  style?: CSSProperties;
}

export interface DrawSession {
  isDrawing: boolean;
  pointerId: number | null;
  start: DrawCoordinate | null;
  current: DrawCoordinate | null;
  cursor: DrawCoordinate | null;
  cursorScreen: DrawCoordinate | null;
  points: DrawCoordinate[];
  screenPoints: DrawCoordinate[];
  stampCenter: DrawCoordinate | null;
}

export interface NormalizedDrawRegionPolygon {
  outer: DrawCoordinate[];
  holes: DrawCoordinate[][];
}

export interface PreparedRenderedRegion {
  region: DrawRegion;
  regionIndex: number;
  regionKey: string | number;
  polygons: NormalizedDrawRegionPolygon[];
}

export interface ResolvedBrushOptions {
  radius: number;
  edgeDetail: number;
  edgeSmoothing: number;
  clickSelectRoi: boolean;
  fillColor: string;
  fillOpacity: number;
  cursorColor: string;
  cursorActiveColor: string;
  cursorLineWidth: number;
  cursorLineDash: number[];
}

export interface ResolvedDrawAreaTooltipOptions {
  enabled: boolean;
  format: (areaMm2: number) => string;
  style: DrawAreaTooltipStyle;
  cursorOffsetX: number;
  cursorOffsetY: number;
}

export const EMPTY_DASH: number[] = [];
export const EMPTY_REGIONS: DrawRegion[] = [];

export const DEFAULT_REGION_STROKE_STYLE: RegionStrokeStyle = {
  color: "#ff4d4f",
  width: 2,
  lineDash: EMPTY_DASH,
  lineJoin: "round",
  lineCap: "round",
  shadowColor: "rgba(0, 0, 0, 0)",
  shadowBlur: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 0,
};

export const DEFAULT_PATCH_STROKE_STYLE: RegionStrokeStyle = {
  color: "#4cc9f0",
  width: 2,
  lineDash: [10, 8],
  lineJoin: "round",
  lineCap: "round",
  shadowColor: "rgba(0, 0, 0, 0)",
  shadowBlur: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 0,
};

export const REGION_INTERACTION_SHADOW_COLOR = "rgba(23, 23, 25, 0.1)";
export const REGION_INTERACTION_SHADOW_WIDTH = 6;

export const DEFAULT_REGION_LABEL_STYLE: RegionLabelStyle = {
  fontFamily: "Pretendard, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontSize: 11,
  fontWeight: 600,
  textColor: "#171719",
  backgroundColor: "#FFCC00",
  borderColor: "rgba(0, 0, 0, 0)",
  borderWidth: 0,
  paddingX: 8,
  paddingY: 4,
  offsetY: 10,
  borderRadius: 4,
};

export const DEFAULT_DRAW_AREA_TOOLTIP_STYLE: DrawAreaTooltipStyle = {
  fontFamily: "Pretendard, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontSize: 13,
  fontWeight: 500,
  textColor: "#FFFFFF",
  backgroundColor: "rgba(23, 23, 25, 0.5)",
  borderRadius: 4,
  paddingX: 6,
  paddingY: 3,
};

export const DEFAULT_DRAW_AREA_TOOLTIP_OFFSET = {
  x: 16,
  y: -24,
} as const;

export const REGION_LABEL_AUTO_LIFT_MAX_OFFSET_PX = 20;
export const REGION_LABEL_AUTO_LIFT_MAX_EPSILON = 1e-6;

export const DRAW_FILL = "rgba(255, 77, 79, 0.16)";
export const DEFAULT_DRAW_PREVIEW_FILL = "transparent";
export const FREEHAND_MIN_POINTS = 3;
export const FREEHAND_SCREEN_STEP = 2;
export const CIRCLE_SIDES = 96;
export const MIN_AREA_PX = 1;
export const MICRONS_PER_MM = 1000;
export const DEFAULT_STAMP_RECTANGLE_AREA_MM2 = 2;
export const DEFAULT_STAMP_CIRCLE_AREA_MM2 = 2;
export const DEFAULT_STAMP_RECTANGLE_PIXEL_SIZE = 4096;
export const LEGACY_HPF_CIRCLE_AREA_MM2 = 0.2;
export const WHEEL_ZOOM_IN_FACTOR = 1.12;
export const WHEEL_ZOOM_OUT_FACTOR = 0.89;
export const DEFAULT_BRUSH_RADIUS = 32;
export const DEFAULT_BRUSH_FILL_COLOR = "#000000";
export const DEFAULT_BRUSH_FILL_OPACITY = 0.1;
export const DEFAULT_BRUSH_CURSOR_COLOR = "#FFCF00";
export const DEFAULT_BRUSH_CURSOR_ACTIVE_COLOR = "#FF0000";
export const DEFAULT_BRUSH_CURSOR_LINE_WIDTH = 1.5;
export const DEFAULT_BRUSH_CURSOR_DASH = [2, 2];
export const DEFAULT_BRUSH_EDGE_DETAIL = 1;
export const MIN_BRUSH_EDGE_DETAIL = 0.25;
export const MAX_BRUSH_EDGE_DETAIL = 4;
export const DEFAULT_BRUSH_EDGE_SMOOTHING = 1;
export const MIN_BRUSH_EDGE_SMOOTHING = 0;
export const MAX_BRUSH_EDGE_SMOOTHING = 4;
export const MIN_BRUSH_RASTER_STEP = 0.05;
export const BRUSH_RASTER_DIAMETER_SAMPLES = 256;
export const BRUSH_SCREEN_STEP = 1.5;
