import * as THREE from "three";

import type {
  TGridGeometryBatch,
  TGridPointBatch,
} from "@/lib/grids/gridWorkerTypes.ts";

type TBatch = TGridGeometryBatch | TGridPointBatch;
type TGeometry = Pick<TGridGeometryBatch, "positionValues" | "latLonValues"> & {
  indices?: Uint32Array;
};
const sources = new WeakMap<THREE.BufferGeometry, TGeometry>();

/** Record static array identities; the display owns its mutable scalar attribute. */
export function captureScalarGeometry<T extends THREE.BufferGeometry>(
  geometry: T,
  batch: TBatch
): T {
  const attribute = geometry.getAttribute(
    "data_value"
  ) as THREE.BufferAttribute;
  if (attribute.array === batch.dataValues) {
    geometry.setAttribute(
      "data_value",
      new THREE.BufferAttribute(batch.dataValues.slice(), 1)
    );
  }
  (geometry.getAttribute("data_value") as THREE.BufferAttribute).setUsage(
    THREE.DynamicDrawUsage
  );
  sources.set(geometry, {
    positionValues: batch.positionValues,
    latLonValues: batch.latLonValues,
    indices: "indices" in batch ? batch.indices : undefined,
  });
  return geometry;
}

/** Upload only scalars when byte-checked shared geometry is unchanged. */
export function updateScalarGeometry(
  geometry: THREE.BufferGeometry | undefined,
  batch: TBatch
) {
  if (!geometry) {
    return false;
  }
  const previous = sources.get(geometry);
  const indices = "indices" in batch ? batch.indices : undefined;
  if (
    !previous ||
    previous.positionValues !== batch.positionValues ||
    previous.latLonValues !== batch.latLonValues ||
    previous.indices !== indices
  ) {
    return false;
  }
  const attribute = geometry.getAttribute(
    "data_value"
  ) as THREE.BufferAttribute;
  if (indices && !geometry.index) {
    // Curvilinear wrap geometry expands indexed corners into triangles once.
    for (let i = 0; i < indices.length; i++) {
      attribute.array[i] = batch.dataValues[indices[i]];
    }
  } else {
    attribute.array.set(batch.dataValues);
  }
  attribute.needsUpdate = true;
  return true;
}
