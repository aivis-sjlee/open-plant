import { HASH_EMPTY, buildPointHitIndex, cellHash } from "./point-hit-index-shared";
import type {
  PointHitIndexWorkerRequest,
  PointHitIndexWorkerResponse,
  PointHitIndexWorkerSuccess,
} from "./point-hit-index-worker-protocol";
import type { WsiImageSource, WsiPointData } from "./types";
import { sanitizePointCount } from "./utils";
import { WorkerClient } from "./worker-client";

export interface FlatPointSpatialIndex {
  cellSize: number;
  safeCount: number;
  positions: Float32Array;
  ids: Uint32Array | null;
  hashCapacity: number;
  hashMask: number;
  hashTable: Int32Array;
  cellKeys: Int32Array;
  cellOffsets: Uint32Array;
  cellLengths: Uint32Array;
  pointIndices: Uint32Array;
}

export function lookupCellIndex(
  index: FlatPointSpatialIndex,
  cellX: number,
  cellY: number,
): number {
  const { hashTable, cellKeys, hashMask } = index;
  let slot = cellHash(cellX, cellY, hashMask);
  while (true) {
    const ci = hashTable[slot];
    if (ci === HASH_EMPTY) return -1;
    if (cellKeys[ci * 2] === cellX && cellKeys[ci * 2 + 1] === cellY) return ci;
    slot = (slot + 1) & hashMask;
  }
}

interface PendingRequest {
  resolve: (result: FlatPointSpatialIndex | null) => void;
  reject: (reason?: unknown) => void;
  pointData: WsiPointData;
}

function buildFromResponse(msg: PointHitIndexWorkerSuccess, pointData: WsiPointData): FlatPointSpatialIndex | null {
  if (msg.safeCount <= 0 || msg.cellCount <= 0) return null;

  const safeCount = msg.safeCount;
  return {
    cellSize: msg.cellSize,
    safeCount,
    positions: pointData.positions.subarray(0, safeCount * 2),
    ids:
      pointData.ids instanceof Uint32Array && pointData.ids.length >= safeCount
        ? pointData.ids.subarray(0, safeCount)
        : null,
    hashCapacity: msg.hashCapacity,
    hashMask: msg.hashCapacity - 1,
    hashTable: new Int32Array(msg.hashTable),
    cellKeys: new Int32Array(msg.cellKeys),
    cellOffsets: new Uint32Array(msg.cellOffsets),
    cellLengths: new Uint32Array(msg.cellLengths),
    pointIndices: new Uint32Array(msg.pointIndices),
  };
}

const workerClient = new WorkerClient<PointHitIndexWorkerResponse, PendingRequest>(
  () =>
    new Worker(new URL("../workers/point-hit-index-worker.ts", import.meta.url), {
      type: "module",
    }),
  {
    onResponse: (message, pending) => {
      if (message.type === "point-hit-index-failure") {
        pending.reject(new Error(message.error || "worker index build failed"));
        return;
      }
      pending.resolve(buildFromResponse(message, pending.pointData));
    },
    rejectPending: (pending, error) => {
      pending.reject(error);
    },
  },
);

export function terminatePointHitIndexWorker(): void {
  workerClient.terminate("worker terminated");
}

function buildSyncFallback(
  pointData: WsiPointData,
  source: WsiImageSource | null,
): FlatPointSpatialIndex | null {
  const safeCount = sanitizePointCount(pointData);
  if (safeCount <= 0) return null;

  const positions = pointData.positions.subarray(0, safeCount * 2);
  const result = buildPointHitIndex({
    count: safeCount,
    positions,
    drawIndices:
      pointData.drawIndices instanceof Uint32Array ? pointData.drawIndices : null,
    sourceWidth: source?.width ?? 0,
    sourceHeight: source?.height ?? 0,
  });
  if (!result) return null;

  return {
    cellSize: result.cellSize,
    safeCount,
    positions,
    ids:
      pointData.ids instanceof Uint32Array && pointData.ids.length >= safeCount
        ? pointData.ids.subarray(0, safeCount)
        : null,
    hashCapacity: result.hashCapacity,
    hashMask: result.hashCapacity - 1,
    hashTable: result.hashTable,
    cellKeys: result.cellKeys,
    cellOffsets: result.cellOffsets,
    cellLengths: result.cellLengths,
    pointIndices: result.pointIndices,
  };
}

export async function buildPointSpatialIndexAsync(
  pointData: WsiPointData | null | undefined,
  source: WsiImageSource | null,
): Promise<FlatPointSpatialIndex | null> {
  if (!pointData || !pointData.positions || !pointData.paletteIndices) {
    return null;
  }

  const safeCount = sanitizePointCount(pointData);
  if (safeCount <= 0) return null;

  return new Promise<FlatPointSpatialIndex | null>((resolve, reject) => {
    const pending: PendingRequest = {
      resolve,
      reject,
      pointData,
    };
    const requestTicket = workerClient.beginRequest(pending);
    if (!requestTicket || !requestTicket.worker) {
      resolve(buildSyncFallback(pointData, source));
      return;
    }

    const positionsCopy = pointData.positions.slice(0, safeCount * 2);
    const drawIndicesCopy =
      pointData.drawIndices instanceof Uint32Array &&
      pointData.drawIndices.length > 0
        ? pointData.drawIndices.slice()
        : undefined;

    const msg: PointHitIndexWorkerRequest = {
      type: "point-hit-index-request",
      id: requestTicket.id,
      count: safeCount,
      positions: positionsCopy.buffer,
      drawIndices: drawIndicesCopy?.buffer,
      sourceWidth: source?.width ?? 0,
      sourceHeight: source?.height ?? 0,
    };
    const transfer: Transferable[] = [positionsCopy.buffer];
    if (drawIndicesCopy) transfer.push(drawIndicesCopy.buffer);

    try {
      requestTicket.worker.postMessage(msg, transfer);
    } catch (error) {
      const canceled = workerClient.cancelRequest(requestTicket.id);
      if (canceled) {
        canceled.reject(error);
      } else {
        reject(error);
      }
    }
  });
}
