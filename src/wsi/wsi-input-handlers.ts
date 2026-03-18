import type { OrthoCamera } from "../core/ortho-camera";
import type { WsiImageSource } from "./types";
import type { RendererCanvasHandlers } from "./wsi-canvas-lifecycle";
import { cancelDrag as cancelInteractionDrag, handleContextMenu, handleDoubleClick, handlePointerDown, handlePointerMove, handlePointerUp, handleWheel, handleWheelSnap } from "./wsi-interaction";
import type { InteractionState, ZoomSnapState } from "./wsi-renderer-types";
import { clampViewState } from "./wsi-tile-visibility";

interface BaseInteractionOptions {
  interactionLocked: boolean;
  canvas: HTMLCanvasElement;
  state: InteractionState;
}

interface PointerDownWithLockOptions extends BaseInteractionOptions {
  event: PointerEvent;
  ctrlDragRotate: boolean;
  rotationDragSensitivityDegPerPixel: number;
  cancelViewAnimation: () => void;
}

interface PointerMoveWithLockOptions extends BaseInteractionOptions {
  event: PointerEvent;
  ctrlDragRotate: boolean;
  rotationDragSensitivityDegPerPixel: number;
  camera: OrthoCamera;
  source: WsiImageSource;
  emitViewState: () => void;
  requestRender: () => void;
}

interface PointerUpWithLockOptions extends BaseInteractionOptions {
  event: PointerEvent;
}

interface WheelWithLockOptions {
  event: WheelEvent;
  interactionLocked: boolean;
  canvas: HTMLCanvasElement;
  onZoomBy: (factor: number, x: number, y: number) => void;
}

interface DoubleClickWithLockOptions {
  event: MouseEvent;
  interactionLocked: boolean;
  canvas: HTMLCanvasElement;
  onZoomBy: (factor: number, x: number, y: number) => void;
}

interface ContextMenuWithLockOptions {
  event: MouseEvent;
  canvas: HTMLCanvasElement;
  state: InteractionState;
}

export function onPointerDownWithLock(options: PointerDownWithLockOptions): void {
  if (options.interactionLocked) return;
  handlePointerDown({
    event: options.event,
    canvas: options.canvas,
    state: options.state,
    config: {
      ctrlDragRotate: options.ctrlDragRotate,
      rotationDragSensitivityDegPerPixel: options.rotationDragSensitivityDegPerPixel,
    },
    cancelViewAnimation: options.cancelViewAnimation,
  });
}

export function onPointerMoveWithLock(options: PointerMoveWithLockOptions): void {
  if (options.interactionLocked) return;
  handlePointerMove({
    event: options.event,
    canvas: options.canvas,
    state: options.state,
    config: {
      ctrlDragRotate: options.ctrlDragRotate,
      rotationDragSensitivityDegPerPixel: options.rotationDragSensitivityDegPerPixel,
    },
    camera: options.camera,
    clampViewState: () => clampViewState(options.camera, options.source),
    emitViewState: options.emitViewState,
    requestRender: options.requestRender,
  });
}

export function onPointerUpWithLock(options: PointerUpWithLockOptions): void {
  if (options.interactionLocked) return;
  handlePointerUp(options.event, options.canvas, options.state);
}

export function onWheelWithLock(options: WheelWithLockOptions): void {
  if (options.interactionLocked) {
    options.event.preventDefault();
    return;
  }
  handleWheel({
    event: options.event,
    canvas: options.canvas,
    onZoomBy: options.onZoomBy,
  });
}

export function onDoubleClickWithLock(options: DoubleClickWithLockOptions): void {
  if (options.interactionLocked) return;
  handleDoubleClick({
    event: options.event,
    canvas: options.canvas,
    onZoomBy: options.onZoomBy,
  });
}

export function onContextMenuWithLock(options: ContextMenuWithLockOptions): void {
  handleContextMenu(options.event, options.state.dragging);
}

export function cancelDrag(canvas: HTMLCanvasElement, state: InteractionState): void {
  cancelInteractionDrag(canvas, state);
}

export interface CreateRendererInputHandlersOptions {
  canvas: HTMLCanvasElement;
  state: InteractionState;
  getInteractionLocked: () => boolean;
  getCtrlDragRotate: () => boolean;
  getRotationDragSensitivityDegPerPixel: () => number;
  cancelViewAnimation: () => void;
  camera: OrthoCamera;
  source: WsiImageSource;
  emitViewState: () => void;
  requestRender: () => void;
  zoomBy: (factor: number, x: number, y: number) => void;
  getUseZoomSnaps?: () => boolean;
  onSnapZoom?: (direction: "in" | "out", x: number, y: number) => boolean;
  zoomSnapState?: ZoomSnapState;
}

export function createRendererInputHandlers(
  options: CreateRendererInputHandlersOptions
): Pick<RendererCanvasHandlers, "pointerDown" | "pointerMove" | "pointerUp" | "wheel" | "doubleClick" | "contextMenu"> {
  return {
    pointerDown: (event: PointerEvent) =>
      onPointerDownWithLock({
        event,
        interactionLocked: options.getInteractionLocked(),
        canvas: options.canvas,
        state: options.state,
        ctrlDragRotate: options.getCtrlDragRotate(),
        rotationDragSensitivityDegPerPixel: options.getRotationDragSensitivityDegPerPixel(),
        cancelViewAnimation: options.cancelViewAnimation,
      }),
    pointerMove: (event: PointerEvent) =>
      onPointerMoveWithLock({
        event,
        interactionLocked: options.getInteractionLocked(),
        canvas: options.canvas,
        state: options.state,
        ctrlDragRotate: options.getCtrlDragRotate(),
        rotationDragSensitivityDegPerPixel: options.getRotationDragSensitivityDegPerPixel(),
        camera: options.camera,
        source: options.source,
        emitViewState: options.emitViewState,
        requestRender: options.requestRender,
      }),
    pointerUp: (event: PointerEvent) =>
      onPointerUpWithLock({
        event,
        interactionLocked: options.getInteractionLocked(),
        canvas: options.canvas,
        state: options.state,
      }),
    wheel: (event: WheelEvent) => {
      if (options.getInteractionLocked()) {
        event.preventDefault();
        return;
      }
      if (options.getUseZoomSnaps?.() && options.onSnapZoom && options.zoomSnapState) {
        handleWheelSnap({
          event,
          canvas: options.canvas,
          snapState: options.zoomSnapState,
          onSnapZoom: options.onSnapZoom,
        });
        return;
      }
      handleWheel({
        event,
        canvas: options.canvas,
        onZoomBy: options.zoomBy,
      });
    },
    doubleClick: (event: MouseEvent) =>
      onDoubleClickWithLock({
        event,
        interactionLocked: options.getInteractionLocked(),
        canvas: options.canvas,
        onZoomBy: options.zoomBy,
      }),
    contextMenu: (event: MouseEvent) =>
      onContextMenuWithLock({
        event,
        canvas: options.canvas,
        state: options.state,
      }),
  };
}
