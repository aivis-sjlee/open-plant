// @ts-nocheck
let libsPromise = null;

async function importWithFallback(urls) {
	let lastError = null;
	for (const url of urls) {
		try {
			return await import(/* @vite-ignore */ url);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError || new Error("module import failed");
}

async function getMvtLibs() {
	if (!libsPromise) {
		libsPromise = Promise.all([
			importWithFallback([
				"https://esm.sh/fzstd@0.2.0?bundle",
				"https://esm.sh/fzstd@0.2.0",
				"https://cdn.jsdelivr.net/npm/fzstd@0.1.1/+esm",
			]),
			importWithFallback([
				"https://esm.sh/pbf@4.0.1?bundle",
				"https://esm.sh/pbf@4.0.1",
				"https://cdn.jsdelivr.net/npm/pbf@4.0.1/+esm",
			]),
			importWithFallback([
				"https://esm.sh/@mapbox/vector-tile@2.0.4?bundle",
				"https://esm.sh/@mapbox/vector-tile@2.0.4",
				"https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@2.0.4/+esm",
			]),
		]).then(([fzstdMod, pbfMod, vectorTileMod]) => {
			const decompressFn =
				fzstdMod?.decompress ||
				fzstdMod?.default?.decompress ||
				(typeof fzstdMod?.default === "function" ? fzstdMod.default : null);
			const PbfCtor = pbfMod?.default || pbfMod?.Pbf || pbfMod;
			const VectorTileCtor =
				vectorTileMod?.VectorTile ||
				vectorTileMod?.default?.VectorTile ||
				vectorTileMod?.default;

			if (typeof decompressFn !== "function" || !PbfCtor || !VectorTileCtor) {
				throw new Error("MVT libs shape mismatch");
			}

			return {
				decompress: decompressFn,
				Pbf: PbfCtor,
				VectorTile: VectorTileCtor,
			};
		});
	}
	return libsPromise;
}

function isZstd(data) {
	return (
		data[0] === 0x28 && data[1] === 0xb5 && data[2] === 0x2f && data[3] === 0xfd
	);
}

function toMvtBuffer(arrayBuffer, decompressFn) {
	const data = new Uint8Array(arrayBuffer);

	if (!data.length) {
		throw new Error("Empty point payload");
	}

	if (!isZstd(data)) {
		return arrayBuffer;
	}

	const decompressed = decompressFn(data);
	const u8 =
		decompressed instanceof Uint8Array
			? decompressed
			: new Uint8Array(decompressed);
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

function getFirstLayer(tile) {
	const layerName = Object.keys(tile.layers)[0];
	if (!layerName) {
		throw new Error("No layer name found in MVT");
	}

	const layer = tile.layers[layerName];
	if (!layer) {
		throw new Error("No layer found in MVT");
	}

	return layer;
}

function resolveRawTermId(properties) {
	if (!properties) return "0";
	const candidates = [
		properties.termId,
		properties.term_id,
		properties.categoryId,
		properties.category_id,
		properties.categoryID,
		properties.classId,
		properties.class_id,
		properties.category,
		properties.term,
		properties.label,
	];

	for (const value of candidates) {
		if (value === undefined || value === null) continue;
		const text = String(value).trim();
		if (text) return text;
	}
	return "0";
}

function parsePointsFromLayer(layer, imageHeight) {
	const len = layer.length;

	const positions = new Float32Array(len * 2);
	const localTermIndex = new Uint16Array(len);
	const termTable = [""];
	const termToLocal = new Map();

	let hasNt = false;
	let hasPositivityRank = false;
	let cursor = 0;

	for (let i = 0; i < len; i += 1) {
		const feature = layer.feature(i);
		const geom = feature.loadGeometry()?.[0]?.[0];
		if (!geom) {
			continue;
		}

		const x = geom.x;
		const y = Number(imageHeight) - geom.y;
		if (!Number.isFinite(x) || !Number.isFinite(y)) {
			continue;
		}

		const isNtValue = Boolean(feature.properties?.nt);
		if (isNtValue) {
			hasNt = true;
		}

		const positivityRank = feature.properties?.positivity_rank;
		const positivityRankTumor = feature.properties?.positivity_rank_tumor;
		if (
			(positivityRank !== undefined && positivityRank !== null) ||
			(positivityRankTumor !== undefined && positivityRankTumor !== null)
		) {
			hasPositivityRank = true;
		}

		const termId = resolveRawTermId(feature.properties);
		let localIdx = termToLocal.get(termId);
		if (localIdx === undefined) {
			localIdx = termTable.length;
			if (localIdx >= 65535) {
				localIdx = 0;
			} else {
				termToLocal.set(termId, localIdx);
				termTable.push(termId);
			}
		}

		positions[cursor * 2] = x;
		positions[cursor * 2 + 1] = y;
		localTermIndex[cursor] = localIdx;
		cursor += 1;
	}

	return {
		count: cursor,
		positions: positions.subarray(0, cursor * 2),
		localTermIndex: localTermIndex.subarray(0, cursor),
		termTable,
		hasNt,
		hasPositivityRank,
	};
}

self.onmessage = async (event) => {
	const { type, url, imageHeight, authToken } = event.data || {};
	if (type !== "load") {
		return;
	}

	try {
		const headers = authToken ? { Authorization: authToken } : undefined;
		const response = await fetch(url, { headers });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const libs = await getMvtLibs();

		const arrayBuffer = await response.arrayBuffer();
		const mvtBuffer = toMvtBuffer(arrayBuffer, libs.decompress);

		if (!mvtBuffer.byteLength) {
			throw new Error("Decompressed data is empty");
		}

		const tile = new libs.VectorTile(new libs.Pbf(new Uint8Array(mvtBuffer)));
		const layer = getFirstLayer(tile);
		const parsed = parsePointsFromLayer(layer, imageHeight);

		const positions = parsed.positions.slice();
		const localTermIndex = parsed.localTermIndex.slice();

		self.postMessage(
			{
				type: "done",
				count: parsed.count,
				termTable: parsed.termTable,
				hasNt: parsed.hasNt,
				hasPositivityRank: parsed.hasPositivityRank,
				positions,
				localTermIndex,
			},
			[positions.buffer, localTermIndex.buffer],
		);
	} catch (error) {
		self.postMessage({
			type: "error",
			message: error?.message || String(error),
		});
	}
};
