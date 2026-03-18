import { DEFAULT_ROTATION_DRAG_SENSITIVITY, toRadians } from "./wsi-normalize";
import type { InteractionConfig, InteractionState, ZoomSnapState } from "./wsi-renderer-types";

interface PointerMoveOptions {
  event: PointerEvent;
  canvas: HTMLCanvasElement;
  state: InteractionState;
  config: InteractionConfig;
  camera: {
    getViewState: () => {
      zoom: number;
      offsetX: number;
      offsetY: number;
      rotationDeg: number;
    };
    setViewState: (next: Partial<{ zoom: number; offsetX: number; offsetY: number; rotationDeg: number }>) => void;
  };
  clampViewState: () => void;
  emitViewState: () => void;
  requestRender: () => void;
}

interface PointerDownOptions {
  event: PointerEvent;
  canvas: HTMLCanvasElement;
  state: InteractionState;
  config: InteractionConfig;
  cancelViewAnimation: () => void;
}

interface WheelOptions {
  event: WheelEvent;
  canvas: HTMLCanvasElement;
  onZoomBy: (factor: number, x: number, y: number) => void;
}

interface DoubleClickOptions {
  event: MouseEvent;
  canvas: HTMLCanvasElement;
  onZoomBy: (factor: number, x: number, y: number) => void;
}

function getPointerAngleRad(canvas: HTMLCanvasElement, clientX: number, clientY: number): number {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left - rect.width * 0.5;
  const y = clientY - rect.top - rect.height * 0.5;
  return Math.atan2(y, x);
}

export function cancelDrag(canvas: HTMLCanvasElement, state: InteractionState): void {
  if (state.pointerId !== null && canvas.hasPointerCapture(state.pointerId)) {
    try {
      canvas.releasePointerCapture(state.pointerId);
    } catch {
      // noop
    }
  }
  state.dragging = false;
  state.mode = "none";
  state.rotateLastAngleRad = null;
  state.pointerId = null;
  canvas.classList.remove("dragging");
}

export function handlePointerDown(options: PointerDownOptions): void {
  const { event, canvas, state, config, cancelViewAnimation } = options;
  const wantsRotate = config.ctrlDragRotate && (event.ctrlKey || event.metaKey);
  const allowButton = event.button === 0 || (wantsRotate && event.button === 2);
  if (!allowButton) return;

  cancelViewAnimation();
  if (wantsRotate) {
    event.preventDefault();
  }

  state.dragging = true;
  state.mode = wantsRotate ? "rotate" : "pan";
  state.pointerId = event.pointerId;
  state.lastPointerX = event.clientX;
  state.lastPointerY = event.clientY;
  state.rotateLastAngleRad = state.mode === "rotate" ? getPointerAngleRad(canvas, event.clientX, event.clientY) : null;

  canvas.classList.add("dragging");
  canvas.setPointerCapture(event.pointerId);
}

export function handlePointerMove(options: PointerMoveOptions): void {
  const { event, canvas, state, config, camera, clampViewState, emitViewState, requestRender } = options;
  if (!state.dragging || event.pointerId !== state.pointerId) return;

  const dx = event.clientX - state.lastPointerX;
  const dy = event.clientY - state.lastPointerY;
  state.lastPointerX = event.clientX;
  state.lastPointerY = event.clientY;

  if (state.mode === "rotate") {
    const nextAngle = getPointerAngleRad(canvas, event.clientX, event.clientY);
    const prevAngle = state.rotateLastAngleRad;
    state.rotateLastAngleRad = nextAngle;
    if (prevAngle !== null) {
      const rawDelta = nextAngle - prevAngle;
      const delta = Math.atan2(Math.sin(rawDelta), Math.cos(rawDelta));
      const sensitivityScale = DEFAULT_ROTATION_DRAG_SENSITIVITY > 0 ? config.rotationDragSensitivityDegPerPixel / DEFAULT_ROTATION_DRAG_SENSITIVITY : 1;
      const viewState = camera.getViewState();
      camera.setViewState({
        rotationDeg: viewState.rotationDeg - ((delta * 180) / Math.PI) * sensitivityScale,
      });
    }
  } else {
    const viewState = camera.getViewState();
    const zoom = Math.max(1e-6, viewState.zoom);
    const rad = toRadians(viewState.rotationDeg);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const worldDx = (dx * cos - dy * sin) / zoom;
    const worldDy = (dx * sin + dy * cos) / zoom;
    camera.setViewState({
      offsetX: viewState.offsetX - worldDx,
      offsetY: viewState.offsetY - worldDy,
    });
  }

  clampViewState();
  emitViewState();
  requestRender();
}

export function handlePointerUp(event: PointerEvent, canvas: HTMLCanvasElement, state: InteractionState): void {
  if (event.pointerId !== state.pointerId) return;
  cancelDrag(canvas, state);
}

export function handleWheel(options: WheelOptions): void {
  const { event, canvas, onZoomBy } = options;
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const factor = event.deltaY < 0 ? 1.12 : 0.89;
  onZoomBy(factor, x, y);
}

interface WheelSnapOptions {
  event: WheelEvent;
  canvas: HTMLCanvasElement;
  snapState: ZoomSnapState;
  onSnapZoom: (direction: "in" | "out", x: number, y: number) => void;
}

const SNAP_DELTA_THRESHOLD = 4;

export function handleWheelSnap(options: WheelSnapOptions): void {
  const { event, canvas, snapState, onSnapZoom } = options;
  event.preventDefault();

  if (snapState.accumulatedDelta !== 0 && event.deltaY !== 0 && Math.sign(snapState.accumulatedDelta) !== Math.sign(event.deltaY)) {
    snapState.accumulatedDelta = 0;
  }
  snapState.accumulatedDelta += event.deltaY;

  if (Math.abs(snapState.accumulatedDelta) < SNAP_DELTA_THRESHOLD) return;

  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const direction: "in" | "out" = snapState.accumulatedDelta > 0 ? "out" : "in";

  snapState.accumulatedDelta = 0;
  onSnapZoom(direction, x, y);
}

export function handleDoubleClick(options: DoubleClickOptions): void {
  const { event, canvas, onZoomBy } = options;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  onZoomBy(event.shiftKey ? 0.8 : 1.25, x, y);
}

export function handleContextMenu(event: MouseEvent, dragging: boolean): void {
  if (dragging || event.ctrlKey || event.metaKey) {
    event.preventDefault();
  }
}
