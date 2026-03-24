import assert from "node:assert/strict";
import test from "node:test";
import { __heatmapLayerInternals } from "../../dist/index.js";

const {
  buildClipKey,
  resolveCellSupportFactor,
  resolveContinuousZoom,
  resolveDensityCutoff,
  resolveDensityBias,
  resolveDensityGain,
  resolveDensityGamma,
  resolveNormalizedDensityWeight,
  resolveNormalizationUpperWeight,
  resolveDensityWeightExponent,
  resolveRawZoomFromContinuousZoom,
  resolvePointCount,
  resolveZoomVisibilityStrength,
  isSameHeatmapInput,
} = __heatmapLayerInternals;

test("heatmap internals: fixed zoom uses continuous zoom round-trip", () => {
  const source = { maxTierZoom: 8 };
  const rawZoom = 0.375;
  const continuousZoom = resolveContinuousZoom(rawZoom, source);
  const restoredRawZoom = resolveRawZoomFromContinuousZoom(continuousZoom, source);
  assert.ok(Math.abs(restoredRawZoom - rawZoom) < 1e-9);
});

test("heatmap internals: density contrast suppresses sparse bins more aggressively", () => {
  assert.ok(resolveDensityWeightExponent(2.5) > resolveDensityWeightExponent(1));
  assert.ok(resolveDensityCutoff(0) > resolveDensityCutoff(1));
  assert.ok(resolveDensityCutoff(2.5) > resolveDensityCutoff(15));
  assert.ok(resolveDensityBias(0) > resolveDensityBias(1));
  assert.ok(resolveDensityBias(2.5) > resolveDensityBias(15));
  assert.ok(resolveDensityGain(2.5) > resolveDensityGain(1));
  assert.ok(resolveDensityGamma(2.5) > resolveDensityGamma(1));
  assert.ok(resolveDensityGain(0) < resolveDensityGain(1));
  assert.ok(resolveDensityGamma(0) < resolveDensityGamma(1));
  assert.ok(resolveNormalizedDensityWeight(4, 64, 2.5) > 0);
  assert.equal(resolveNormalizedDensityWeight(4, 64, 2.5), resolveNormalizedDensityWeight(4, 64, 1));
  assert.ok(resolveDensityWeightExponent(15) > resolveDensityWeightExponent(4));
});

test("heatmap internals: support factor suppresses isolated bins", () => {
  assert.equal(resolveCellSupportFactor(1), 0.18);
  assert.ok(resolveCellSupportFactor(4) > resolveCellSupportFactor(2));
  assert.equal(resolveCellSupportFactor(24), 1);
});

test("heatmap internals: robust normalization ignores extreme outliers", () => {
  const cells = [
    { weight: 3 },
    { weight: 4 },
    { weight: 5 },
    { weight: 6 },
    { weight: 120 },
  ];
  const normalizationUpperWeight = resolveNormalizationUpperWeight(cells, 2);
  assert.ok(normalizationUpperWeight > 5);
  assert.ok(normalizationUpperWeight < 120);
});

test("heatmap internals: zoom visibility strength reaches zero at high zoom", () => {
  const source = { maxTierZoom: 8 };
  assert.equal(resolveZoomVisibilityStrength(2 ** (-3), source, 0), 1);
  assert.equal(resolveZoomVisibilityStrength(2 ** (2), source, 0), 0);
  assert.ok(resolveZoomVisibilityStrength(2 ** (-2), source, 0) > resolveZoomVisibilityStrength(2 ** (-1.5), source, 0));
  assert.equal(resolveZoomVisibilityStrength(2 ** (-2), source, 0), resolveZoomVisibilityStrength(2 ** (-2), source, 6));
});

test("heatmap internals: clip key stays stable for equivalent polygon payloads", () => {
  const polygonsA = [
    {
      outer: [[0, 0], [5, 0], [5, 5], [0, 0]],
      holes: [[[1, 1], [2, 1], [2, 2], [1, 1]]],
    },
  ];
  const polygonsB = [
    {
      outer: [[0, 0], [5, 0], [5, 5], [0, 0]],
      holes: [[[1, 1], [2, 1], [2, 2], [1, 1]]],
    },
  ];

  assert.equal(buildClipKey(polygonsA), buildClipKey(polygonsB));
});

test("heatmap internals: source cache can be reused across wrapper recreation", () => {
  const positions = new Float32Array([1, 1, 2, 2, 3, 3]);
  const weights = new Float32Array([1, 2, 3]);
  const dataA = { count: 3, positions, weights };
  const dataB = { count: 3, positions, weights };
  const clipKey = "0:123";

  const cached = {
    dataRef: dataA,
    positionsRef: positions,
    weightsRef: weights,
    inputCount: resolvePointCount(dataA),
    clipKey,
  };

  assert.equal(isSameHeatmapInput(cached, dataB, clipKey), true);
  assert.equal(isSameHeatmapInput(cached, { count: 2, positions, weights }, clipKey), false);
  assert.equal(isSameHeatmapInput(cached, dataB, "0:456"), false);
});
