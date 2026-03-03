import { filterPointDataByPolygons, filterPointIndicesByPolygons, type RoiPolygon } from "./point-clip";
import type { RoiClipWorkerRequest, RoiClipWorkerResponse } from "./point-clip-worker-protocol";
import type { WsiPointData } from "./types";
import { nowMs, sanitizePointCount } from "./utils";
import { WorkerClient } from "./worker-client";

export type PointClipMode = "sync" | "worker" | "hybrid-webgpu";

export interface PointClipResultMeta {
  mode: PointClipMode;
  durationMs: number;
}

export interface PointClipResult {
  data: WsiPointData | null;
  meta: PointClipResultMeta;
}

export interface PointClipIndexResult {
  indices: Uint32Array;
  meta: PointClipResultMeta;
}

interface PendingDataWorkerRequest {
  kind: "data";
  resolve: (result: PointClipResult) => void;
  reject: (reason?: unknown) => void;
  startMs: number;
}

interface PendingIndexWorkerRequest {
  kind: "index";
  resolve: (result: PointClipIndexResult) => void;
  reject: (reason?: unknown) => void;
  startMs: number;
}

type PendingWorkerRequest = PendingDataWorkerRequest | PendingIndexWorkerRequest;

const workerClient = new WorkerClient<RoiClipWorkerResponse, PendingWorkerRequest>(
  () => new Worker(new URL("../workers/roi-clip-worker.ts", import.meta.url), { type: "module" }),
  {
    onResponse: (msg, pending) => {
      if (msg.type === "roi-clip-failure") {
        pending.reject(new Error(msg.error || "worker clip failed"));
        return;
      }

      if (msg.type === "roi-clip-index-success") {
        if (pending.kind !== "index") {
          pending.reject(new Error("worker response mismatch: expected point data result"));
          return;
        }
        const count = Math.max(0, Math.floor(msg.count));
        const indices = new Uint32Array(msg.indices).subarray(0, count);
        pending.resolve({
          indices,
          meta: {
            mode: "worker",
            durationMs:
              Number.isFinite(msg.durationMs)
                ? msg.durationMs
                : nowMs() - pending.startMs,
          },
        });
        return;
      }

      if (pending.kind !== "data") {
        pending.reject(new Error("worker response mismatch: expected index result"));
        return;
      }

      const count = Math.max(0, Math.floor(msg.count));
      const positions = new Float32Array(msg.positions);
      const paletteIndices = new Uint16Array(msg.paletteIndices);
      const fillModes = msg.fillModes ? new Uint8Array(msg.fillModes) : null;
      const ids = msg.ids ? new Uint32Array(msg.ids) : null;
      const output: WsiPointData = {
        count,
        positions: positions.subarray(0, count * 2),
        paletteIndices: paletteIndices.subarray(0, count),
      };
      if (fillModes) {
        output.fillModes = fillModes.subarray(0, count);
      }
      if (ids) {
        output.ids = ids.subarray(0, count);
      }

      pending.resolve({
        data: output,
        meta: {
          mode: "worker",
          durationMs:
            Number.isFinite(msg.durationMs)
              ? msg.durationMs
              : nowMs() - pending.startMs,
        },
      });
    },
    rejectPending: (pending, error) => {
      pending.reject(error);
    },
  },
);

export function terminateRoiClipWorker(): void {
  workerClient.terminate("worker terminated");
}

export async function filterPointDataByPolygonsInWorker(pointData: WsiPointData | null | undefined, polygons: RoiPolygon[] | null | undefined): Promise<PointClipResult> {
  if (!pointData || !pointData.count || !pointData.positions || !pointData.paletteIndices) {
    return {
      data: null,
      meta: { mode: "worker", durationMs: 0 },
    };
  }

  const safeCount = sanitizePointCount(pointData);
  const positionsCopy = pointData.positions.slice(0, safeCount * 2);
  const termsCopy = pointData.paletteIndices.slice(0, safeCount);
  const fillModesCopy = pointData.fillModes instanceof Uint8Array && pointData.fillModes.length >= safeCount ? pointData.fillModes.slice(0, safeCount) : null;
  const idsCopy = pointData.ids instanceof Uint32Array && pointData.ids.length >= safeCount ? pointData.ids.slice(0, safeCount) : null;

  return new Promise<PointClipResult>((resolve, reject) => {
    const startMs = nowMs();
    const requestTicket = workerClient.beginRequest({
      kind: "data",
      resolve,
      reject,
      startMs,
    });

    if (!requestTicket) {
      resolve({
        data: filterPointDataByPolygons(pointData, polygons),
        meta: { mode: "sync", durationMs: nowMs() - startMs },
      });
      return;
    }

    const msg: RoiClipWorkerRequest = {
      type: "roi-clip-request",
      id: requestTicket.id,
      count: safeCount,
      positions: positionsCopy.buffer,
      paletteIndices: termsCopy.buffer,
      fillModes: fillModesCopy?.buffer,
      ids: idsCopy?.buffer,
      polygons: polygons ?? [],
    };

    const transfer: Transferable[] = [positionsCopy.buffer, termsCopy.buffer];
    if (fillModesCopy) transfer.push(fillModesCopy.buffer);
    if (idsCopy) transfer.push(idsCopy.buffer);

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

export async function filterPointIndicesByPolygonsInWorker(pointData: WsiPointData | null | undefined, polygons: RoiPolygon[] | null | undefined): Promise<PointClipIndexResult> {
  if (!pointData || !pointData.count || !pointData.positions || !pointData.paletteIndices) {
    return {
      indices: new Uint32Array(0),
      meta: { mode: "worker", durationMs: 0 },
    };
  }

  const safeCount = sanitizePointCount(pointData);
  const positionsCopy = pointData.positions.slice(0, safeCount * 2);

  return new Promise<PointClipIndexResult>((resolve, reject) => {
    const startMs = nowMs();
    const requestTicket = workerClient.beginRequest({
      kind: "index",
      resolve,
      reject,
      startMs,
    });

    if (!requestTicket) {
      resolve({
        indices: filterPointIndicesByPolygons(pointData, polygons),
        meta: { mode: "sync", durationMs: nowMs() - startMs },
      });
      return;
    }

    const msg: RoiClipWorkerRequest = {
      type: "roi-clip-index-request",
      id: requestTicket.id,
      count: safeCount,
      positions: positionsCopy.buffer,
      polygons: polygons ?? [],
    };

    try {
      requestTicket.worker.postMessage(msg, [positionsCopy.buffer]);
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
