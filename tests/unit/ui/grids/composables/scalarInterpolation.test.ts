import * as THREE from "three";
import { expect, it, vi } from "vitest";

import {
  makeGpuProjectedTextureMaterial,
  makeGpuProjectedPointMaterial,
} from "@/lib/shaders/gridShaders.ts";
import { HOVERED_GRID_POINT_STATUS } from "@/store/store.ts";
import type { TPreparedScalarFrame } from "@/ui/grids/composables/scalarFrame.ts";
import {
  createScalarInterpolator,
  interpolateScalarSample,
} from "@/ui/grids/composables/scalarInterpolation.ts";
import { updateScalarTexture } from "@/ui/grids/composables/scalarTexture.ts";

vi.stubGlobal("localStorage", { getItem: () => null });

it.each([false, true])(
  "keeps two resident fields and promotes the neighbour without an upload (textures: %s)",
  // eslint-disable-next-line max-lines-per-function
  (textured) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "data_value",
      new THREE.BufferAttribute(new Float32Array(2), 1)
    );
    const material = textured
      ? makeGpuProjectedTextureMaterial(
          updateScalarTexture(undefined, new Float32Array(2), 2, 1),
          "viridis",
          0,
          1
        )
      : makeGpuProjectedPointMaterial("viridis");
    const objects = [new THREE.Mesh(geometry, material)];
    if (textured) {
      objects.push(new THREE.Mesh(new THREE.BufferGeometry(), material));
    }
    const sourceValues = [
      [0, NaN],
      [10, 20],
      [30, 40],
    ].map((values) => new Float32Array(values));
    const frames = sourceValues.map((data) => ({
      interpolation: {
        values: objects.map(() => data),
        geometry: [],
        sample: () => null,
      },
      render: vi.fn(() => {
        if (textured) {
          material.uniforms.data.value = updateScalarTexture(
            material.uniforms.data.value,
            data,
            2,
            1
          );
        } else {
          const attr = geometry.getAttribute(
            "data_value"
          ) as THREE.BufferAttribute;
          attr.array.set(data);
          attr.needsUpdate = true;
        }
      }),
    })) as unknown as TPreparedScalarFrame[];
    const interpolator = createScalarInterpolator(() => objects);
    const resources = () =>
      textured
        ? ([
            material.uniforms.data.value,
            material.uniforms.dataNext.value,
          ] as THREE.DataTexture[])
        : ([
            geometry.getAttribute("data_value"),
            geometry.getAttribute("data_value_next"),
          ] as THREE.BufferAttribute[]);
    const values = (resource: THREE.DataTexture | THREE.BufferAttribute) =>
      resource instanceof THREE.DataTexture
        ? resource.image.data
        : resource.array;
    interpolator.render(frames[0], frames[1], 0.25);
    const pair = resources();
    const versions = pair.map((value) => value.version);
    interpolator.render(frames[0], frames[1], 0.75);
    expect(material.uniforms.scalarMix.value).toBe(0.75);
    expect(resources()).toEqual(pair);
    expect(resources().map((value) => value.version)).toEqual(versions);
    expect(frames[0].render).toHaveBeenCalledOnce();
    interpolator.render(frames[1], frames[2], 0.25);
    expect(resources()[0]).toBe(pair[1]);
    expect(resources()[0].version).toBe(versions[1]);
    expect(resources()[1]).toBe(pair[0]);
    expect(Array.from(values(resources()[0]) as Float32Array)).toEqual([
      10, 20,
    ]);
    expect(Array.from(values(resources()[1]) as Float32Array)).toEqual([
      30, 40,
    ]);
    expect(frames[1].render).not.toHaveBeenCalled();
    interpolator.render(frames[0], frames[1], 0.5);
    expect(Array.from(values(resources()[0]) as Float32Array)).toEqual([
      0,
      NaN,
    ]);
    expect(Array.from(values(resources()[1]) as Float32Array)).toEqual([
      10, 20,
    ]);
    expect(sourceValues.map((value) => Array.from(value))).toEqual([
      [0, NaN],
      [10, 20],
      [30, 40],
    ]);
    const dispose = vi.fn();
    (textured
      ? (resources()[1] as THREE.DataTexture)
      : geometry
    ).addEventListener("dispose", dispose);
    interpolator.clear();
    expect(dispose).toHaveBeenCalledOnce();
    expect(material.uniforms.scalarMix.value).toBe(0);
    expect(geometry.getAttribute("data_value_next")).toBeUndefined();
    interpolator.clear();
    expect(dispose).toHaveBeenCalledOnce();
  }
);

it("uses the same missing-value and endpoint rules for hover samples", () => {
  const data = (value: number | null) => ({
    values: [],
    geometry: [],
    sample: () => ({
      lat: 1,
      lon: 2,
      value,
      status:
        value === null
          ? HOVERED_GRID_POINT_STATUS.MISSING
          : HOVERED_GRID_POINT_STATUS.VALUE,
    }),
  });
  expect(interpolateScalarSample(data(0), data(20), 0.25, 1, 2)?.value).toBe(5);
  expect(interpolateScalarSample(data(null), data(20), 0.5, 1, 2)?.status).toBe(
    HOVERED_GRID_POINT_STATUS.MISSING
  );
  expect(interpolateScalarSample(data(null), data(20), 1, 1, 2)?.value).toBe(
    20
  );
  expect(interpolateScalarSample(data(5), data(null), 0, 1, 2)?.value).toBe(5);
});
