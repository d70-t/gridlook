import * as THREE from "three";
import type { Ref } from "vue";
import { watch } from "vue";

import { type ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  addWrapDirectionAttribute,
  createProjectionInstancedMesh,
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";

type ProjectionMesh = THREE.Mesh | undefined;

type ProjectionSyncOptions = {
  redraw: () => void;
  projectionHelper: ProjectionHelper;
  isSceneInMotion: boolean;
  radius?: number;
};

type ProjectionWatchOptions = {
  projectionMode: Ref<unknown>;
  projectionCenter: Ref<unknown>;
  isSceneInMotion: Ref<boolean>;
  onUpdate: () => void;
};

const TRIANGLE_WRAP_ATTRIBUTE_NAMES = [
  "triangleLatLon0",
  "triangleLatLon1",
  "triangleLatLon2",
] as const;

export function watchProjectionEdgeQuality(options: ProjectionWatchOptions) {
  const { projectionMode, projectionCenter, isSceneInMotion, onUpdate } =
    options;

  watch([projectionMode, projectionCenter], onUpdate, { deep: true });
  watch(isSceneInMotion, onUpdate);
}

export function updateProjectionMeshes(
  meshes: ProjectionMesh[],
  options: ProjectionSyncOptions
) {
  const { redraw, projectionHelper, isSceneInMotion, radius = 1.0 } = options;
  const useAccurateEdges = !isSceneInMotion;

  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    if (!mesh) {
      continue;
    }

    const material = mesh.material as THREE.ShaderMaterial;
    if (material.uniforms?.projectionType) {
      updateProjectionUniforms(
        material,
        projectionHelper,
        radius,
        mesh,
        useAccurateEdges
      );
    }
  }

  redraw();
}

export function setupProjectionGeometryWrap(
  geometry: THREE.InstancedBufferGeometry
): void {
  addWrapDirectionAttribute(geometry);
}

function copyGeometryAttributes(
  source: THREE.BufferGeometry,
  target: THREE.InstancedBufferGeometry
) {
  for (const name of Object.keys(source.attributes)) {
    target.setAttribute(name, source.getAttribute(name));
  }
}

function setTriangleLatLonAttribute(
  geometry: THREE.InstancedBufferGeometry,
  latLon: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  attributeName: string,
  corner: number
) {
  const values = new Float32Array(latLon.count * 2);

  for (
    let triangleOffset = 0;
    triangleOffset < latLon.count;
    triangleOffset += 3
  ) {
    const cornerIndex = triangleOffset + corner;
    const lat = latLon.getX(cornerIndex);
    const lon = latLon.getY(cornerIndex);

    for (let i = 0; i < 3; i++) {
      const targetOffset = (triangleOffset + i) * 2;
      values[targetOffset] = lat;
      values[targetOffset + 1] = lon;
    }
  }

  geometry.setAttribute(
    attributeName,
    new THREE.Float32BufferAttribute(values, 2)
  );
}

function addTriangleLatLonAttributes(geometry: THREE.InstancedBufferGeometry) {
  const latLon = geometry.getAttribute("latLon");
  if (!latLon || latLon.itemSize !== 2 || latLon.count % 3 !== 0) {
    return;
  }

  for (let corner = 0; corner < 3; corner++) {
    setTriangleLatLonAttribute(
      geometry,
      latLon,
      TRIANGLE_WRAP_ATTRIBUTE_NAMES[corner],
      corner
    );
  }
}

export function createTriangleWrapProjectionGeometry(
  geometry: THREE.InstancedBufferGeometry
): THREE.InstancedBufferGeometry {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const result = new THREE.InstancedBufferGeometry();
  copyGeometryAttributes(source, result);
  addTriangleLatLonAttributes(result);
  return result;
}

export function createWrappedProjectionMesh(
  geometry: THREE.InstancedBufferGeometry,
  material: THREE.Material,
  projectionType: ProjectionHelper["type"],
  useAccurateEdges = true
): THREE.Mesh {
  setupProjectionGeometryWrap(geometry);
  return createProjectionInstancedMesh(
    geometry,
    material,
    projectionType,
    useAccurateEdges
  );
}
