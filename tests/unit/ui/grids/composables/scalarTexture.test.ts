import * as THREE from "three";
import { expect, it, vi } from "vitest";

import { updateScalarTexture } from "@/ui/grids/composables/scalarTexture.ts";

it("keeps one GPU texture while swapping immutable keyframe arrays", () => {
  const first = new Float32Array([1, 2, 3, 4]);
  const next = new Float32Array([5, 6, 7, 8]);
  const texture = updateScalarTexture(undefined, first, 2, 2);
  const dispose = vi.fn();
  texture.addEventListener("dispose", dispose);
  const version = texture.version;
  for (const data of [next, first]) {
    expect(updateScalarTexture(texture, data, 2, 2)).toBe(texture);
    expect(texture.image.data).toBe(data);
  }
  expect(texture.version).toBe(version + 2);
  expect(dispose).not.toHaveBeenCalled();
  expect([...first]).toEqual([1, 2, 3, 4]);
  expect([...next]).toEqual([5, 6, 7, 8]);
});

it.each([false, true])(
  "replaces incompatible textures and keeps longitude wrapping (format change: %s)",
  (formatChange) => {
    const previous = updateScalarTexture(undefined, new Float32Array(4), 2, 2);
    previous.wrapS = THREE.RepeatWrapping;
    const dispose = vi.fn();
    previous.addEventListener("dispose", dispose);
    if (formatChange) {
      previous.format = THREE.RGBAFormat;
    }
    const data = new Float32Array(formatChange ? 4 : 6);
    const texture = updateScalarTexture(
      previous,
      data,
      formatChange ? 2 : 3,
      2
    );
    expect(texture).not.toBe(previous);
    expect(dispose).toHaveBeenCalledOnce();
    expect(texture.image.data).toBe(data);
    expect(texture.image.width).toBe(formatChange ? 2 : 3);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.format).toBe(THREE.RedFormat);
  }
);

it("replaces the empty placeholder before the first HEALPix frame", () => {
  const placeholder = new THREE.Texture();
  const dispose = vi.fn();
  placeholder.addEventListener("dispose", dispose);
  const texture = updateScalarTexture(placeholder, new Float32Array([1]), 1, 1);
  expect(texture).toBeInstanceOf(THREE.DataTexture);
  expect(dispose).toHaveBeenCalledOnce();
});
