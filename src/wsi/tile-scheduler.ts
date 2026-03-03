import { nowMs } from "./utils";

export type TileBounds = [number, number, number, number];

export interface ScheduledTile {
	key: string;
	tier: number;
	x: number;
	y: number;
	bounds: TileBounds;
	distance2: number;
	url: string;
}

export interface TileSchedulerSnapshot {
	inflight: number;
	queued: number;
	aborted: number;
	retries: number;
	failed: number;
}

export interface TileSchedulerOptions {
	maxConcurrency?: number;
	maxRetries?: number;
	retryBaseDelayMs?: number;
	retryMaxDelayMs?: number;
	authToken?: string;
	onTileLoad: (tile: ScheduledTile, bitmap: ImageBitmap) => void;
	onTileError?: (
		tile: ScheduledTile,
		error: unknown,
		attemptCount: number,
	) => void;
	onStateChange?: (snapshot: TileSchedulerSnapshot) => void;
}

interface QueueItem {
	tile: ScheduledTile;
	attempt: number;
	readyAt: number;
}

interface InflightItem {
	tile: ScheduledTile;
	attempt: number;
	controller: AbortController;
}

function shouldAttachAuthHeader(url: string, authToken: string): boolean {
	if (!authToken) return false;
	try {
		const parsed = new URL(url, typeof window !== "undefined" ? window.location.href : undefined);
		const host = parsed.hostname.toLowerCase();
		const isAwsS3 =
			host.includes("amazonaws.com") || host.startsWith("s3.") || host.includes(".s3.");
		if (isAwsS3) return false;
	} catch {
		// Fallback to attaching auth if URL parsing fails.
	}
	return true;
}

export class TileScheduler {
	private readonly maxConcurrency: number;
	private readonly maxRetries: number;
	private readonly retryBaseDelayMs: number;
	private readonly retryMaxDelayMs: number;
	private readonly onTileLoad: (tile: ScheduledTile, bitmap: ImageBitmap) => void;
	private readonly onTileError?:
		| ((tile: ScheduledTile, error: unknown, attemptCount: number) => void)
		| undefined;
	private readonly onStateChange?:
		| ((snapshot: TileSchedulerSnapshot) => void)
		| undefined;

	private authToken: string;
	private destroyed = false;
	private queue: QueueItem[] = [];
	private queuedByKey = new Map<string, QueueItem>();
	private inflight = new Map<string, InflightItem>();
	private visibleKeys = new Set<string>();
	private timerId: number | null = null;
	private abortedCount = 0;
	private retryCount = 0;
	private failedCount = 0;

	constructor(options: TileSchedulerOptions) {
		this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 12));
		this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2));
		this.retryBaseDelayMs = Math.max(
			10,
			Math.floor(options.retryBaseDelayMs ?? 120),
		);
		this.retryMaxDelayMs = Math.max(
			this.retryBaseDelayMs,
			Math.floor(options.retryMaxDelayMs ?? 1200),
		);
		this.authToken = options.authToken ?? "";
		this.onTileLoad = options.onTileLoad;
		this.onTileError = options.onTileError;
		this.onStateChange = options.onStateChange;
	}

	setAuthToken(token: string): void {
		this.authToken = String(token ?? "");
	}

	schedule(tiles: readonly ScheduledTile[]): void {
		if (this.destroyed) return;

		const nextVisibleKeys = new Set<string>();
		for (const tile of tiles) {
			nextVisibleKeys.add(tile.key);
		}
		this.visibleKeys = nextVisibleKeys;

		this.dropInvisibleQueued(nextVisibleKeys);
		this.abortInvisibleInflight(nextVisibleKeys);

		for (const tile of tiles) {
			if (this.inflight.has(tile.key)) {
				const inflight = this.inflight.get(tile.key);
				if (inflight) inflight.tile = tile;
				continue;
			}

			const queued = this.queuedByKey.get(tile.key);
			if (queued) {
				queued.tile = tile;
				continue;
			}

			const item: QueueItem = {
				tile,
				attempt: 0,
				readyAt: nowMs(),
			};
			this.queue.push(item);
			this.queuedByKey.set(tile.key, item);
		}

		this.sortQueue();
		this.pump();
		this.emitStateChange();
	}

	clear(): void {
		this.clearPumpTimer();
		this.visibleKeys.clear();
		this.queue = [];
		this.queuedByKey.clear();

		for (const [, item] of this.inflight) {
			item.controller.abort();
		}
		this.inflight.clear();
		this.emitStateChange();
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.clear();
	}

	getInflightCount(): number {
		return this.inflight.size;
	}

	getSnapshot(): TileSchedulerSnapshot {
		return {
			inflight: this.inflight.size,
			queued: this.queue.length,
			aborted: this.abortedCount,
			retries: this.retryCount,
			failed: this.failedCount,
		};
	}

	private dropInvisibleQueued(visibleKeys: Set<string>): void {
		if (this.queue.length === 0) return;
		const nextQueue: QueueItem[] = [];
		for (const item of this.queue) {
			if (!visibleKeys.has(item.tile.key)) {
				this.queuedByKey.delete(item.tile.key);
				continue;
			}
			nextQueue.push(item);
		}
		this.queue = nextQueue;
	}

	private abortInvisibleInflight(visibleKeys: Set<string>): void {
		for (const [key, item] of this.inflight) {
			if (visibleKeys.has(key)) continue;
			this.inflight.delete(key);
			this.abortedCount += 1;
			item.controller.abort();
		}
	}

	private sortQueue(): void {
		this.queue.sort((a, b) => {
			if (a.readyAt !== b.readyAt) return a.readyAt - b.readyAt;
			if (a.tile.distance2 !== b.tile.distance2) {
				return a.tile.distance2 - b.tile.distance2;
			}
			if (a.tile.tier !== b.tile.tier) return b.tile.tier - a.tile.tier;
			return a.tile.key.localeCompare(b.tile.key);
		});
	}

	private pump(): void {
		if (this.destroyed) return;
		this.clearPumpTimer();

		while (this.inflight.size < this.maxConcurrency) {
			const next = this.takeNextReadyQueueItem();
			if (!next) break;
			this.startFetch(next);
		}

		if (this.inflight.size >= this.maxConcurrency) {
			return;
		}

		if (this.queue.length === 0) return;

		const earliestReadyAt = this.queue[0]?.readyAt;
		if (typeof earliestReadyAt !== "number") return;
		const delay = Math.max(0, earliestReadyAt - nowMs());
		this.timerId = window.setTimeout(() => {
			this.timerId = null;
			this.pump();
		}, delay);
	}

	private takeNextReadyQueueItem(): QueueItem | null {
		if (this.queue.length === 0) return null;
		const now = nowMs();
		const first = this.queue[0];
		if (!first || first.readyAt > now) return null;

		this.queue.shift();
		this.queuedByKey.delete(first.tile.key);
		return first;
	}

	private startFetch(item: QueueItem): void {
		const controller = new AbortController();
		const inflightEntry: InflightItem = {
			tile: item.tile,
			attempt: item.attempt,
			controller,
		};
		this.inflight.set(item.tile.key, inflightEntry);
		this.emitStateChange();

		const useAuthHeader = shouldAttachAuthHeader(item.tile.url, this.authToken);
		fetch(item.tile.url, {
			signal: controller.signal,
			headers: useAuthHeader ? { Authorization: this.authToken } : undefined,
		})
			.then((response) => {
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}
				return response.blob();
			})
			.then((blob) => createImageBitmap(blob))
			.then((bitmap) => {
				if (this.destroyed || controller.signal.aborted) {
					bitmap.close();
					return;
				}
				if (!this.visibleKeys.has(item.tile.key)) {
					bitmap.close();
					return;
				}
				this.onTileLoad(item.tile, bitmap);
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted || this.destroyed) {
					return;
				}

				const shouldRetry =
					item.attempt < this.maxRetries && this.visibleKeys.has(item.tile.key);
				if (shouldRetry) {
					this.retryCount += 1;
					const nextAttempt = item.attempt + 1;
					const retryDelay = this.getRetryDelay(nextAttempt);
					const queued: QueueItem = {
						tile: item.tile,
						attempt: nextAttempt,
						readyAt: nowMs() + retryDelay,
					};
					const existing = this.queuedByKey.get(item.tile.key);
					if (existing) {
						existing.tile = queued.tile;
						existing.readyAt = Math.min(existing.readyAt, queued.readyAt);
						existing.attempt = Math.max(existing.attempt, queued.attempt);
					} else {
						this.queue.push(queued);
						this.queuedByKey.set(queued.tile.key, queued);
					}
					this.sortQueue();
					return;
				}

				this.failedCount += 1;
				this.onTileError?.(item.tile, error, item.attempt + 1);
			})
			.finally(() => {
				this.inflight.delete(item.tile.key);
				this.pump();
				this.emitStateChange();
			});
	}

	private getRetryDelay(attempt: number): number {
		const exp = Math.max(0, attempt - 1);
		const delay = Math.min(
			this.retryMaxDelayMs,
			this.retryBaseDelayMs * 2 ** exp,
		);
		const jitter = 0.85 + Math.random() * 0.3;
		return Math.round(delay * jitter);
	}

	private clearPumpTimer(): void {
		if (this.timerId === null) return;
		window.clearTimeout(this.timerId);
		this.timerId = null;
	}

	private emitStateChange(): void {
		this.onStateChange?.(this.getSnapshot());
	}
}
