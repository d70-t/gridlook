import * as THREE from "three";

import type { TGridHoverLookupResult } from "./gridHoverUtils.ts";
import type { TPreparedScalarFrame } from "./scalarFrame.ts";
import { updateScalarTexture } from "./scalarTexture.ts";

import { HOVERED_GRID_POINT_STATUS } from "@/store/store.ts";

export type TScalarObject = THREE.Mesh | THREE.Points;
export type TScalarInterpolationData = {
  values: Float32Array[];
  geometry: ArrayLike<number>[];
  indices?: Uint32Array[];
  sample: (lat: number, lon: number) => TGridHoverLookupResult | null;
};

export function compatibleScalarFrames(
  first: TPreparedScalarFrame,
  next: TPreparedScalarFrame
) {
  const a = first.interpolation;
  const b = next.interpolation;
  return (
    !!a &&
    !!b &&
    a.values.length === b.values.length &&
    a.values.every((values, i) => values.length === b.values[i].length) &&
    a.geometry.length === b.geometry.length &&
    a.geometry.every((values, i) => values === b.geometry[i])
  );
}

export function interpolateScalarValue(
  first: number,
  next: number,
  alpha: number
) {
  if (alpha === 0) {
    return first;
  }
  if (alpha === 1) {
    return next;
  }
  return Number.isFinite(first) && Number.isFinite(next)
    ? first * (1 - alpha) + next * alpha
    : NaN;
}

export function interpolateScalarSample(
  first: TScalarInterpolationData,
  next: TScalarInterpolationData,
  alpha: number,
  lat: number,
  lon: number
) {
  const a = first.sample(lat, lon);
  const b = next.sample(lat, lon);
  if (alpha === 0) {
    return a;
  }
  if (alpha === 1) {
    return b;
  }
  if (!a || !b) {
    return null;
  }
  const value = interpolateScalarValue(a.value ?? NaN, b.value ?? NaN, alpha);
  return {
    ...a,
    value: Number.isFinite(value) ? value : null,
    status: Number.isFinite(value)
      ? HOVERED_GRID_POINT_STATUS.VALUE
      : HOVERED_GRID_POINT_STATUS.MISSING,
  };
}

/** Two active GPU fields; only the blend uniform changes within a keyframe pair. */
// eslint-disable-next-line max-lines-per-function
export function createScalarInterpolator(
  getObjects: () => (TScalarObject | undefined)[]
) {
  let first: TPreparedScalarFrame | undefined;
  let next: TPreparedScalarFrame | undefined;
  const textures = new Map<THREE.ShaderMaterial, THREE.DataTexture>();
  const attributes = new Map<THREE.BufferGeometry, THREE.BufferAttribute>();

  function clear() {
    if (!first && !textures.size && !attributes.size) {
      return;
    }
    for (const object of getObjects()) {
      if (!object) {
        continue;
      }
      const material = object.material as THREE.ShaderMaterial;
      material.uniforms.scalarMix.value = 0;
      if (material.uniforms.dataNext) {
        material.uniforms.dataNext.value = material.uniforms.data.value;
      }
    }
    for (const texture of textures.values()) {
      texture.dispose();
    }
    for (const geometry of attributes.keys()) {
      // Three.js frees attribute buffers on geometry disposal, not deleteAttribute.
      // The existing geometry remains reusable and uploads again when next drawn.
      geometry.dispose();
      geometry.deleteAttribute("data_value_next");
    }
    textures.clear();
    attributes.clear();
    first = next = undefined;
  }

  // eslint-disable-next-line max-lines-per-function
  function render(
    a: TPreparedScalarFrame,
    b: TPreparedScalarFrame,
    alpha: number
  ) {
    if (first !== a) {
      if (next === a) {
        const materials = new Set<THREE.ShaderMaterial>();
        for (const object of getObjects()) {
          if (!object) {
            continue;
          }
          const material = object.material as THREE.ShaderMaterial;
          if (material.uniforms.data) {
            if (materials.has(material)) {
              continue;
            }
            materials.add(material);
            const previous = material.uniforms.data.value as THREE.DataTexture;
            material.uniforms.data.value = textures.get(material)!;
            textures.set(material, previous);
            material.uniforms.dataNext.value = previous;
          } else {
            const previous = object.geometry.getAttribute(
              "data_value"
            ) as THREE.BufferAttribute;
            object.geometry.setAttribute(
              "data_value",
              attributes.get(object.geometry)!
            );
            object.geometry.setAttribute("data_value_next", previous);
            attributes.set(object.geometry, previous);
          }
        }
      } else {
        a.render();
      }
      first = a;
      next = undefined;
    }
    const objects = getObjects();
    if (next !== b) {
      objects.forEach((object, i) => {
        if (!object) {
          return;
        }
        const material = object.material as THREE.ShaderMaterial;
        const values = b.interpolation!.values[i];
        if (material.uniforms.data) {
          // Regular batches share a material and the same scalar texture.
          const base = material.uniforms.data.value as THREE.DataTexture;
          const previous = textures.get(material);
          if (previous?.image.data !== values) {
            const texture = updateScalarTexture(
              previous,
              values,
              base.image.width,
              base.image.height
            );
            texture.wrapS = base.wrapS;
            texture.wrapT = base.wrapT;
            textures.set(material, texture);
            material.uniforms.dataNext.value = texture;
          }
        } else {
          const geometry = object.geometry;
          const count = geometry.getAttribute("data_value").count;
          let attribute = attributes.get(geometry);
          if (!attribute) {
            attribute = new THREE.BufferAttribute(
              new Float32Array(count),
              1
            ).setUsage(THREE.DynamicDrawUsage);
            attributes.set(geometry, attribute);
            geometry.setAttribute("data_value_next", attribute);
          }
          const indices = b.interpolation!.indices?.[i];
          if (indices && !geometry.index) {
            for (let j = 0; j < count; j++) {
              attribute.array[j] = values[indices[j]];
            }
          } else {
            attribute.array.set(values);
          }
          attribute.needsUpdate = true;
        }
      });
      next = b;
    }
    for (const object of objects) {
      if (object) {
        (object.material as THREE.ShaderMaterial).uniforms.scalarMix.value =
          alpha;
      }
    }
  }
  return { render, clear };
}
