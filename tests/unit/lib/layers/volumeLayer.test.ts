import {
  ClampToEdgeWrapping,
  RepeatWrapping,
  type ShaderMaterial,
} from "three";
import { expect, it } from "vitest";

import { VolumeLayer } from "@/lib/layers/volumeLayer.ts";
import { getProjectionTypeFromMode } from "@/lib/projection/projectionShaders.ts";
import {
  ProjectionHelper,
  PROJECTION_TYPES,
} from "@/lib/projection/projectionUtils.ts";

it("keeps the volume texture and appearance through every projection and center change", () => {
  const layer = new VolumeLayer();
  try {
    layer.setData(
      new Uint8Array(8),
      { width: 2, height: 2, depth: 2, byteLength: 8 },
      1,
      1,
      ["#ffffff"],
      [0.5],
      { west: 177, east: 183, south: 20, north: 22 }
    );
    const material = layer.object.material as ShaderMaterial;
    const texture = material.uniforms.volumeData.value;
    expect(texture.wrapT).toBe(ClampToEdgeWrapping);
    for (const type of [
      ...Object.values(PROJECTION_TYPES),
      PROJECTION_TYPES.NEARSIDE_PERSPECTIVE,
    ]) {
      const projection = new ProjectionHelper(type, { lat: 40, lon: 170 });
      layer.setProjection(projection);
      expect(material.uniforms.volumeData.value).toBe(texture);
      expect(material.uniforms.projectionType.value).toBe(
        getProjectionTypeFromMode(type)
      );
      expect(material.uniforms.centerLat.value).toBe(40);
      expect(material.uniforms.centerLon.value).toBe(170);
      expect(material.uniforms.channelOpacities.value[0]).toBe(0.5);
      expect(material.depthTest).toBe(!projection.isFlat);
      expect(layer.object.geometry.type).toBe(
        projection.isFlat ? "PlaneGeometry" : "SphereGeometry"
      );
    }
    layer.setData(
      new Uint8Array(8),
      { width: 2, height: 2, depth: 2, byteLength: 8 },
      1,
      1,
      ["#ffffff"],
      [1],
      { west: -180, east: 180, south: -90, north: 90 }
    );
    expect(material.uniforms.volumeData.value.wrapT).toBe(RepeatWrapping);
  } finally {
    layer.dispose();
  }
});
