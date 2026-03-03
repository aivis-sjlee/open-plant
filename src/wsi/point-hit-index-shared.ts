export const MIN_POINT_HIT_GRID_SIZE = 24;
export const MAX_POINT_HIT_GRID_SIZE = 1024;
export const POINT_HIT_GRID_DENSITY_SCALE = 4;
export const HASH_EMPTY = -1;

export interface PointHitIndexBuildInput {
  count: number;
  positions: Float32Array;
  drawIndices?: Uint32Array | null;
  sourceWidth: number;
  sourceHeight: number;
}

export interface PointHitIndexBuildResult {
  cellSize: number;
  safeCount: number;
  cellCount: number;
  hashCapacity: number;
  hashTable: Int32Array;
  cellKeys: Int32Array;
  cellOffsets: Uint32Array;
  cellLengths: Uint32Array;
  pointIndices: Uint32Array;
}

export function cellHash(cellX: number, cellY: number, mask: number): number {
  return (((cellX * 73856093) ^ (cellY * 19349663)) >>> 0) & mask;
}

function resolveGridSize(sourceWidth: number, sourceHeight: number, visibleCount: number): number {
  if (sourceWidth <= 0 || sourceHeight <= 0 || visibleCount <= 0) return 256;
  const area = Math.max(1, sourceWidth * sourceHeight);
  const avgSpacing = Math.sqrt(area / Math.max(1, visibleCount));
  const raw = avgSpacing * POINT_HIT_GRID_DENSITY_SCALE;
  return Math.max(MIN_POINT_HIT_GRID_SIZE, Math.min(MAX_POINT_HIT_GRID_SIZE, raw));
}

function sanitizeDrawIndices(raw: Uint32Array | null | undefined, safeCount: number): Uint32Array | null {
  if (!(raw instanceof Uint32Array) || raw.length === 0) {
    return null;
  }

  let allValid = true;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] < safeCount) continue;
    allValid = false;
    break;
  }
  if (allValid) {
    return raw;
  }

  const filtered = new Uint32Array(raw.length);
  let cursor = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] >= safeCount) continue;
    filtered[cursor] = raw[i];
    cursor += 1;
  }
  return cursor > 0 ? filtered.subarray(0, cursor) : null;
}

export function buildPointHitIndex(input: PointHitIndexBuildInput): PointHitIndexBuildResult | null {
  const count = Math.max(0, Math.floor(input.count));
  const maxCountByPositions = Math.floor(input.positions.length / 2);
  const safeCount = Math.max(0, Math.min(count, maxCountByPositions));
  if (safeCount <= 0) {
    return null;
  }

  const drawIndices = sanitizeDrawIndices(input.drawIndices ?? null, safeCount);
  const visibleCount = drawIndices ? drawIndices.length : safeCount;
  if (visibleCount === 0) {
    return null;
  }

  const cellSize = resolveGridSize(input.sourceWidth, input.sourceHeight, visibleCount);
  const invCellSize = 1.0 / cellSize;

  const pointCellX = new Int32Array(visibleCount);
  const pointCellY = new Int32Array(visibleCount);
  let validCount = 0;

  if (drawIndices) {
    for (let i = 0; i < visibleCount; i += 1) {
      const pi = drawIndices[i];
      const px = input.positions[pi * 2];
      const py = input.positions[pi * 2 + 1];
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      pointCellX[validCount] = Math.floor(px * invCellSize);
      pointCellY[validCount] = Math.floor(py * invCellSize);
      validCount += 1;
    }
  } else {
    for (let i = 0; i < safeCount; i += 1) {
      const px = input.positions[i * 2];
      const py = input.positions[i * 2 + 1];
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      pointCellX[validCount] = Math.floor(px * invCellSize);
      pointCellY[validCount] = Math.floor(py * invCellSize);
      validCount += 1;
    }
  }

  if (validCount === 0) {
    return null;
  }

  let estimatedCells = Math.min(validCount, Math.max(64, validCount >>> 3));
  if (!Number.isFinite(estimatedCells) || estimatedCells <= 0) {
    estimatedCells = validCount;
  }

  let hashCapacity = 1;
  while (hashCapacity < estimatedCells * 2) hashCapacity <<= 1;
  let hashMask = hashCapacity - 1;

  let tempHashKeys = new Int32Array(hashCapacity * 2);
  let tempHashCounts = new Int32Array(hashCapacity);
  tempHashKeys.fill(0x7fffffff);
  let cellCount = 0;

  const pointCellSlot = new Int32Array(validCount);

  for (let i = 0; i < validCount; i += 1) {
    const cx = pointCellX[i];
    const cy = pointCellY[i];
    let slot = cellHash(cx, cy, hashMask);

    while (true) {
      const kx = tempHashKeys[slot * 2];
      if (kx === 0x7fffffff) {
        tempHashKeys[slot * 2] = cx;
        tempHashKeys[slot * 2 + 1] = cy;
        tempHashCounts[slot] = 1;
        pointCellSlot[i] = slot;
        cellCount += 1;

        if (cellCount * 4 > hashCapacity * 3) {
          const oldCap = hashCapacity;
          hashCapacity <<= 1;
          hashMask = hashCapacity - 1;

          const newKeys = new Int32Array(hashCapacity * 2);
          const newCounts = new Int32Array(hashCapacity);
          newKeys.fill(0x7fffffff);

          for (let s = 0; s < oldCap; s += 1) {
            if (tempHashKeys[s * 2] === 0x7fffffff) continue;
            const ocx = tempHashKeys[s * 2];
            const ocy = tempHashKeys[s * 2 + 1];
            let ns = cellHash(ocx, ocy, hashMask);
            while (newKeys[ns * 2] !== 0x7fffffff) ns = (ns + 1) & hashMask;
            newKeys[ns * 2] = ocx;
            newKeys[ns * 2 + 1] = ocy;
            newCounts[ns] = tempHashCounts[s];
          }

          tempHashKeys = newKeys;
          tempHashCounts = newCounts;

          slot = cellHash(cx, cy, hashMask);
          while (
            tempHashKeys[slot * 2] !== cx ||
            tempHashKeys[slot * 2 + 1] !== cy
          ) {
            slot = (slot + 1) & hashMask;
          }
          pointCellSlot[i] = slot;
        }
        break;
      }

      if (kx === cx && tempHashKeys[slot * 2 + 1] === cy) {
        tempHashCounts[slot] += 1;
        pointCellSlot[i] = slot;
        break;
      }

      slot = (slot + 1) & hashMask;
    }
  }

  const cellKeys = new Int32Array(cellCount * 2);
  const cellOffsets = new Uint32Array(cellCount);
  const cellLengths = new Uint32Array(cellCount);
  const slotToCellIndex = new Int32Array(hashCapacity);
  slotToCellIndex.fill(HASH_EMPTY);

  let cellIdx = 0;
  let offset = 0;
  for (let s = 0; s < hashCapacity; s += 1) {
    if (tempHashKeys[s * 2] === 0x7fffffff) continue;
    cellKeys[cellIdx * 2] = tempHashKeys[s * 2];
    cellKeys[cellIdx * 2 + 1] = tempHashKeys[s * 2 + 1];
    cellOffsets[cellIdx] = offset;
    cellLengths[cellIdx] = tempHashCounts[s];
    slotToCellIndex[s] = cellIdx;
    offset += tempHashCounts[s];
    cellIdx += 1;
  }

  const pointIndices = new Uint32Array(validCount);
  const fillCursor = new Uint32Array(cellCount);
  fillCursor.set(cellOffsets);

  if (drawIndices) {
    for (let i = 0; i < validCount; i += 1) {
      const ci = slotToCellIndex[pointCellSlot[i]];
      pointIndices[fillCursor[ci]] = drawIndices[i];
      fillCursor[ci] += 1;
    }
  } else {
    let srcIdx = 0;
    for (let i = 0; i < safeCount; i += 1) {
      const px = input.positions[i * 2];
      const py = input.positions[i * 2 + 1];
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      const ci = slotToCellIndex[pointCellSlot[srcIdx]];
      pointIndices[fillCursor[ci]] = i;
      fillCursor[ci] += 1;
      srcIdx += 1;
    }
  }

  let finalCap = 1;
  while (finalCap < cellCount * 2) finalCap <<= 1;
  const finalMask = finalCap - 1;
  const hashTable = new Int32Array(finalCap);
  hashTable.fill(HASH_EMPTY);

  for (let i = 0; i < cellCount; i += 1) {
    const cx = cellKeys[i * 2];
    const cy = cellKeys[i * 2 + 1];
    let slot = cellHash(cx, cy, finalMask);
    while (hashTable[slot] !== HASH_EMPTY) slot = (slot + 1) & finalMask;
    hashTable[slot] = i;
  }

  return {
    cellSize,
    safeCount,
    cellCount,
    hashCapacity: finalCap,
    hashTable,
    cellKeys,
    cellOffsets,
    cellLengths,
    pointIndices,
  };
}
