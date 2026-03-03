import { buildPointHitIndex } from "../wsi/point-hit-index-shared";
import type {
  PointHitIndexWorkerRequest,
  PointHitIndexWorkerResponse,
  PointHitIndexWorkerSuccess,
} from "../wsi/point-hit-index-worker-protocol";
import { nowMs } from "../wsi/utils";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown worker error";
  }
}

function handleRequest(msg: PointHitIndexWorkerRequest): PointHitIndexWorkerSuccess | null {
  const start = nowMs();
  const result = buildPointHitIndex({
    count: msg.count,
    positions: new Float32Array(msg.positions),
    drawIndices: msg.drawIndices ? new Uint32Array(msg.drawIndices) : null,
    sourceWidth: msg.sourceWidth,
    sourceHeight: msg.sourceHeight,
  });

  if (!result) {
    return null;
  }

  return {
    type: "point-hit-index-success",
    id: msg.id,
    cellSize: result.cellSize,
    safeCount: result.safeCount,
    cellCount: result.cellCount,
    hashCapacity: result.hashCapacity,
    hashTable: result.hashTable.buffer as ArrayBuffer,
    cellKeys: result.cellKeys.buffer as ArrayBuffer,
    cellOffsets: result.cellOffsets.buffer as ArrayBuffer,
    cellLengths: result.cellLengths.buffer as ArrayBuffer,
    pointIndices: result.pointIndices.buffer as ArrayBuffer,
    durationMs: nowMs() - start,
  };
}

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<PointHitIndexWorkerRequest>) => void): void;
}

const workerScope = self as unknown as WorkerScope;

workerScope.addEventListener("message", (event: MessageEvent<PointHitIndexWorkerRequest>) => {
  const data = event.data;
  if (!data || data.type !== "point-hit-index-request") return;

  try {
    const result = handleRequest(data);
    if (!result) {
      const empty: PointHitIndexWorkerSuccess = {
        type: "point-hit-index-success",
        id: data.id,
        cellSize: 0,
        safeCount: 0,
        cellCount: 0,
        hashCapacity: 0,
        hashTable: new Int32Array(0).buffer,
        cellKeys: new Int32Array(0).buffer,
        cellOffsets: new Uint32Array(0).buffer,
        cellLengths: new Uint32Array(0).buffer,
        pointIndices: new Uint32Array(0).buffer,
        durationMs: 0,
      };
      workerScope.postMessage(empty, [
        empty.hashTable,
        empty.cellKeys,
        empty.cellOffsets,
        empty.cellLengths,
        empty.pointIndices,
      ]);
      return;
    }

    workerScope.postMessage(result, [
      result.hashTable,
      result.cellKeys,
      result.cellOffsets,
      result.cellLengths,
      result.pointIndices,
    ]);
  } catch (error) {
    const fail: PointHitIndexWorkerResponse = {
      type: "point-hit-index-failure",
      id: data.id,
      error: toErrorMessage(error),
    };
    workerScope.postMessage(fail);
  }
});
