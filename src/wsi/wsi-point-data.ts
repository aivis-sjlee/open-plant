import type { WsiPointData } from "./types";
import { isSameArrayView } from "./wsi-normalize";
import type { PointProgram } from "./wsi-renderer-types";

export interface PointBufferRuntime {
  pointCount: number;
  usePointIndices: boolean;
  pointBuffersDirty: boolean;
  lastPointData: WsiPointData | null;
  zeroFillModes: Uint8Array<ArrayBufferLike>;
  lastPointPalette: Uint8Array<ArrayBufferLike> | null;
  pointPaletteSize: number;
}

function sanitizeDrawIndices(drawIndices: Uint32Array, maxExclusive: number): Uint32Array {
  if (maxExclusive <= 0 || drawIndices.length === 0) {
    return new Uint32Array(0);
  }

  let validCount = drawIndices.length;
  for (let i = 0; i < drawIndices.length; i += 1) {
    if (drawIndices[i] < maxExclusive) continue;
    validCount -= 1;
  }
  if (validCount === drawIndices.length) {
    return drawIndices;
  }
  if (validCount <= 0) {
    return new Uint32Array(0);
  }

  const filtered = new Uint32Array(validCount);
  let cursor = 0;
  for (let i = 0; i < drawIndices.length; i += 1) {
    const idx = drawIndices[i];
    if (idx >= maxExclusive) continue;
    filtered[cursor] = idx;
    cursor += 1;
  }
  return filtered;
}

function getZeroFillModes(zeroFillModes: Uint8Array<ArrayBufferLike>, count: number): Uint8Array<ArrayBufferLike> {
  if (count <= 0) return new Uint8Array(0);
  if (zeroFillModes.length < count) {
    return new Uint8Array(count);
  }
  return zeroFillModes.subarray(0, count);
}

export function setPointPalette(runtime: PointBufferRuntime, gl: WebGL2RenderingContext, pointProgram: PointProgram, contextLost: boolean, colors: Uint8Array | null | undefined): PointBufferRuntime {
  if (!colors || colors.length === 0) {
    return {
      ...runtime,
      lastPointPalette: null,
    };
  }

  const nextPalette = new Uint8Array(colors);
  if (contextLost || gl.isContextLost()) {
    return {
      ...runtime,
      lastPointPalette: nextPalette,
    };
  }

  const paletteSize = Math.max(1, Math.floor(nextPalette.length / 4));
  gl.bindTexture(gl.TEXTURE_2D, pointProgram.paletteTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, paletteSize, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, nextPalette);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return {
    ...runtime,
    lastPointPalette: nextPalette,
    pointPaletteSize: paletteSize,
  };
}

export function setPointData(runtime: PointBufferRuntime, gl: WebGL2RenderingContext, pointProgram: PointProgram, contextLost: boolean, points: WsiPointData | null | undefined): PointBufferRuntime {
  if (!points || !points.count || !points.positions || !points.paletteIndices) {
    return {
      ...runtime,
      lastPointData: null,
      pointCount: 0,
      usePointIndices: false,
    };
  }

  const pointFillModes = points.fillModes instanceof Uint8Array ? points.fillModes : null;
  const hasFillModes = pointFillModes !== null;
  const safeCount = Math.max(0, Math.min(points.count, Math.floor(points.positions.length / 2), points.paletteIndices.length, hasFillModes ? pointFillModes.length : Number.MAX_SAFE_INTEGER));
  const nextPositions = points.positions.subarray(0, safeCount * 2);
  const nextPaletteIndices = points.paletteIndices.subarray(0, safeCount);
  const nextFillModes = hasFillModes ? pointFillModes.subarray(0, safeCount) : undefined;
  const hasDrawIndices = points.drawIndices instanceof Uint32Array;
  const nextDrawIndices = hasDrawIndices ? sanitizeDrawIndices(points.drawIndices as Uint32Array, safeCount) : null;

  const prev = runtime.lastPointData;
  const prevHasFillModes = prev?.fillModes instanceof Uint8Array;
  const geometryChanged =
    runtime.pointBuffersDirty ||
    !prev ||
    prev.count !== safeCount ||
    !isSameArrayView(prev.positions, nextPositions) ||
    !isSameArrayView(prev.paletteIndices, nextPaletteIndices) ||
    prevHasFillModes !== hasFillModes ||
    (hasFillModes && (!prev?.fillModes || !isSameArrayView(prev.fillModes, nextFillModes)));
  const drawIndicesChanged = runtime.pointBuffersDirty || (hasDrawIndices && (!prev?.drawIndices || !isSameArrayView(prev.drawIndices, nextDrawIndices))) || (!hasDrawIndices && !!prev?.drawIndices);

  const nextRuntime: PointBufferRuntime = {
    ...runtime,
    lastPointData: {
      count: safeCount,
      positions: nextPositions,
      paletteIndices: nextPaletteIndices,
      fillModes: nextFillModes,
      drawIndices: hasDrawIndices ? (nextDrawIndices ?? undefined) : undefined,
    },
  };

  if (contextLost || gl.isContextLost()) {
    return nextRuntime;
  }

  const currentPointData = nextRuntime.lastPointData;
  if (!currentPointData) {
    return nextRuntime;
  }

  if (geometryChanged) {
    gl.bindBuffer(gl.ARRAY_BUFFER, pointProgram.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, currentPointData.positions, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, pointProgram.termBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, currentPointData.paletteIndices, gl.STATIC_DRAW);

    const zeroFillModes = getZeroFillModes(nextRuntime.zeroFillModes, safeCount);
    gl.bindBuffer(gl.ARRAY_BUFFER, pointProgram.fillModeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, currentPointData.fillModes ?? zeroFillModes, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    nextRuntime.zeroFillModes = zeroFillModes;
  }

  if (hasDrawIndices && drawIndicesChanged) {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, pointProgram.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, nextDrawIndices ?? new Uint32Array(0), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  nextRuntime.usePointIndices = hasDrawIndices;
  nextRuntime.pointCount = hasDrawIndices ? (nextDrawIndices?.length ?? 0) : currentPointData.count;
  if (geometryChanged || drawIndicesChanged) {
    nextRuntime.pointBuffersDirty = false;
  }

  return nextRuntime;
}
