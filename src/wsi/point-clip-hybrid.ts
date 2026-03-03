import { filterPointDataByPolygons, type RoiPolygon } from "./point-clip";
import {
  pointInAnyPreparedPolygon,
  prepareRoiPolygons,
} from "./roi-geometry";
import type { WsiPointData } from "./types";
import { nowMs, sanitizePointCount } from "./utils";
import { prefilterPointsByBoundsWebGpu } from "./webgpu";

export interface HybridPointClipOptions {
  bridgeToDraw?: boolean;
}

export interface HybridPointClipResult {
  data: WsiPointData | null;
  meta: {
    mode: "hybrid-webgpu";
    durationMs: number;
    usedWebGpu: boolean;
    candidateCount: number;
    bridgedToDraw?: boolean;
  };
}

export async function filterPointDataByPolygonsHybrid(
  pointData: WsiPointData | null | undefined,
  polygons: RoiPolygon[] | null | undefined,
  options: HybridPointClipOptions = {}
): Promise<HybridPointClipResult> {
  const start = nowMs();
  const bridgeToDraw = options.bridgeToDraw === true;
  if (!pointData || !pointData.count || !pointData.positions || !pointData.paletteIndices) {
    return {
      data: null,
      meta: {
        mode: "hybrid-webgpu",
        durationMs: nowMs() - start,
        usedWebGpu: false,
        candidateCount: 0,
        bridgedToDraw: false,
      },
    };
  }

  const prepared = prepareRoiPolygons(polygons ?? []);
  if (prepared.length === 0) {
    const data: WsiPointData = {
      count: 0,
      positions: new Float32Array(0),
      paletteIndices: new Uint16Array(0),
    };
    if (pointData.fillModes instanceof Uint8Array) {
      data.fillModes = new Uint8Array(0);
    }
    if (pointData.ids instanceof Uint32Array) {
      data.ids = new Uint32Array(0);
    }
    return {
      data,
      meta: {
        mode: "hybrid-webgpu",
        durationMs: nowMs() - start,
        usedWebGpu: false,
        candidateCount: 0,
        bridgedToDraw: false,
      },
    };
  }

  const safeCount = sanitizePointCount(pointData);
  const pointFillModes = pointData.fillModes instanceof Uint8Array && pointData.fillModes.length >= safeCount ? pointData.fillModes : null;
  const pointIds = pointData.ids instanceof Uint32Array && pointData.ids.length >= safeCount ? pointData.ids : null;
  if (safeCount === 0) {
    const data: WsiPointData = {
      count: 0,
      positions: new Float32Array(0),
      paletteIndices: new Uint16Array(0),
    };
    if (pointFillModes) {
      data.fillModes = new Uint8Array(0);
    }
    if (pointIds) {
      data.ids = new Uint32Array(0);
    }
    return {
      data,
      meta: {
        mode: "hybrid-webgpu",
        durationMs: nowMs() - start,
        usedWebGpu: false,
        candidateCount: 0,
        bridgedToDraw: false,
      },
    };
  }

  const bboxFlat = new Float32Array(prepared.length * 4);
  for (let i = 0; i < prepared.length; i += 1) {
    const base = i * 4;
    const polygon = prepared[i];
    bboxFlat[base] = polygon.minX;
    bboxFlat[base + 1] = polygon.minY;
    bboxFlat[base + 2] = polygon.maxX;
    bboxFlat[base + 3] = polygon.maxY;
  }

  let candidateMask: Uint32Array | null = null;
  let usedWebGpu = false;
  try {
    candidateMask = await prefilterPointsByBoundsWebGpu(pointData.positions, safeCount, bboxFlat);
    usedWebGpu = !!candidateMask;
  } catch {
    candidateMask = null;
    usedWebGpu = false;
  }

  if (!candidateMask) {
    const fallback = filterPointDataByPolygons(pointData, polygons);
    return {
      data: fallback,
      meta: {
        mode: "hybrid-webgpu",
        durationMs: nowMs() - start,
        usedWebGpu: false,
        candidateCount: safeCount,
        bridgedToDraw: false,
      },
    };
  }

  let candidateCount = 0;
  for (let i = 0; i < safeCount; i += 1) {
    if (candidateMask[i] === 1) candidateCount += 1;
  }

  const candidateIndices = new Uint32Array(candidateCount);
  if (candidateCount > 0) {
    let candidateCursor = 0;
    for (let i = 0; i < safeCount; i += 1) {
      if (candidateMask[i] !== 1) continue;
      candidateIndices[candidateCursor] = i;
      candidateCursor += 1;
    }
  }

  if (candidateCount === 0) {
    if (bridgeToDraw) {
      const data: WsiPointData = {
        count: safeCount,
        positions: pointData.positions.subarray(0, safeCount * 2),
        paletteIndices: pointData.paletteIndices.subarray(0, safeCount),
        drawIndices: new Uint32Array(0),
      };
      if (pointFillModes) {
        data.fillModes = pointFillModes.subarray(0, safeCount);
      }
      if (pointIds) {
        data.ids = pointIds.subarray(0, safeCount);
      }
      return {
        data,
        meta: {
          mode: "hybrid-webgpu",
          durationMs: nowMs() - start,
          usedWebGpu: true,
          candidateCount: 0,
          bridgedToDraw: true,
        },
      };
    }

    const data: WsiPointData = {
      count: 0,
      positions: new Float32Array(0),
      paletteIndices: new Uint16Array(0),
    };
    if (pointFillModes) {
      data.fillModes = new Uint8Array(0);
    }
    if (pointIds) {
      data.ids = new Uint32Array(0);
    }
    return {
      data,
      meta: {
        mode: "hybrid-webgpu",
        durationMs: nowMs() - start,
        usedWebGpu: true,
        candidateCount: 0,
        bridgedToDraw: false,
      },
    };
  }

  if (bridgeToDraw) {
    const drawIndices = new Uint32Array(candidateCount);
    let visibleCount = 0;

    for (let i = 0; i < candidateCount; i += 1) {
      const pointIndex = candidateIndices[i] ?? 0;
      const x = pointData.positions[pointIndex * 2];
      const y = pointData.positions[pointIndex * 2 + 1];
      if (!pointInAnyPreparedPolygon(x, y, prepared)) continue;
      drawIndices[visibleCount] = pointIndex;
      visibleCount += 1;
    }

    const data: WsiPointData = {
      count: safeCount,
      positions: pointData.positions.subarray(0, safeCount * 2),
      paletteIndices: pointData.paletteIndices.subarray(0, safeCount),
      drawIndices: drawIndices.subarray(0, visibleCount),
    };
    if (pointFillModes) {
      data.fillModes = pointFillModes.subarray(0, safeCount);
    }
    if (pointIds) {
      data.ids = pointIds.subarray(0, safeCount);
    }

    return {
      data,
      meta: {
        mode: "hybrid-webgpu",
        durationMs: nowMs() - start,
        usedWebGpu: true,
        candidateCount,
        bridgedToDraw: true,
      },
    };
  }

  const nextPositions = new Float32Array(candidateCount * 2);
  const nextTerms = new Uint16Array(candidateCount);
  const nextFillModes = pointFillModes ? new Uint8Array(candidateCount) : null;
  const nextIds = pointIds ? new Uint32Array(candidateCount) : null;
  let cursor = 0;

  for (let i = 0; i < candidateCount; i += 1) {
    const pointIndex = candidateIndices[i] ?? 0;
    const x = pointData.positions[pointIndex * 2];
    const y = pointData.positions[pointIndex * 2 + 1];
    if (!pointInAnyPreparedPolygon(x, y, prepared)) continue;
    nextPositions[cursor * 2] = x;
    nextPositions[cursor * 2 + 1] = y;
    nextTerms[cursor] = pointData.paletteIndices[pointIndex];
    if (nextFillModes) {
      nextFillModes[cursor] = pointFillModes![pointIndex];
    }
    if (nextIds) {
      nextIds[cursor] = pointIds![pointIndex];
    }
    cursor += 1;
  }

  const compactData: WsiPointData = {
    count: cursor,
    positions: nextPositions.subarray(0, cursor * 2),
    paletteIndices: nextTerms.subarray(0, cursor),
  };
  if (nextFillModes) {
    compactData.fillModes = nextFillModes.subarray(0, cursor);
  }
  if (nextIds) {
    compactData.ids = nextIds.subarray(0, cursor);
  }

  return {
    data: compactData,
    meta: {
      mode: "hybrid-webgpu",
      durationMs: nowMs() - start,
      usedWebGpu: true,
      candidateCount,
      bridgedToDraw: false,
    },
  };
}
