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
