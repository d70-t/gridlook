/* eslint-disable boundaries/no-unknown-files */
import * as THREE from "three";
import { expect } from "vitest";

import type { useGlobeControlStore } from "@/store/store.ts";
import {
  interpolateScalarValue,
  type TScalarObject,
} from "@/ui/grids/composables/scalarInterpolation.ts";
import { SCALAR_INTERPOLATION } from "@/ui/grids/composables/scalarTimeline.ts";
import type { useScalarBake } from "@/ui/grids/composables/useScalarBake.ts";

// eslint-disable-next-line max-lines-per-function
export async function checkScalarInterpolation(
  bake: ReturnType<typeof useScalarBake>,
  store: ReturnType<typeof useGlobeControlStore>,
  objects: TScalarObject[],
  offset: number
) {
  const base = objects.map((object) =>
    Array.from(
      (object.geometry.getAttribute("data_value")?.array ??
        (object.material as THREE.ShaderMaterial).uniforms.data.value.image
          .data) as Float32Array
    )
  );
  const geometry = objects.map((object) => object.geometry);
  const materials = objects.map((object) => object.material);
  const retained = bake.estimate!.retainedBytes;
  expect(bake.interpolationUnavailable).toBe("");
  expect(bake.unequalTimeGaps).toBe(true);
  for (const [mode, expected] of [
    [SCALAR_INTERPOLATION.LINEAR, [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]],
    [
      SCALAR_INTERPOLATION.SMOOTHSTEP,
      [0, 5 / 32, 0.5, 27 / 32, 1, 37 / 32, 1.5, 59 / 32, 2],
    ],
  ] as const) {
    bake.interpolationMode = mode;
    bake.intermediateFrames = 3;
    await bake.resetPlayback();
    expect(bake.frameCount).toBe(9);
    const bounds = { ...store.selection };
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 3, 0]) {
      await bake.seek(index);
      expect(bake.message).toBe("");
      expect(store.selection).toEqual(bounds);
      for (let i = 0; i < objects.length; i++) {
        const object = objects[i];
        const material = object.material as THREE.ShaderMaterial;
        const first = (object.geometry.getAttribute("data_value")?.array ??
          material.uniforms.data.value.image.data) as Float32Array;
        const next = (object.geometry.getAttribute("data_value_next")?.array ??
          material.uniforms.dataNext.value.image.data) as Float32Array;
        expect(
          Array.from(first, (value, j) =>
            interpolateScalarValue(
              value,
              next[j],
              material.uniforms.scalarMix.value
            )
          )
        ).toEqual(base[i].map((value) => value + offset * expected[index]));
        expect(object.geometry).toBe(geometry[i]);
        expect(object.material).toBe(materials[i]);
      }
      expect(store.dimSlidersDisplay[0]).toSatisfy(Number.isInteger);
      if (index === 6) {
        expect(store.scalarAnimationTime?.label).toBe(
          "04 Jan 2000 • 12:00:00.000"
        );
      }
    }
  }
  bake.intermediateFrames = 20;
  await bake.resetPlayback();
  expect(bake.frameCount).toBe(43);
  expect(bake.completed).toBe(3);
  expect(bake.estimate!.retainedBytes).toBe(retained);
  bake.interpolationMode = SCALAR_INTERPOLATION.ORIGINAL;
  await bake.resetPlayback();
  expect(store.scalarAnimationTime).toBeUndefined();
  expect(store.scalarAnimationBounds).toBeUndefined();
  for (const object of objects) {
    expect(
      (object.material as THREE.ShaderMaterial).uniforms.scalarMix.value
    ).toBe(0);
    expect(object.geometry.getAttribute("data_value_next")).toBeUndefined();
  }
}
