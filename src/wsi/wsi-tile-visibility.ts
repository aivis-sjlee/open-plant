import { toTileUrl } from "./image-info";
import type { ScheduledTile } from "./tile-scheduler";
import type { WsiImageSource } from "./types";
import { clamp } from "./utils";
import type { Bounds } from "./wsi-renderer-types";

interface CameraViewLike {
  getViewCorners: () => [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]];
  getViewState: () => { zoom: number };
  getCenter: () => [number, number];
  setCenter: (x: number, y: number) => void;
}

export function getViewBounds(camera: CameraViewLike): Bounds {
  const corners = camera.getViewCorners();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

export function clampViewState(camera: CameraViewLike, source: WsiImageSource): void {
  const bounds = getViewBounds(camera);
  const visibleW = Math.max(1e-6, bounds[2] - bounds[0]);
  const visibleH = Math.max(1e-6, bounds[3] - bounds[1]);
  const marginX = visibleW * 0.2;
  const marginY = visibleH * 0.2;

  const [centerX, centerY] = camera.getCenter();
  const halfW = visibleW * 0.5;
  const halfH = visibleH * 0.5;

  const minCenterX = halfW - marginX;
  const maxCenterX = source.width - halfW + marginX;
  const minCenterY = halfH - marginY;
  const maxCenterY = source.height - halfH + marginY;

  const nextCenterX = minCenterX <= maxCenterX ? clamp(centerX, minCenterX, maxCenterX) : source.width * 0.5;
  const nextCenterY = minCenterY <= maxCenterY ? clamp(centerY, minCenterY, maxCenterY) : source.height * 0.5;

  camera.setCenter(nextCenterX, nextCenterY);
}

export function selectTier(camera: CameraViewLike, source: WsiImageSource): number {
  const zoom = Math.max(1e-6, camera.getViewState().zoom);
  const rawTier = source.maxTierZoom + Math.log2(zoom);
  return clamp(Math.floor(rawTier), 0, source.maxTierZoom);
}

export function intersectsBounds(a: Bounds, b: Bounds): boolean {
  return !(a[2] <= b[0] || a[0] >= b[2] || a[3] <= b[1] || a[1] >= b[3]);
}

export function getVisibleTilesForTier(camera: CameraViewLike, source: WsiImageSource, tier: number): ScheduledTile[] {
  const viewBounds = getViewBounds(camera);

  const levelScale = Math.pow(2, source.maxTierZoom - tier);
  const levelWidth = Math.ceil(source.width / levelScale);
  const levelHeight = Math.ceil(source.height / levelScale);

  const tilesX = Math.max(1, Math.ceil(levelWidth / source.tileSize));
  const tilesY = Math.max(1, Math.ceil(levelHeight / source.tileSize));

  const viewMinX = viewBounds[0];
  const viewMinY = viewBounds[1];
  const viewMaxX = viewBounds[2];
  const viewMaxY = viewBounds[3];

  const minTileX = clamp(Math.floor(viewMinX / levelScale / source.tileSize), 0, tilesX - 1);
  const maxTileX = clamp(Math.floor((viewMaxX - 1) / levelScale / source.tileSize), 0, tilesX - 1);
  const minTileY = clamp(Math.floor(viewMinY / levelScale / source.tileSize), 0, tilesY - 1);
  const maxTileY = clamp(Math.floor((viewMaxY - 1) / levelScale / source.tileSize), 0, tilesY - 1);

  if (minTileX > maxTileX || minTileY > maxTileY) {
    return [];
  }

  const centerTileX = ((viewMinX + viewMaxX) * 0.5) / levelScale / source.tileSize;
  const centerTileY = ((viewMinY + viewMaxY) * 0.5) / levelScale / source.tileSize;

  const visible: ScheduledTile[] = [];
  for (let y = minTileY; y <= maxTileY; y += 1) {
    for (let x = minTileX; x <= maxTileX; x += 1) {
      const left = x * source.tileSize * levelScale;
      const top = y * source.tileSize * levelScale;
      const right = Math.min((x + 1) * source.tileSize, levelWidth) * levelScale;
      const bottom = Math.min((y + 1) * source.tileSize, levelHeight) * levelScale;

      const dx = x - centerTileX;
      const dy = y - centerTileY;
      visible.push({
        key: `${tier}/${x}/${y}`,
        tier,
        x,
        y,
        bounds: [left, top, right, bottom],
        distance2: dx * dx + dy * dy,
        url: toTileUrl(source, tier, x, y),
      });
    }
  }

  visible.sort((a, b) => a.distance2 - b.distance2);
  return visible;
}

export function getVisibleTiles(camera: CameraViewLike, source: WsiImageSource): { tier: number; visible: ScheduledTile[] } {
  const tier = selectTier(camera, source);
  return {
    tier,
    visible: getVisibleTilesForTier(camera, source, tier),
  };
}
