import type {
  RoiClipWorkerDataRequest,
  RoiClipWorkerIndexRequest,
  RoiClipWorkerIndexSuccess,
  RoiClipWorkerRequest,
  RoiClipWorkerResponse,
  RoiClipWorkerSuccess,
} from "../wsi/point-clip-worker-protocol";
import { pointInAnyPreparedPolygon, prepareRoiPolygons } from "../wsi/roi-geometry";
import { nowMs } from "../wsi/utils";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown worker error";
  }
}

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<RoiClipWorkerRequest>) => void): void;
}

const workerScope = self as unknown as WorkerScope;

function handleDataRequest(msg: RoiClipWorkerDataRequest): RoiClipWorkerSuccess {
  const start = nowMs();
  const count = Math.max(0, Math.floor(msg.count));
  const positions = new Float32Array(msg.positions);
  const terms = new Uint16Array(msg.paletteIndices);
  const fillModes = msg.fillModes ? new Uint8Array(msg.fillModes) : null;
  const ids = msg.ids ? new Uint32Array(msg.ids) : null;

  const maxCountByPositions = Math.floor(positions.length / 2);
  const safeCount = Math.max(0, Math.min(count, maxCountByPositions, terms.length, fillModes ? fillModes.length : Number.MAX_SAFE_INTEGER));
  const hasFillModes = fillModes instanceof Uint8Array && fillModes.length >= safeCount;
  const hasIds = ids instanceof Uint32Array && ids.length >= safeCount;
  const prepared = prepareRoiPolygons(msg.polygons ?? []);

  if (safeCount === 0 || prepared.length === 0) {
    const empty: RoiClipWorkerSuccess = {
      type: "roi-clip-success",
      id: msg.id,
      count: 0,
      positions: new Float32Array(0).buffer,
      paletteIndices: new Uint16Array(0).buffer,
      durationMs: nowMs() - start,
    };
    if (hasFillModes) {
      empty.fillModes = new Uint8Array(0).buffer;
    }
    if (hasIds) {
      empty.ids = new Uint32Array(0).buffer;
    }
    return empty;
  }

  const nextPositions = new Float32Array(safeCount * 2);
  const nextTerms = new Uint16Array(safeCount);
  const nextFillModes = hasFillModes ? new Uint8Array(safeCount) : null;
  const nextIds = hasIds ? new Uint32Array(safeCount) : null;
  let cursor = 0;

  for (let i = 0; i < safeCount; i += 1) {
    const x = positions[i * 2];
    const y = positions[i * 2 + 1];
    if (!pointInAnyPreparedPolygon(x, y, prepared)) continue;
    nextPositions[cursor * 2] = x;
    nextPositions[cursor * 2 + 1] = y;
    nextTerms[cursor] = terms[i];
    if (nextFillModes) {
      nextFillModes[cursor] = fillModes![i];
    }
    if (nextIds) {
      nextIds[cursor] = ids![i];
    }
    cursor += 1;
  }

  const outPositions = nextPositions.slice(0, cursor * 2);
  const outTerms = nextTerms.slice(0, cursor);
  const outFillModes = nextFillModes ? nextFillModes.slice(0, cursor) : null;
  const outIds = nextIds ? nextIds.slice(0, cursor) : null;

  const success: RoiClipWorkerSuccess = {
    type: "roi-clip-success",
    id: msg.id,
    count: cursor,
    positions: outPositions.buffer,
    paletteIndices: outTerms.buffer,
    durationMs: nowMs() - start,
  };
  if (outFillModes) {
    success.fillModes = outFillModes.buffer;
  }
  if (outIds) {
    success.ids = outIds.buffer;
  }
  return success;
}

function handleIndexRequest(msg: RoiClipWorkerIndexRequest): RoiClipWorkerIndexSuccess {
  const start = nowMs();
  const count = Math.max(0, Math.floor(msg.count));
  const positions = new Float32Array(msg.positions);
  const maxCountByPositions = Math.floor(positions.length / 2);
  const safeCount = Math.max(0, Math.min(count, maxCountByPositions));
  const prepared = prepareRoiPolygons(msg.polygons ?? []);

  if (safeCount === 0 || prepared.length === 0) {
    return {
      type: "roi-clip-index-success",
      id: msg.id,
      count: 0,
      indices: new Uint32Array(0).buffer,
      durationMs: nowMs() - start,
    };
  }

  const out = new Uint32Array(safeCount);
  let cursor = 0;
  for (let i = 0; i < safeCount; i += 1) {
    const x = positions[i * 2];
    const y = positions[i * 2 + 1];
    if (!pointInAnyPreparedPolygon(x, y, prepared)) continue;
    out[cursor] = i;
    cursor += 1;
  }

  const outIndices = out.slice(0, cursor);
  return {
    type: "roi-clip-index-success",
    id: msg.id,
    count: cursor,
    indices: outIndices.buffer,
    durationMs: nowMs() - start,
  };
}

workerScope.addEventListener("message", (event: MessageEvent<RoiClipWorkerRequest>) => {
  const data = event.data;
  if (!data || (data.type !== "roi-clip-request" && data.type !== "roi-clip-index-request")) return;

  try {
    if (data.type === "roi-clip-index-request") {
      const response = handleIndexRequest(data);
      workerScope.postMessage(response, [response.indices]);
      return;
    }
    const response = handleDataRequest(data);
    const transfer: Transferable[] = [response.positions, response.paletteIndices];
    if (response.fillModes) {
      transfer.push(response.fillModes);
    }
    if (response.ids) {
      transfer.push(response.ids);
    }
    workerScope.postMessage(response, transfer);
  } catch (error) {
    const fail: RoiClipWorkerResponse = {
      type: "roi-clip-failure",
      id: data.id,
      error: toErrorMessage(error),
    };
    workerScope.postMessage(fail);
  }
});
