import * as THREE from "three";
import { expect, it } from "vitest";

import { createTriangleWrapProjectionGeometry } from "@/lib/projection/projectionEdgeQuality.ts";
import { shareScalarGeometry } from "@/ui/grids/composables/scalarFrameMemory.ts";
import {
  captureScalarGeometry,
  updateScalarGeometry,
} from "@/ui/grids/composables/scalarGeometry.ts";

it.each([false, true])(
  "updates only scalar GPU attributes without mutating retained frames (expanded: %s)",
  // eslint-disable-next-line max-lines-per-function
  (expanded) => {
    const cache = new Map();
    const first = shareScalarGeometry(
      {
        batchIndex: 0,
        positionValues: new Float32Array([1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1]),
        latLonValues: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
        dataValues: new Float32Array([10, 20, 30, 40]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      },
      cache
    );
    const next = shareScalarGeometry(
      {
        ...first,
        positionValues: first.positionValues.slice(),
        latLonValues: first.latLonValues.slice(),
        indices: first.indices.slice(),
        dataValues: new Float32Array([50, 60, 70, 80]),
      },
      cache
    );
    let geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(first.positionValues, 3)
    );
    geometry.setAttribute(
      "latLon",
      new THREE.BufferAttribute(first.latLonValues, 2)
    );
    geometry.setAttribute(
      "data_value",
      new THREE.BufferAttribute(first.dataValues, 1)
    );
    geometry.setIndex(new THREE.BufferAttribute(first.indices, 1));
    if (expanded) {
      geometry = createTriangleWrapProjectionGeometry(geometry);
    }
    captureScalarGeometry(geometry, first);
    const attributes = { ...geometry.attributes };
    expect(updateScalarGeometry(geometry, next)).toBe(true);
    expect(geometry.attributes).toEqual(attributes);
    expect([...geometry.getAttribute("data_value").array]).toEqual(
      expanded ? [50, 60, 70, 50, 70, 80] : [50, 60, 70, 80]
    );
    expect([...first.dataValues]).toEqual([10, 20, 30, 40]);
    expect(updateScalarGeometry(geometry, first)).toBe(true);
    expect([...next.dataValues]).toEqual([50, 60, 70, 80]);
    expect(
      updateScalarGeometry(geometry, {
        ...next,
        positionValues: new Float32Array(12),
      })
    ).toBe(false);
    expect(
      (geometry.getAttribute("position") as THREE.BufferAttribute).version
    ).toBe(0);
    expect(
      (geometry.getAttribute("data_value") as THREE.BufferAttribute).version
    ).toBe(2);
  }
);
