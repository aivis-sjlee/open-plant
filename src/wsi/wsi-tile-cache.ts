import type {
  HandleTileLoadedOptions,
  TileCacheTrimOptions,
} from "./wsi-renderer-types";

export function trimTileCache(options: TileCacheTrimOptions): void {
  const { gl, cache, maxCacheTiles } = options;
  if (cache.size <= maxCacheTiles) return;

  const entries = Array.from(cache.entries());
  entries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);

  const removeCount = cache.size - maxCacheTiles;
  for (let i = 0; i < removeCount; i += 1) {
    const [key, value] = entries[i];
    gl.deleteTexture(value.texture);
    cache.delete(key);
  }
}

export function createTextureFromBitmap(gl: WebGL2RenderingContext, bitmap: ImageBitmap): WebGLTexture | null {
  if (gl.isContextLost()) return null;

  const texture = gl.createTexture();
  if (!texture) return null;

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return texture;
}

export function handleTileLoaded(options: HandleTileLoadedOptions): void {
  const { gl, cache, tile, bitmap, frameSerial, maxCacheTiles, destroyed, contextLost, requestRender } = options;

  if (destroyed || contextLost || gl.isContextLost()) {
    bitmap.close();
    return;
  }
  if (cache.has(tile.key)) {
    bitmap.close();
    return;
  }

  const texture = createTextureFromBitmap(gl, bitmap);
  bitmap.close();
  if (!texture) return;

  cache.set(tile.key, {
    key: tile.key,
    texture,
    bounds: tile.bounds,
    tier: tile.tier,
    lastUsed: frameSerial,
  });
  trimTileCache({ gl, cache, maxCacheTiles });
  requestRender();
}

export function deleteCachedTextures(gl: WebGL2RenderingContext, cache: Map<string, { texture: WebGLTexture }>): void {
  for (const [, value] of cache) {
    gl.deleteTexture(value.texture);
  }
}
