import type { DrawCoordinate, DrawTool, StampDrawTool, StampOptions } from "./draw-layer-types";
import { CIRCLE_SIDES, DEFAULT_STAMP_CIRCLE_AREA_MM2, DEFAULT_STAMP_RECTANGLE_AREA_MM2, DEFAULT_STAMP_RECTANGLE_PIXEL_SIZE, LEGACY_HPF_CIRCLE_AREA_MM2 } from "./draw-layer-types";
import { clampPositiveOrFallback, clampWorld, closeRing } from "./draw-layer-utils";

export type { StampDrawTool, StampOptions };

export function isStampTool(tool: DrawTool): tool is StampDrawTool {
  return (
    tool === "stamp-rectangle" || tool === "stamp-circle" || tool === "stamp-rectangle-4096px" || tool === "stamp-rectangle-2mm2" || tool === "stamp-circle-2mm2" || tool === "stamp-circle-hpf-0.2mm2"
  );
}

export function resolveStampOptions(options: StampOptions | undefined): Required<StampOptions> {
  return {
    rectangleAreaMm2: clampPositiveOrFallback(options?.rectangleAreaMm2, DEFAULT_STAMP_RECTANGLE_AREA_MM2),
    circleAreaMm2: clampPositiveOrFallback(options?.circleAreaMm2, DEFAULT_STAMP_CIRCLE_AREA_MM2),
    rectanglePixelSize: clampPositiveOrFallback(options?.rectanglePixelSize, DEFAULT_STAMP_RECTANGLE_PIXEL_SIZE),
  };
}

const MICRONS_PER_MM = 1000;

export function mm2ToUm2(areaMm2: number): number {
  return areaMm2 * MICRONS_PER_MM * MICRONS_PER_MM;
}

export function createSquareFromCenter(
  center: DrawCoordinate | null,
  halfLength: number,
  projection?: {
    worldToScreen: (x: number, y: number) => DrawCoordinate | null;
    screenToWorld: (screen: DrawCoordinate) => DrawCoordinate | null;
  }
): DrawCoordinate[] {
  if (!center || !Number.isFinite(halfLength) || halfLength <= 0) return [];

  if (projection) {
    const screenCenter = projection.worldToScreen(center[0], center[1]);
    const screenEdge = projection.worldToScreen(center[0] + halfLength, center[1]);
    if (screenCenter && screenEdge) {
      const screenHL = Math.hypot(screenEdge[0] - screenCenter[0], screenEdge[1] - screenCenter[1]);
      const screenCorners: DrawCoordinate[] = [
        [screenCenter[0] - screenHL, screenCenter[1] - screenHL],
        [screenCenter[0] + screenHL, screenCenter[1] - screenHL],
        [screenCenter[0] + screenHL, screenCenter[1] + screenHL],
        [screenCenter[0] - screenHL, screenCenter[1] + screenHL],
      ];
      const worldCorners: DrawCoordinate[] = [];
      for (const corner of screenCorners) {
        const world = projection.screenToWorld(corner);
        if (!world) throw new Error("Failed to create rectangle");
        worldCorners.push(world);
      }
      return closeRing(worldCorners);
    }
  }

  return closeRing([
    [center[0] - halfLength, center[1] - halfLength],
    [center[0] + halfLength, center[1] - halfLength],
    [center[0] + halfLength, center[1] + halfLength],
    [center[0] - halfLength, center[1] + halfLength],
  ]);
}

export function createCircleFromCenter(center: DrawCoordinate | null, radius: number, sides = CIRCLE_SIDES): DrawCoordinate[] {
  if (!center || !Number.isFinite(radius) || radius <= 0) return [];

  const coords: DrawCoordinate[] = [];
  for (let i = 0; i <= sides; i += 1) {
    const t = (i / sides) * Math.PI * 2;
    coords.push([center[0] + Math.cos(t) * radius, center[1] + Math.sin(t) * radius]);
  }

  return closeRing(coords);
}

export interface BuildStampCoordsParams {
  stampTool: StampDrawTool;
  center: DrawCoordinate | null;
  resolvedStampOptions: Required<StampOptions>;
  imageWidth: number;
  imageHeight: number;
  micronsToWorldPixels: (lengthUm: number) => number;
  getRectangleProjection: () =>
    | {
        worldToScreen: (x: number, y: number) => DrawCoordinate | null;
        screenToWorld: (screen: DrawCoordinate) => DrawCoordinate | null;
      }
    | undefined;
}

export function buildStampCoords(params: BuildStampCoordsParams): DrawCoordinate[] {
  const { stampTool, center, resolvedStampOptions, imageWidth, imageHeight, micronsToWorldPixels, getRectangleProjection } = params;

  if (!center) return [];

  if (stampTool === "stamp-rectangle-4096px") {
    const halfLength = resolvedStampOptions.rectanglePixelSize * 0.5;
    return createSquareFromCenter(center, halfLength, getRectangleProjection()).map(point => clampWorld(point, imageWidth, imageHeight));
  }

  let areaMm2 = 0;
  if (stampTool === "stamp-rectangle" || stampTool === "stamp-rectangle-2mm2") {
    areaMm2 = stampTool === "stamp-rectangle-2mm2" ? DEFAULT_STAMP_RECTANGLE_AREA_MM2 : resolvedStampOptions.rectangleAreaMm2;
  } else if (stampTool === "stamp-circle" || stampTool === "stamp-circle-2mm2" || stampTool === "stamp-circle-hpf-0.2mm2") {
    areaMm2 = stampTool === "stamp-circle-hpf-0.2mm2" ? LEGACY_HPF_CIRCLE_AREA_MM2 : stampTool === "stamp-circle-2mm2" ? DEFAULT_STAMP_CIRCLE_AREA_MM2 : resolvedStampOptions.circleAreaMm2;
  }
  if (!Number.isFinite(areaMm2) || areaMm2 <= 0) return [];

  const areaUm2 = mm2ToUm2(areaMm2);
  let coords: DrawCoordinate[] = [];
  if (stampTool === "stamp-rectangle" || stampTool === "stamp-rectangle-2mm2") {
    const halfLength = micronsToWorldPixels(Math.sqrt(areaUm2) * 0.5);
    coords = createSquareFromCenter(center, halfLength, getRectangleProjection());
  } else if (stampTool === "stamp-circle" || stampTool === "stamp-circle-2mm2" || stampTool === "stamp-circle-hpf-0.2mm2") {
    const radius = micronsToWorldPixels(Math.sqrt(areaUm2 / Math.PI));
    coords = createCircleFromCenter(center, radius);
  }

  if (!coords.length) return [];
  return coords.map(point => clampWorld(point, imageWidth, imageHeight));
}
