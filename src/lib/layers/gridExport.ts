// Export the currently rendered data grid as an equirectangular PNG texture.
// The grid is rendered offscreen with projection forced to equirectangular at
// center (0, 0), independent of the projection active in the viewer.

import * as THREE from "three";

import { getProjectionTypeFromMode } from "@/lib/projection/projectionShaders.ts";
import { PROJECTION_TYPES } from "@/lib/projection/projectionUtils.ts";

const EXPORT_WIDTH = 4096;
const EXPORT_HEIGHT = 2048;

type TUniformValue = { value: unknown };
type TGridObject = THREE.Mesh | THREE.Points;
type TRendererState = {
  clearColor: THREE.Color;
  clearAlpha: number;
  renderTarget: THREE.WebGLRenderTarget | null;
  viewport: THREE.Vector4;
  scissor: THREE.Vector4;
  scissorTest: boolean;
};

const EXPORT_WRAP_INSTANCE_COUNT = 3;

function isGridDataMaterial(
  material: THREE.Material | THREE.Material[]
): material is THREE.ShaderMaterial {
  return (
    material instanceof THREE.ShaderMaterial &&
    material.uniforms?.colormap !== undefined &&
    material.uniforms?.projectionType !== undefined
  );
}

function collectGridObjects(scene: THREE.Scene) {
  const gridObjects: TGridObject[] = [];

  scene.traverse((object) => {
    if (!object.visible) {
      return;
    }

    if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Points)) {
      return;
    }

    const renderable = object as TGridObject;
    if (isGridDataMaterial(renderable.material)) {
      gridObjects.push(renderable);
    }
  });

  return gridObjects;
}

function configureProjectionUniforms(material: THREE.ShaderMaterial) {
  const uniforms = material.uniforms as Record<string, TUniformValue>;
  if (uniforms.projectionType) {
    uniforms.projectionType.value = getProjectionTypeFromMode(
      PROJECTION_TYPES.EQUIRECTANGULAR
    );
  }
  if (uniforms.centerLon) {
    uniforms.centerLon.value = 0;
  }
  if (uniforms.centerLat) {
    uniforms.centerLat.value = 0;
  }
  if (uniforms.edgeQuality) {
    uniforms.edgeQuality.value = 1;
  }
  if (uniforms.projectionRadius) {
    uniforms.projectionRadius.value = 1;
  }
  material.depthTest = false;
  material.depthWrite = false;
}

function configureExportGeometry(geometry: THREE.BufferGeometry) {
  const instancedGeometry = geometry as THREE.InstancedBufferGeometry;
  if (
    instancedGeometry.isInstancedBufferGeometry &&
    geometry.getAttribute("wrapDirection")
  ) {
    instancedGeometry.instanceCount = EXPORT_WRAP_INSTANCE_COUNT;
  }
}

function cloneGridMaterial(material: THREE.ShaderMaterial) {
  const clone = material.clone();
  for (const [key, uniform] of Object.entries(material.uniforms)) {
    if (uniform.value instanceof THREE.Texture) {
      const clonedTexture = clone.uniforms[key]?.value;
      if (
        clonedTexture instanceof THREE.Texture &&
        clonedTexture !== uniform.value
      ) {
        clonedTexture.dispose();
      }
      clone.uniforms[key].value = uniform.value;
    }
  }
  return clone;
}

function cloneGridObject(object: TGridObject): TGridObject {
  const geometry = object.geometry.clone();
  const material = cloneGridMaterial(object.material as THREE.ShaderMaterial);
  configureExportGeometry(geometry);
  configureProjectionUniforms(material);

  const clone =
    object instanceof THREE.Points
      ? new THREE.Points(geometry, material)
      : new THREE.Mesh(geometry, material);
  clone.matrix.copy(object.matrixWorld);
  clone.matrixAutoUpdate = false;
  clone.renderOrder = object.renderOrder;
  clone.frustumCulled = false;
  return clone;
}

function createExportScene(scene: THREE.Scene) {
  scene.updateMatrixWorld(true);
  const exportScene = new THREE.Scene();
  const clones = collectGridObjects(scene).map(cloneGridObject);
  for (const clone of clones) {
    exportScene.add(clone);
  }
  return { exportScene, clones };
}

function disposeExportObjects(objects: TGridObject[]) {
  for (const object of objects) {
    object.geometry.dispose();
    (object.material as THREE.Material).dispose();
  }
}

function saveRendererState(renderer: THREE.WebGLRenderer): TRendererState {
  const clearColor = new THREE.Color();
  const viewport = new THREE.Vector4();
  const scissor = new THREE.Vector4();
  renderer.getClearColor(clearColor);
  renderer.getViewport(viewport);
  renderer.getScissor(scissor);
  return {
    clearColor,
    clearAlpha: renderer.getClearAlpha(),
    renderTarget: renderer.getRenderTarget() as THREE.WebGLRenderTarget | null,
    viewport,
    scissor,
    scissorTest: renderer.getScissorTest(),
  };
}

function restoreRendererState(
  renderer: THREE.WebGLRenderer,
  state: TRendererState
) {
  renderer.setRenderTarget(state.renderTarget);
  renderer.setViewport(
    state.viewport.x,
    state.viewport.y,
    state.viewport.z,
    state.viewport.w
  );
  renderer.setScissor(
    state.scissor.x,
    state.scissor.y,
    state.scissor.z,
    state.scissor.w
  );
  renderer.setScissorTest(state.scissorTest);
  renderer.setClearColor(state.clearColor, state.clearAlpha);
}

function readTargetPixels(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget
): Uint8Array {
  const pixels = new Uint8Array(EXPORT_WIDTH * EXPORT_HEIGHT * 4);
  renderer.readRenderTargetPixels(
    target,
    0,
    0,
    EXPORT_WIDTH,
    EXPORT_HEIGHT,
    pixels
  );
  return pixels;
}

function encodePixelsToBlob(pixels: Uint8Array): Promise<Blob> {
  // Flip vertically (GL reads bottom-up) into a canvas.
  const canvas = document.createElement("canvas");
  canvas.width = EXPORT_WIDTH;
  canvas.height = EXPORT_HEIGHT;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(EXPORT_WIDTH, EXPORT_HEIGHT);
  const rowBytes = EXPORT_WIDTH * 4;
  for (let y = 0; y < EXPORT_HEIGHT; y++) {
    const src = (EXPORT_HEIGHT - 1 - y) * rowBytes;
    imageData.data.set(pixels.subarray(src, src + rowBytes), y * rowBytes);
  }
  ctx.putImageData(imageData, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("PNG encoding failed")),
      "image/png"
    );
  });
}

/**
 * Render the visible data-grid objects as an equirectangular PNG (transparent
 * background) at center (0, 0) and return the image blob.
 */
export async function exportGridAsEquirectTexture(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene
): Promise<Blob> {
  const camera = new THREE.OrthographicCamera(
    -Math.PI,
    Math.PI,
    Math.PI / 2,
    -Math.PI / 2,
    0.1,
    10
  );
  camera.position.set(0, 0, 5);

  const target = new THREE.WebGLRenderTarget(EXPORT_WIDTH, EXPORT_HEIGHT);
  const { exportScene, clones } = createExportScene(scene);
  const savedRendererState = saveRendererState(renderer);

  let pixels: Uint8Array;
  try {
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
    renderer.setScissorTest(false);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(exportScene, camera);
    pixels = readTargetPixels(renderer, target);
  } finally {
    restoreRendererState(renderer, savedRendererState);
    disposeExportObjects(clones);
    target.dispose();
  }

  return encodePixelsToBlob(pixels);
}
