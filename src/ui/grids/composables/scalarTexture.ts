import * as THREE from "three";

/** Keep GPU storage for equal-sized frames; source keyframe arrays stay immutable. */
export function updateScalarTexture(
  previous: THREE.Texture | undefined,
  data: Float32Array,
  width: number,
  height: number
) {
  if (
    previous instanceof THREE.DataTexture &&
    previous.image.width === width &&
    previous.image.height === height &&
    previous.format === THREE.RedFormat &&
    previous.type === THREE.FloatType
  ) {
    previous.image.data = data;
    previous.needsUpdate = true;
    return previous;
  }
  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RedFormat,
    THREE.FloatType
  );
  if (previous) {
    texture.wrapS = previous.wrapS;
    texture.wrapT = previous.wrapT;
    previous.dispose();
  }
  texture.needsUpdate = true;
  return texture;
}
