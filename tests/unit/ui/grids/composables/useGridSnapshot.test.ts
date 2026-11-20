import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { afterEach, expect, it, vi } from "vitest";
import { ref } from "vue";

import { DEFAULT_SNAPSHOT_OPTIONS } from "@/lib/types/GlobeTypes.ts";
import { useGridSnapshot } from "@/ui/grids/composables/useGridSnapshot.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("renders the snapshot into a target with the stencil that masks a pyramid's backdrop", () => {
  setActivePinia(createPinia());
  // A 2D canvas whose context draws nothing.
  const context = {
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(4 * width * height),
    }),
    measureText: () => ({ width: 0 }),
    drawImage: () => {},
    fillRect: () => {},
    fillText: () => {},
    putImageData: () => {},
  };
  vi.stubGlobal("document", {
    createElement: () => ({ getContext: () => context, toBlob: () => {} }),
  });
  const targets: (THREE.WebGLRenderTarget | null)[] = [];
  const renderer = {
    capabilities: { maxTextureSize: 64 },
    getClearColor: (target: THREE.Color) => target,
    getClearAlpha: () => 1,
    setClearColor: () => {},
    setRenderTarget: (target: THREE.WebGLRenderTarget | null) =>
      targets.push(target),
    render: () => {},
    readRenderTargetPixels: () => {},
  } as unknown as THREE.WebGLRenderer;
  const { makeSnapshot } = useGridSnapshot({
    canvas: ref({ width: 4, height: 2 } as HTMLCanvasElement),
    getRenderer: () => renderer,
    getScene: () => new THREE.Scene(),
    getCamera: () => new THREE.PerspectiveCamera(),
    getBaseSurface: () => undefined,
    render: () => true,
  });
  makeSnapshot({
    ...DEFAULT_SNAPSHOT_OPTIONS,
    showColormap: false,
    showDatasetInfo: false,
  });
  expect(targets[0]?.stencilBuffer).toBe(true);
});
