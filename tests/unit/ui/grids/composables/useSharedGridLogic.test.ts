import * as THREE from "three";
import { beforeEach, expect, it, vi } from "vitest";
import { effectScope } from "vue";

vi.mock("@/ui/grids/composables/useGridScene.ts", () => ({
  useGridScene: () => ({ redraw: vi.fn() }),
}));

vi.mock("@/ui/grids/composables/useGridOverlays.ts", () => ({
  useGridOverlays: () => ({
    updateTextureLayers: vi.fn(),
    updateBasemap: vi.fn(),
  }),
}));

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { BUILTIN_LAYER_IDS, useGlobeControlStore } =
  await import("@/store/store.ts");
const { useSharedGridLogic } =
  await import("@/ui/grids/composables/useSharedGridLogic.ts");

beforeEach(() => {
  setActivePinia(createPinia());
});

it("applies the grid layer opacity and blends only when needed", () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  try {
    const { updateColormap } = scope.run(() => useSharedGridLogic())!;
    const material = () =>
      new THREE.ShaderMaterial({
        uniforms: {
          colormap: { value: 0 },
          addOffset: { value: 0 },
          scaleFactor: { value: 1 },
          opacity: { value: 1 },
        },
      });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material());
    const points = new THREE.Points(new THREE.BufferGeometry(), material());

    store.updateLayerOpacity(BUILTIN_LAYER_IDS.GRID, 0.4);
    updateColormap([mesh, points]);
    expect(mesh.material.uniforms.opacity.value).toBe(0.4);
    expect(mesh.material.transparent).toBe(true);

    store.updateLayerOpacity(BUILTIN_LAYER_IDS.GRID, 1);
    updateColormap([mesh, points]);
    expect(mesh.material.transparent).toBe(false);
    expect(points.material.transparent).toBe(true);
  } finally {
    scope.stop();
  }
});
