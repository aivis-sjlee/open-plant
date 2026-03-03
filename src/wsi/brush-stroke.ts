import { closeRoiRing as closeRing, polygonSignedArea } from "./roi-geometry";
import { clamp } from "./utils";

export type BrushStrokeCoordinate = [number, number];
export type BrushStrokeBounds = [number, number, number, number];

export interface BrushStrokePolygonOptions {
	radius: number;
	clipBounds?: BrushStrokeBounds;
	minRasterStep?: number;
	maxRasterPixels?: number;
	maxRasterSize?: number;
	simplifyTolerance?: number;
	circleSides?: number;
	smoothingPasses?: number;
}

interface RasterConfig {
	minX: number;
	minY: number;
	step: number;
	padding: number;
	width: number;
	height: number;
}

interface BoundaryEdge {
	start: number;
	end: number;
	dir: 0 | 1 | 2 | 3;
}

const DEFAULT_MIN_RASTER_STEP = 0.1;
const DEFAULT_MAX_RASTER_PIXELS = 4_000_000;
const DEFAULT_MAX_RASTER_SIZE = 4096;
const DEFAULT_CIRCLE_SIDES = 64;
const DEFAULT_SMOOTHING_PASSES = 1;
const MAX_SMOOTHING_PASSES = 4;
const MIN_RADIUS = 1e-6;
const ALPHA_THRESHOLD = 24;

function sanitizePath(
	points: BrushStrokeCoordinate[],
): BrushStrokeCoordinate[] {
	if (!Array.isArray(points) || points.length === 0) return [];
	const out: BrushStrokeCoordinate[] = [];
	for (const point of points) {
		if (!Array.isArray(point) || point.length < 2) continue;
		const x = Number(point[0]);
		const y = Number(point[1]);
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		const prev = out[out.length - 1];
		if (prev && Math.abs(prev[0] - x) < 1e-9 && Math.abs(prev[1] - y) < 1e-9) {
			continue;
		}
		out.push([x, y]);
	}
	return out;
}

function createCirclePolygon(
	center: BrushStrokeCoordinate,
	radius: number,
	sides: number,
): BrushStrokeCoordinate[] {
	if (radius <= MIN_RADIUS || sides < 8) return [];
	const ring: BrushStrokeCoordinate[] = [];
	for (let i = 0; i <= sides; i += 1) {
		const t = (i / sides) * Math.PI * 2;
		ring.push([
			center[0] + Math.cos(t) * radius,
			center[1] + Math.sin(t) * radius,
		]);
	}
	return closeRing(ring);
}

function createBoundsFallback(
	points: BrushStrokeCoordinate[],
	radius: number,
): BrushStrokeCoordinate[] {
	if (!points.length) return [];
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of points) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	if (!Number.isFinite(minX) || !Number.isFinite(minY)) return [];
	const pad = Math.max(radius, 1);
	return closeRing([
		[minX - pad, minY - pad],
		[maxX + pad, minY - pad],
		[maxX + pad, maxY + pad],
		[minX - pad, maxY + pad],
	]);
}

function computeExpandedBounds(
	points: BrushStrokeCoordinate[],
	radius: number,
): BrushStrokeBounds {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of points) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	const pad = Math.max(radius, 1);
	return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

function resolveRasterConfig(
	bounds: BrushStrokeBounds,
	radius: number,
	options: BrushStrokePolygonOptions,
): RasterConfig {
	const minRasterStep = Math.max(
		DEFAULT_MIN_RASTER_STEP,
		Number(options.minRasterStep) || 0,
	);
	const maxRasterPixels = Math.max(
		32_768,
		Math.floor(options.maxRasterPixels || DEFAULT_MAX_RASTER_PIXELS),
	);
	const maxRasterSize = Math.max(
		256,
		Math.floor(options.maxRasterSize || DEFAULT_MAX_RASTER_SIZE),
	);

	const widthWorld = Math.max(1e-3, bounds[2] - bounds[0]);
	const heightWorld = Math.max(1e-3, bounds[3] - bounds[1]);
	let step = Math.max(minRasterStep, Number.EPSILON);
	let padding = 3;
	let width = Math.ceil(widthWorld / step) + padding * 2 + 1;
	let height = Math.ceil(heightWorld / step) + padding * 2 + 1;

	while (
		width > maxRasterSize ||
		height > maxRasterSize ||
		width * height > maxRasterPixels
	) {
		step *= 1.15;
		width = Math.ceil(widthWorld / step) + padding * 2 + 1;
		height = Math.ceil(heightWorld / step) + padding * 2 + 1;
		if (step > Math.max(widthWorld, heightWorld)) {
			break;
		}
	}

	width = Math.max(8, width);
	height = Math.max(8, height);

	return {
		minX: bounds[0],
		minY: bounds[1],
		step,
		padding,
		width,
		height,
	};
}

type AnyCanvas2DContext =
	| CanvasRenderingContext2D
	| OffscreenCanvasRenderingContext2D;

function createRasterContext(
	width: number,
	height: number,
): AnyCanvas2DContext | null {
	if (typeof OffscreenCanvas !== "undefined") {
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (context) return context;
	}
	if (typeof document !== "undefined") {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		return canvas.getContext("2d", { willReadFrequently: true });
	}
	return null;
}

function worldToRaster(
	point: BrushStrokeCoordinate,
	config: RasterConfig,
): BrushStrokeCoordinate {
	return [
		(point[0] - config.minX) / config.step + config.padding,
		(point[1] - config.minY) / config.step + config.padding,
	];
}

function rasterizeStrokeMask(
	path: BrushStrokeCoordinate[],
	radius: number,
	config: RasterConfig,
): Uint8Array {
	const context = createRasterContext(config.width, config.height);
	if (!context) return new Uint8Array(0);

	context.clearRect(0, 0, config.width, config.height);
	context.fillStyle = "#ffffff";
	context.strokeStyle = "#ffffff";
	context.lineCap = "round";
	context.lineJoin = "round";
	context.lineWidth = (radius * 2) / config.step;

	const points = path.map(point => worldToRaster(point, config));
	if (points.length <= 1) {
		const p = points[0];
		if (!p) return new Uint8Array(0);
		context.beginPath();
		context.arc(p[0], p[1], radius / config.step, 0, Math.PI * 2);
		context.fill();
	} else {
		context.beginPath();
		context.moveTo(points[0][0], points[0][1]);
		for (let i = 1; i < points.length; i += 1) {
			context.lineTo(points[i][0], points[i][1]);
		}
		context.stroke();
	}

	const image = context.getImageData(0, 0, config.width, config.height);
	const out = new Uint8Array(config.width * config.height);
	for (let i = 0; i < out.length; i += 1) {
		out[i] = image.data[i * 4 + 3] >= ALPHA_THRESHOLD ? 1 : 0;
	}
	return out;
}

function buildBoundaryEdges(mask: Uint8Array, width: number, height: number): BoundaryEdge[] {
	const edges: BoundaryEdge[] = [];
	const stride = width + 1;
	const vertex = (x: number, y: number): number => y * stride + x;
	const at = (x: number, y: number): boolean =>
		x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] > 0;

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (!at(x, y)) continue;
			if (!at(x, y - 1)) {
				edges.push({
					start: vertex(x, y),
					end: vertex(x + 1, y),
					dir: 0,
				});
			}
			if (!at(x + 1, y)) {
				edges.push({
					start: vertex(x + 1, y),
					end: vertex(x + 1, y + 1),
					dir: 1,
				});
			}
			if (!at(x, y + 1)) {
				edges.push({
					start: vertex(x + 1, y + 1),
					end: vertex(x, y + 1),
					dir: 2,
				});
			}
			if (!at(x - 1, y)) {
				edges.push({
					start: vertex(x, y + 1),
					end: vertex(x, y),
					dir: 3,
				});
			}
		}
	}

	return edges;
}

function turnPriority(fromDir: number, toDir: number): number {
	const delta = (toDir - fromDir + 4) % 4;
	if (delta === 1) return 0; // right
	if (delta === 0) return 1; // straight
	if (delta === 3) return 2; // left
	return 3; // reverse
}

function traceLoops(edges: BoundaryEdge[]): number[][] {
	if (!edges.length) return [];

	const outgoing = new Map<number, number[]>();
	for (let i = 0; i < edges.length; i += 1) {
		const entry = outgoing.get(edges[i].start);
		if (entry) {
			entry.push(i);
		} else {
			outgoing.set(edges[i].start, [i]);
		}
	}

	const used = new Uint8Array(edges.length);
	const loops: number[][] = [];

	for (let i = 0; i < edges.length; i += 1) {
		if (used[i]) continue;

		const first = edges[i];
		const startVertex = first.start;
		let currentVertex = first.end;
		let currentDir = first.dir;
		const loop: number[] = [first.start, first.end];
		used[i] = 1;

		let guard = 0;
		const guardLimit = edges.length * 3;
		while (currentVertex !== startVertex && guard < guardLimit) {
			const candidates = outgoing.get(currentVertex);
			if (!candidates || candidates.length === 0) break;

			let bestIndex = -1;
			let bestPriority = Infinity;
			for (const edgeIndex of candidates) {
				if (used[edgeIndex]) continue;
				const candidate = edges[edgeIndex];
				const priority = turnPriority(currentDir, candidate.dir);
				if (priority < bestPriority) {
					bestPriority = priority;
					bestIndex = edgeIndex;
				}
			}

			if (bestIndex < 0) break;
			used[bestIndex] = 1;
			const next = edges[bestIndex];
			currentVertex = next.end;
			currentDir = next.dir;
			loop.push(currentVertex);
			guard += 1;
		}

		if (
			loop.length >= 4 &&
			loop[0] === loop[loop.length - 1]
		) {
			loops.push(loop);
		}
	}

	return loops;
}

function toWorldRing(
	vertexLoop: number[],
	width: number,
	config: RasterConfig,
): BrushStrokeCoordinate[] {
	const stride = width + 1;
	const ring: BrushStrokeCoordinate[] = [];
	for (const id of vertexLoop) {
		const x = id % stride;
		const y = Math.floor(id / stride);
		ring.push([
			config.minX + (x - config.padding) * config.step,
			config.minY + (y - config.padding) * config.step,
		]);
	}
	return closeRing(ring);
}

function removeCollinearVertices(
	ring: BrushStrokeCoordinate[],
	epsilon = 1e-9,
): BrushStrokeCoordinate[] {
	const closed = closeRing(ring);
	if (closed.length < 5) return closed;
	const out: BrushStrokeCoordinate[] = [closed[0]];
	for (let i = 1; i < closed.length - 1; i += 1) {
		const prev = out[out.length - 1];
		const curr = closed[i];
		const next = closed[i + 1];
		const cross =
			(curr[0] - prev[0]) * (next[1] - curr[1]) -
			(curr[1] - prev[1]) * (next[0] - curr[0]);
		if (Math.abs(cross) <= epsilon) continue;
		out.push(curr);
	}
	out.push(out[0]);
	return closeRing(out);
}

function pointLineDistanceSquared(
	p: BrushStrokeCoordinate,
	a: BrushStrokeCoordinate,
	b: BrushStrokeCoordinate,
): number {
	const abx = b[0] - a[0];
	const aby = b[1] - a[1];
	const len2 = abx * abx + aby * aby;
	if (len2 <= 1e-12) {
		const dx = p[0] - a[0];
		const dy = p[1] - a[1];
		return dx * dx + dy * dy;
	}
	const t = clamp(
		((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2,
		0,
		1,
	);
	const x = a[0] + abx * t;
	const y = a[1] + aby * t;
	const dx = p[0] - x;
	const dy = p[1] - y;
	return dx * dx + dy * dy;
}

function simplifyRdp(
	points: BrushStrokeCoordinate[],
	tolerance: number,
): BrushStrokeCoordinate[] {
	if (points.length <= 2 || tolerance <= 0) return points.slice();

	const keep = new Uint8Array(points.length);
	keep[0] = 1;
	keep[points.length - 1] = 1;
	const tolerance2 = tolerance * tolerance;
	const stack: Array<[number, number]> = [[0, points.length - 1]];

	while (stack.length > 0) {
		const next = stack.pop();
		if (!next) break;
		const [start, end] = next;
		if (end - start <= 1) continue;

		let maxDist2 = 0;
		let split = -1;
		for (let i = start + 1; i < end; i += 1) {
			const dist2 = pointLineDistanceSquared(points[i], points[start], points[end]);
			if (dist2 > maxDist2) {
				maxDist2 = dist2;
				split = i;
			}
		}

		if (split >= 0 && maxDist2 > tolerance2) {
			keep[split] = 1;
			stack.push([start, split], [split, end]);
		}
	}

	const out: BrushStrokeCoordinate[] = [];
	for (let i = 0; i < points.length; i += 1) {
		if (keep[i]) out.push(points[i]);
	}
	return out;
}

function simplifyClosedRing(
	ring: BrushStrokeCoordinate[],
	tolerance: number,
): BrushStrokeCoordinate[] {
	const closed = closeRing(ring);
	if (closed.length < 5 || tolerance <= 0) return closed;
	const open = closed.slice(0, -1);
	const simplified = simplifyRdp(open, tolerance);
	if (simplified.length < 3) return closed;
	return closeRing(simplified);
}

function smoothClosedRingChaikin(
	ring: BrushStrokeCoordinate[],
	iterations: number,
): BrushStrokeCoordinate[] {
	let out = closeRing(ring);
	if (iterations <= 0 || out.length < 5) return out;

	for (let pass = 0; pass < iterations; pass += 1) {
		const open = out.slice(0, -1);
		if (open.length < 3) break;
		const next: BrushStrokeCoordinate[] = [];
		for (let i = 0; i < open.length; i += 1) {
			const a = open[i];
			const b = open[(i + 1) % open.length];
			next.push(
				[a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25],
				[a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75],
			);
		}
		out = closeRing(next);
	}
	return out;
}

function clampRingToBounds(
	ring: BrushStrokeCoordinate[],
	bounds: BrushStrokeBounds | undefined,
): BrushStrokeCoordinate[] {
	if (!bounds) return ring;
	return closeRing(
		ring.map(([x, y]) => [
			clamp(x, bounds[0], bounds[2]),
			clamp(y, bounds[1], bounds[3]),
		] as BrushStrokeCoordinate),
	);
}

export function buildBrushStrokePolygon(
	path: BrushStrokeCoordinate[],
	options: BrushStrokePolygonOptions,
): BrushStrokeCoordinate[] {
	const points = sanitizePath(path);
	const radius = Math.max(MIN_RADIUS, Number(options.radius) || 0);
	if (points.length === 0 || !Number.isFinite(radius)) return [];

	const circleSides = Math.max(12, Math.floor(options.circleSides || DEFAULT_CIRCLE_SIDES));
	if (points.length === 1) {
		return clampRingToBounds(
			createCirclePolygon(points[0], radius, circleSides),
			options.clipBounds,
		);
	}

	const bounds = computeExpandedBounds(points, radius);
	const raster = resolveRasterConfig(bounds, radius, options);
	const mask = rasterizeStrokeMask(points, radius, raster);
	if (!mask.length) {
		return clampRingToBounds(createBoundsFallback(points, radius), options.clipBounds);
	}

	const edges = buildBoundaryEdges(mask, raster.width, raster.height);
	const loops = traceLoops(edges);
	if (!loops.length) {
		return clampRingToBounds(createBoundsFallback(points, radius), options.clipBounds);
	}

	let bestRing: BrushStrokeCoordinate[] = [];
	let bestArea = 0;
	for (const loop of loops) {
		const ring = toWorldRing(loop, raster.width, raster);
		const area = Math.abs(polygonSignedArea(ring));
		if (area <= bestArea) continue;
		bestArea = area;
		bestRing = ring;
	}

	if (!bestRing.length) {
		return clampRingToBounds(createBoundsFallback(points, radius), options.clipBounds);
	}

	const tolerance =
		typeof options.simplifyTolerance === "number" && Number.isFinite(options.simplifyTolerance)
			? Math.max(0, options.simplifyTolerance)
			: raster.step * 0.2;
	const smoothingPasses =
		typeof options.smoothingPasses === "number" && Number.isFinite(options.smoothingPasses)
			? Math.round(clamp(options.smoothingPasses, 0, MAX_SMOOTHING_PASSES))
			: DEFAULT_SMOOTHING_PASSES;
	const simplified = simplifyClosedRing(
		smoothClosedRingChaikin(
			removeCollinearVertices(bestRing, raster.step * 1e-3),
			smoothingPasses,
		),
		tolerance,
	);
	return clampRingToBounds(simplified, options.clipBounds);
}
