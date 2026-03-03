import { DEFAULT_POINT_COLOR } from "./constants";
import type { TermPalette, WsiPointData, WsiViewState } from "./types";

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function calcScaleResolution(
	imageMpp: number,
	imageZoom: number,
	currentZoom: number,
): number {
	const mpp = Number(imageMpp);
	const z0 = Number(imageZoom);
	const z1 = Number(currentZoom);
	if (!Number.isFinite(mpp) || mpp <= 0) return 1;
	if (!Number.isFinite(z0) || !Number.isFinite(z1)) return mpp;
	return Math.pow(2, z0 - z1) * mpp;
}

export function calcScaleLength(
	imageMpp: number,
	imageZoom: number,
	currentZoom: number,
): string {
	const resolution = calcScaleResolution(imageMpp, imageZoom, currentZoom);
	let length = 100 * resolution;
	if (Number(imageMpp)) {
		let unit = "μm";
		if (length > 1000) {
			length /= 1000;
			unit = "mm";
		}
		return `${length.toPrecision(3)} ${unit}`;
	}
	return `${Math.round(length * 1000) / 1000} pixels`;
}

export function nowMs(): number {
	if (typeof performance !== "undefined" && typeof performance.now === "function") {
		return performance.now();
	}
	return Date.now();
}

export function sanitizePointCount(pointData: WsiPointData): number {
	const fillModesLength =
		pointData.fillModes instanceof Uint8Array
			? pointData.fillModes.length
			: Number.MAX_SAFE_INTEGER;
	return Math.max(
		0,
		Math.min(
			Math.floor(pointData.count ?? 0),
			Math.floor((pointData.positions?.length ?? 0) / 2),
			pointData.paletteIndices?.length ?? 0,
			fillModesLength,
		),
	);
}

export function isSameViewState(
	a: Partial<WsiViewState> | null | undefined,
	b: Partial<WsiViewState> | null | undefined,
): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	return (
		Math.abs((a.zoom ?? 0) - (b.zoom ?? 0)) < 1e-6 &&
		Math.abs((a.offsetX ?? 0) - (b.offsetX ?? 0)) < 1e-6 &&
		Math.abs((a.offsetY ?? 0) - (b.offsetY ?? 0)) < 1e-6 &&
		Math.abs((a.rotationDeg ?? 0) - (b.rotationDeg ?? 0)) < 1e-6
	);
}

export function toBearerToken(value: string | null | undefined): string {
	const trimmed = String(value ?? "").trim();
	if (!trimmed) return "";
	if (/^bearer\s+/i.test(trimmed)) {
		const token = trimmed.replace(/^bearer\s+/i, "").trim();
		return token ? `Bearer ${token}` : "";
	}
	return `Bearer ${trimmed}`;
}

export function hexToRgba(
	hex: string | null | undefined,
): [number, number, number, number] {
	const value = String(hex ?? "").trim();
	const match = value.match(/^#?([0-9a-fA-F]{6})$/);
	if (!match) return [...DEFAULT_POINT_COLOR];

	const n = Number.parseInt(match[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

export function buildTermPalette(
	terms:
		| Array<{ termId?: string | null; termColor?: string | null }>
		| null
		| undefined,
): TermPalette {
	const palette: Array<[number, number, number, number]> = [
		[...DEFAULT_POINT_COLOR],
	];
	const termToPaletteIndex = new Map<string, number>();

	for (const term of terms ?? []) {
		const termId = String(term?.termId ?? "");
		if (!termId || termToPaletteIndex.has(termId)) continue;

		termToPaletteIndex.set(termId, palette.length);
		palette.push(hexToRgba(term?.termColor));
	}

	const colors = new Uint8Array(palette.length * 4);
	for (let i = 0; i < palette.length; i += 1) {
		colors[i * 4] = palette[i][0];
		colors[i * 4 + 1] = palette[i][1];
		colors[i * 4 + 2] = palette[i][2];
		colors[i * 4 + 3] = palette[i][3];
	}

	return { colors, termToPaletteIndex };
}
