import type { TileScheduler } from "./tile-scheduler";
import type { CachedTile, PointProgram, TileVertexProgram } from "./wsi-renderer-types";
import { deleteCachedTextures } from "./wsi-tile-cache";

export interface ContextLostOptions {
  event: Event;
  destroyed: boolean;
  contextLost: boolean;
  frame: number | null;
  cancelViewAnimation: () => void;
  cancelDrag: () => void;
  tileScheduler: TileScheduler;
  cache: Map<string, CachedTile>;
  onContextLost?: () => void;
}

export interface ContextLostResult {
  handled: boolean;
  frame: number | null;
}

export function handleContextLost(options: ContextLostOptions): ContextLostResult {
  const { event, destroyed, contextLost, cancelViewAnimation, cancelDrag, tileScheduler, cache, onContextLost } = options;
  event.preventDefault();
  if (destroyed || contextLost) {
    return {
      handled: false,
      frame: options.frame,
    };
  }

  let frame = options.frame;
  if (frame !== null) {
    cancelAnimationFrame(frame);
    frame = null;
  }
  cancelViewAnimation();

  cancelDrag();
  tileScheduler.clear();
  cache.clear();
  onContextLost?.();

  return {
    handled: true,
    frame,
  };
}

export interface DestroyRendererOptions {
  destroyed: boolean;
  frame: number | null;
  cancelViewAnimation: () => void;
  resizeObserver: ResizeObserver;
  removeCanvasEventListeners: () => void;
  cancelDrag: () => void;
  tileScheduler: TileScheduler;
  contextLost: boolean;
  gl: WebGL2RenderingContext;
  cache: Map<string, CachedTile>;
  tileProgram: TileVertexProgram;
  pointProgram: PointProgram;
}

export interface DestroyRendererResult {
  didDestroy: boolean;
  frame: number | null;
}

export function destroyRenderer(options: DestroyRendererOptions): DestroyRendererResult {
  if (options.destroyed) {
    return {
      didDestroy: false,
      frame: options.frame,
    };
  }

  let frame = options.frame;
  if (frame !== null) {
    cancelAnimationFrame(frame);
    frame = null;
  }
  options.cancelViewAnimation();

  options.resizeObserver.disconnect();
  options.removeCanvasEventListeners();
  options.cancelDrag();
  options.tileScheduler.destroy();

  if (!options.contextLost && !options.gl.isContextLost()) {
    deleteCachedTextures(options.gl, options.cache);
    options.gl.deleteBuffer(options.tileProgram.vbo);
    options.gl.deleteVertexArray(options.tileProgram.vao);
    options.gl.deleteProgram(options.tileProgram.program);

    options.gl.deleteBuffer(options.pointProgram.posBuffer);
    options.gl.deleteBuffer(options.pointProgram.termBuffer);
    options.gl.deleteBuffer(options.pointProgram.fillModeBuffer);
    options.gl.deleteBuffer(options.pointProgram.indexBuffer);
    options.gl.deleteTexture(options.pointProgram.paletteTexture);
    options.gl.deleteVertexArray(options.pointProgram.vao);
    options.gl.deleteProgram(options.pointProgram.program);
  }
  options.cache.clear();

  return {
    didDestroy: true,
    frame,
  };
}
