import { shallowRef } from "vue";

import type { TScreenFrame } from "@/lib/analysis/screenFrame.ts";

/**
 * A small bridge between the active map scene and map tools living outside
 * the grid components (the analysis plots): picking, projecting geometry to
 * the screen, and the map gestures a tool may consume.
 */
export type TMapGeoPoint = { lat: number; lon: number };

type TMapScreenPoint = { x: number; y: number; visible: boolean };

/** The canvas rectangle on screen (px), read once for many points. */
export type TViewport = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type TMapScene = {
  /** `viewport`: the canvas rectangle, when the caller picks many points. */
  pick(
    clientX: number,
    clientY: number,
    viewport?: TViewport
  ): TMapGeoPoint | null;
  /** `viewport`: the canvas rectangle, when the caller projects many points. */
  project(
    lat: number,
    lon: number,
    viewport?: TViewport
  ): TMapScreenPoint | null;
  /** Stops what is left of a pan's glide, so the view holds still. */
  hold?(): void;
  /** The view as project places points (screenFrame.ts), if one is set. */
  frame?(): Omit<TScreenFrame, "rect" | "band"> | undefined;
  canvas(): HTMLCanvasElement | undefined;
  /** False where picking is not reliable (e.g. the hybrid azimuthal view). */
  pickingReliable(): boolean;
};

export type TMapContextMenuEvent = {
  clientX: number;
  clientY: number;
  geo: TMapGeoPoint | null;
  reliable: boolean;
};

/** A click on the map; Ctrl/⌘ add to a selection (several countries). */
type TMapClick = {
  clientX: number;
  clientY: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
};

type TMapTool = {
  contextMenu?: (event: TMapContextMenuEvent) => void;
  /** Return true to consume the click (only while a tool is armed). */
  click?: (geo: TMapGeoPoint | null, event: TMapClick) => boolean;
};

let scene: TMapScene | undefined;
let tool: TMapTool = {};

/** Increments on every rendered frame and scene change; overlays reproject. */
export const mapFrame = shallowRef(0);

export function registerMapScene(next: TMapScene) {
  scene = next;
  mapFrame.value++;
  return () => {
    if (scene === next) {
      scene = undefined;
      mapFrame.value++;
    }
  };
}

export function registerMapTool(next: TMapTool) {
  tool = next;
  return () => {
    if (tool === next) {
      tool = {};
    }
  };
}

export function notifyMapRendered() {
  mapFrame.value++;
}

export function getMapScene() {
  return scene;
}

export function emitMapContextMenu(clientX: number, clientY: number) {
  if (!scene || !tool.contextMenu) {
    return false;
  }
  tool.contextMenu({
    clientX,
    clientY,
    geo: scene.pick(clientX, clientY),
    reliable: scene.pickingReliable(),
  });
  return true;
}

export function emitMapClick(
  clientX: number,
  clientY: number,
  keys: { ctrlKey?: boolean; metaKey?: boolean } = {}
) {
  if (!scene || !tool.click) {
    return false;
  }
  return tool.click(scene.pick(clientX, clientY), {
    clientX,
    clientY,
    ctrlKey: keys.ctrlKey,
    metaKey: keys.metaKey,
  });
}
