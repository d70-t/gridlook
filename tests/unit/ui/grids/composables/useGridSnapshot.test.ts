import * as THREE from "three";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ref } from "vue";

import {
  SnapshotBackgrounds,
  SnapshotOverlayPositions,
} from "@/lib/types/GlobeTypes.ts";

const gradient = vi.hoisted(() => ({
  render: vi.fn(),
  dispose: vi.fn(),
  forceContextLoss: vi.fn(),
}));
vi.mock("three", async (original) => ({
  ...(await original<typeof import("three")>()),
  WebGLRenderer: class {
    render = gradient.render;
    dispose = gradient.dispose;
    forceContextLoss = gradient.forceContextLoss;
    setSize() {}
  },
}));
vi.stubGlobal("localStorage", { getItem: () => null });
vi.mock("@/ui/common/useLog.ts", () => ({
  useLog: () => ({ logError: vi.fn() }),
}));
const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useGridSnapshot } =
  await import("@/ui/grids/composables/useGridSnapshot.ts");
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => vi.unstubAllGlobals());

function createCanvas() {
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 7 }),
    createImageData: (w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: vi.fn(),
  };
  return {
    width: 320,
    height: 160,
    getContext: () => context,
    toBlob: (callback: BlobCallback) =>
      callback(new Blob(["png"], { type: "image/png" })),
  };
}

// eslint-disable-next-line max-lines-per-function
function setup() {
  const store = useGlobeControlStore();
  store.varnameDisplay = "temperature";
  store.varinfo = {
    attrs: { units: "K" },
    bounds: { low: 0, high: 1 },
    dimInfo: [{ current: 0, values: [0, 1, 2], attrs: {} }],
    dimRanges: [{ name: "time", minBound: 0, maxBound: 2, startPos: 0 }],
  };
  const link = { href: "", download: "", click: vi.fn() };
  vi.stubGlobal("document", {
    createElement: (tag: string) => (tag === "canvas" ? createCanvas() : link),
  });
  const canvas = ref(createCanvas() as unknown as HTMLCanvasElement);
  const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 100);
  camera.position.z = 5;
  const base = new THREE.Mesh(
    new THREE.SphereGeometry(1),
    new THREE.MeshBasicMaterial()
  );
  const scene = new THREE.Scene();
  scene.add(base);
  let renderTarget: THREE.WebGLRenderTarget | null = null;
  const renderer = {
    outputColorSpace: THREE.SRGBColorSpace,
    capabilities: { maxTextureSize: 4096 },
    getClearColor: (color: THREE.Color) => color.set(0),
    getClearAlpha: () => 1,
    getRenderTarget: () => renderTarget,
    setClearColor: vi.fn(),
    setRenderTarget: vi.fn((target: THREE.WebGLRenderTarget | null) => {
      renderTarget = target;
    }),
    render: vi.fn(),
    readRenderTargetPixels: vi.fn(),
  };
  const snapshot = useGridSnapshot({
    canvas,
    getRenderer: () => renderer as unknown as THREE.WebGLRenderer,
    getScene: () => scene,
    getCamera: () => camera,
    getBaseSurface: () => base,
    render: () => false,
  });
  const options = {
    background: SnapshotBackgrounds.BLACK,
    resolutionScale: 1 as const,
    showDatasetInfo: false,
    showColormap: false,
  };
  return { snapshot, canvas, camera, link, options, store, renderer, base };
}

it.each([false, true])(
  "reuses fixed frame dimensions and refreshes labels (metadata: %s)",
  (showDatasetInfo) => {
    const h = setup();
    const frames = h.snapshot.createSnapshotRenderer({
      ...h.options,
      showDatasetInfo,
    })!;
    h.store.scalarAnimationTime = { index: 0, label: "First time" };
    const first = frames.render();
    const dimensions = [first.width, first.height];
    const context = first.getContext("2d")!;
    if (showDatasetInfo) {
      expect(context.fillText).toHaveBeenCalledWith(
        "time: First time",
        expect.any(Number),
        expect.any(Number)
      );
    }
    h.canvas.value.width *= 2;
    h.canvas.value.height *= 2;
    h.camera.position.z = 10;
    h.store.scalarAnimationTime = { index: 0, label: "Second time" };
    expect(frames.render()).toBe(first);
    expect([first.width, first.height]).toEqual(dimensions);
    expect(context.clearRect).toHaveBeenCalledTimes(2);
    if (showDatasetInfo) {
      expect(context.fillText).toHaveBeenCalledWith(
        "time: Second time",
        expect.any(Number),
        expect.any(Number)
      );
    }
    const renderedCamera = h.renderer.render.mock
      .calls[0][1] as THREE.PerspectiveCamera;
    expect(renderedCamera).not.toBe(h.camera);
    expect(renderedCamera.position.z).toBe(5);
    expect(h.renderer.render.mock.calls[1][1]).toBe(renderedCamera);
    expect(h.renderer.setRenderTarget.mock.calls[0][0]).toBe(
      h.renderer.setRenderTarget.mock.calls[2][0]
    );
    const target = h.renderer.setRenderTarget.mock
      .calls[0][0] as THREE.WebGLRenderTarget;
    const dispose = vi.spyOn(target, "dispose");
    frames.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(() => frames.render()).toThrow("released");
    expect(h.link.click).not.toHaveBeenCalled();
  }
);

it("still downloads a PNG through the snapshot action", () => {
  const h = setup();
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  try {
    h.snapshot.makeSnapshot(h.options);
    expect(h.link.download).toBe("gridlook.png");
    expect(h.link.click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(h.link.href);
  } finally {
    revoke.mockRestore();
  }
});

it("restores the live renderer and background when capture fails", () => {
  const h = setup();
  const color = h.base.material.color.getHex();
  const frames = h.snapshot.createSnapshotRenderer({
    ...h.options,
    background: SnapshotBackgrounds.WHITE,
  })!;
  h.renderer.readRenderTargetPixels.mockImplementationOnce(() => {
    throw new Error("readback failed");
  });
  expect(() => frames.render()).toThrow("readback failed");
  expect(h.renderer.setRenderTarget).toHaveBeenLastCalledWith(null);
  expect(h.base.material.color.getHex()).toBe(color);
  expect(h.renderer.setClearColor).toHaveBeenLastCalledWith(
    expect.any(THREE.Color),
    1
  );
  frames.dispose();
});

it("copies the colormap into a reusable 2D canvas and releases its WebGL context", () => {
  gradient.render.mockClear();
  gradient.dispose.mockClear();
  gradient.forceContextLoss.mockClear();
  const h = setup();
  const frames = h.snapshot.createSnapshotRenderer({
    ...h.options,
    showColormap: true,
  })!;
  const canvas = frames.render();
  const ctx = canvas.getContext("2d")!;
  const bar = vi.mocked(ctx.drawImage).mock.calls[0][0] as HTMLCanvasElement;
  expect(bar.getContext("2d")!.drawImage).toHaveBeenCalledOnce();
  frames.render();
  expect(vi.mocked(ctx.drawImage).mock.calls[1][0]).toBe(bar);
  expect(gradient.render).toHaveBeenCalledOnce();
  expect(gradient.dispose).toHaveBeenCalledOnce();
  expect(gradient.forceContextLoss).toHaveBeenCalledOnce();
  frames.dispose();
});

it("puts metadata and legend beside the image, formats source time and keeps the live camera unchanged", () => {
  const h = setup();
  h.store.varinfo!.dimInfo[0] = {
    current: 59.5,
    values: [59.5, 60, 61],
    attrs: { units: "days since 2000-01-01", calendar: "360_day" },
  };
  const frames = h.snapshot.createSnapshotRenderer({
    ...h.options,
    showDatasetInfo: true,
    showColormap: true,
    overlayPosition: SnapshotOverlayPositions.LEFT,
  })!;
  const canvas = frames.render(7.5);
  const ctx = canvas.getContext("2d")!;
  const globeDraw = vi.mocked(ctx.drawImage).mock.calls[0];
  const globeX = globeDraw[5] as number;
  expect(globeX).toBeGreaterThan(0);
  const text = vi.mocked(ctx.fillText).mock.calls;
  expect(
    text
      .map(([line]) => line)
      .join(" ")
      .replace(/\s+/g, " ")
  ).toContain("30 Feb 2000 • 12:00:00 (360_day)");
  expect(text.every(([, x]) => x < globeX)).toBe(true);
  const legendDraw = vi.mocked(ctx.drawImage).mock.calls[1];
  expect((legendDraw[1] as number) + (legendDraw[3] as number)).toBeLessThan(
    globeX
  );
  const captured = h.renderer.render.mock
    .calls[0][1] as THREE.PerspectiveCamera;
  // Quarter turn in 7.5 seconds, matching OrbitControls' two turns per minute.
  expect(captured.position.x).toBeCloseTo(-5);
  expect(captured.position.z).toBeCloseTo(0);
  const quarterTurn = captured.quaternion.clone();
  frames.render(30);
  expect(captured.position.z).toBeCloseTo(5);
  frames.render(7.5);
  expect(captured.quaternion.equals(quarterTurn)).toBe(true);
  expect(h.camera.position.toArray()).toEqual([0, 0, 5]);
  expect(h.camera.quaternion.toArray()).toEqual([0, 0, 0, 1]);
  expect([canvas.width, canvas.height]).toEqual([frames.width, frames.height]);
  frames.dispose();
});

it.each([5, 1.15])(
  "preserves the full video viewport and camera at distance %s, without a border",
  (distance) => {
    const h = setup();
    h.canvas.value.width = 640;
    h.canvas.value.height = 360;
    h.camera.position.z = distance;
    h.camera.zoom = 1.2;
    h.camera.setViewOffset(640, 360, 10, 0, 630, 360);
    const projection = h.camera.projectionMatrix.clone();
    for (const overlays of [false, true]) {
      const frames = h.snapshot.createSnapshotRenderer({
        ...h.options,
        showDatasetInfo: overlays,
        showColormap: overlays,
        overlayPosition: SnapshotOverlayPositions.LEFT,
      })!;
      const canvas = frames.render();
      const context = canvas.getContext("2d")!;
      const globeDraw = vi.mocked(context.drawImage).mock.calls[0];
      // The optional sidebar sits beside the viewport; neither crops nor scales it.
      const sidebarWidth = canvas.width - 640;
      expect(globeDraw.slice(1)).toEqual([
        0,
        0,
        640,
        360,
        sidebarWidth,
        0,
        640,
        360,
      ]);
      expect(canvas.height).toBe(360);
      if (!overlays) {
        expect(canvas.width).toBe(640);
      }
      expect(context.fillRect).toHaveBeenCalledWith(
        0,
        0,
        canvas.width,
        canvas.height
      );
      expect(h.renderer.setClearColor).toHaveBeenCalledWith(0, 1);
      const captured = h.renderer.render.mock
        .lastCall![1] as THREE.PerspectiveCamera;
      expect(captured.position.z).toBe(distance);
      expect(captured.zoom).toBe(h.camera.zoom);
      expect(captured.projectionMatrix.equals(projection)).toBe(true);
      frames.dispose();
    }
  }
);

it.each([false, true])(
  "matches canvas color conversion and restores material hooks (readback failure: %s)",
  (failReadback) => {
    const h = setup();
    const material = h.base.material;
    const compile = vi.fn();
    material.onBeforeCompile = compile;
    const cacheKey = material.customProgramCacheKey;
    const originalKey = material.customProgramCacheKey();
    const fragmentShader = "void main() {\n#include <colorspace_fragment>\n}";
    const shader = () =>
      ({ fragmentShader }) as Parameters<THREE.Material["onBeforeCompile"]>[0];
    h.renderer.render.mockImplementation(() => {
      const target = h.renderer.getRenderTarget()!;
      expect(target.texture.colorSpace).toBe(THREE.NoColorSpace);
      const captured = shader();
      material.onBeforeCompile(
        captured,
        h.renderer as unknown as THREE.WebGLRenderer
      );
      expect(captured.fragmentShader).toContain("sRGBTransferOETF");
      expect(captured.fragmentShader).not.toContain("#include");
      expect(material.customProgramCacheKey()).not.toBe(originalKey);
    });
    if (failReadback) {
      h.renderer.readRenderTargetPixels.mockImplementationOnce(() => {
        throw new Error("readback failed");
      });
    }
    const frames = h.snapshot.createSnapshotRenderer(h.options)!;
    if (failReadback) {
      expect(() => frames.render()).toThrow("readback failed");
    } else {
      frames.render();
    }
    const live = shader();
    material.onBeforeCompile(
      live,
      h.renderer as unknown as THREE.WebGLRenderer
    );
    expect(live.fragmentShader).toBe(fragmentShader);
    expect(material.customProgramCacheKey()).toBe(originalKey);
    expect(compile).toHaveBeenCalledTimes(2);
    frames.dispose();
    expect(material.onBeforeCompile).toBe(compile);
    expect(material.customProgramCacheKey).toBe(cacheKey);
  }
);
