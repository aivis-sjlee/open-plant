import { clamp } from "./utils";
import { nowMs } from "./utils";
import type { ViewAnimationRuntimeState, ViewAnimationStartOptions } from "./wsi-renderer-types";

export function cancelViewAnimation(state: ViewAnimationRuntimeState): void {
  state.animation = null;
  if (state.frame !== null) {
    cancelAnimationFrame(state.frame);
    state.frame = null;
  }
}

export function startViewAnimation(options: ViewAnimationStartOptions): void {
  const { state, camera, target, durationMs, easing, onUpdate } = options;
  const from = camera.getViewState();
  cancelViewAnimation(state);
  state.animation = {
    startMs: nowMs(),
    durationMs: Math.max(0, durationMs),
    from,
    to: target,
    easing,
  };

  const step = (): void => {
    const animation = state.animation;
    if (!animation) return;

    const elapsed = Math.max(0, nowMs() - animation.startMs);
    const rawT = animation.durationMs <= 0 ? 1 : clamp(elapsed / animation.durationMs, 0, 1);
    let eased = rawT;
    try {
      eased = animation.easing(rawT);
    } catch {
      eased = rawT;
    }
    if (!Number.isFinite(eased)) {
      eased = rawT;
    }
    eased = clamp(eased, 0, 1);

    camera.setViewState({
      zoom: animation.from.zoom + (animation.to.zoom - animation.from.zoom) * eased,
      offsetX: animation.from.offsetX + (animation.to.offsetX - animation.from.offsetX) * eased,
      offsetY: animation.from.offsetY + (animation.to.offsetY - animation.from.offsetY) * eased,
      rotationDeg: animation.from.rotationDeg + (animation.to.rotationDeg - animation.from.rotationDeg) * eased,
    });
    onUpdate();

    if (rawT >= 1) {
      state.animation = null;
      state.frame = null;
      return;
    }

    state.frame = requestAnimationFrame(step);
  };

  state.frame = requestAnimationFrame(step);
}
