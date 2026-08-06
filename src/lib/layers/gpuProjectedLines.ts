import * as THREE from "three";

import gpuProjectedLineFragmentShader from "@/lib/layers/glsl/gpuProjectedLine.frag.glsl";
import gpuProjectedLineVertexShader from "@/lib/layers/glsl/gpuProjectedLine.vert.glsl";
import { getProjectionTypeFromMode } from "@/lib/projection/projectionShaders.ts";
import {
  AZIMUTHAL_CLIP_ANGLE,
  type ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";

type TGpuProjectedLineOptions = {
  color: THREE.ColorRepresentation;
  radius: number;
  zOffset: number;
};

const OVERLAY_AZIMUTHAL_CLIP_MARGIN_DEGREES = 1.0;

export function makeGpuProjectedLineMaterial(
  options: TGpuProjectedLineOptions
) {
  return new THREE.ShaderMaterial({
    uniforms: {
      lineColor: { value: new THREE.Color(options.color) },
      projectionType: { value: 0 },
      centerLon: { value: 0.0 },
      centerLat: { value: 0.0 },
      projectionRadius: { value: options.radius },
      azimuthalClipRadius: {
        value:
          ((AZIMUTHAL_CLIP_ANGLE - OVERLAY_AZIMUTHAL_CLIP_MARGIN_DEGREES) *
            Math.PI) /
          180.0,
      },
      zOffset: { value: options.zOffset },
    },
    transparent: true,
    depthWrite: false,
    vertexShader: gpuProjectedLineVertexShader,
    fragmentShader: gpuProjectedLineFragmentShader,
  });
}

export function updateGpuProjectedLineMaterial(
  material: THREE.ShaderMaterial,
  helper: ProjectionHelper,
  options: Omit<TGpuProjectedLineOptions, "color">
) {
  material.uniforms.projectionType.value = getProjectionTypeFromMode(
    helper.type
  );
  material.uniforms.centerLon.value = helper.center.lon;
  material.uniforms.centerLat.value = helper.center.lat;
  material.uniforms.projectionRadius.value = options.radius;
  material.uniforms.zOffset.value = options.zOffset;
  material.depthTest = !helper.isFlat;
}
