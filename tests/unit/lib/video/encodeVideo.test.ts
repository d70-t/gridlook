import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { VIDEO_FORMAT, VIDEO_STAGE } from "@/lib/video/videoEncoding.ts";

const mocks = vi.hoisted(() => ({
  wasmURL: "/core.wasm.gz",
  get: vi.fn(),
  load: vi.fn(),
  exec: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  deleteFile: vi.fn(),
  createDir: vi.fn(),
  mount: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock("@ffmpeg/core?url", () => ({ default: "/core.js" }));
vi.mock("virtual:ffmpeg-wasm", () => ({
  get default() {
    return mocks.wasmURL;
  },
}));
vi.mock("axios", () => ({ default: { get: mocks.get } }));
vi.mock("@ffmpeg/ffmpeg/worker?worker&url", () => ({ default: "/worker.js" }));
vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: class {
    constructor() {
      Object.assign(this, mocks);
    }
    on() {}
  },
  FFFSType: { WORKERFS: "WORKERFS" },
}));
const { encodeVideo } = await import("@/lib/video/encodeVideo.ts");
const settings = {
  width: 4,
  height: 2,
  frameCount: 500,
  fps: 30,
  format: VIDEO_FORMAT.FFV1,
};
let canvas: HTMLCanvasElement;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.wasmURL = "/core.wasm.gz";
  mocks.get.mockResolvedValue({
    data: new Blob([new Uint8Array(gzipSync(new Uint8Array([4, 5, 6])))]),
  });
  mocks.exec.mockResolvedValue(0);
  mocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8Array(32) }),
    }),
  } as unknown as HTMLCanvasElement;
  vi.stubGlobal("document", {
    baseURI: "https://gridlook.example/",
    createElement: () => canvas,
  });
});
afterEach(() => vi.unstubAllGlobals());

// eslint-disable-next-line max-lines-per-function
it("encodes bounded batches, joins compressed blobs, and releases the worker", async () => {
  let wasmURL = "";
  mocks.load.mockImplementation(async (options: { wasmURL: string }) => {
    wasmURL = options.wasmURL;
    const response = await fetch(wasmURL);
    expect(response.headers.get("Content-Type")).toBe("application/wasm");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([4, 5, 6])
    );
  });
  const render = vi.fn<(index: number) => Promise<HTMLCanvasElement>>(
    async () => canvas
  );
  const progress = vi.fn();
  const output = await encodeVideo(
    settings,
    render,
    new AbortController().signal,
    progress
  );
  expect(output.type).toBe("video/x-matroska");
  expect(render.mock.calls.map((args) => args[0])).toEqual(
    Array.from({ length: 500 }, (_, i) => i)
  );
  const writes = mocks.writeFile.mock.calls.filter(
    ([path]) => path === "input.rgba"
  );
  expect(writes).toHaveLength(17);
  expect(
    writes.slice(0, -1).every(([, data]) => data.byteLength === 30 * 32)
  ).toBe(true);
  expect(writes.at(-1)![1].byteLength).toBe(20 * 32);
  expect(mocks.deleteFile.mock.calls).toHaveLength(17);
  expect(mocks.mount).toHaveBeenCalledWith(
    "WORKERFS",
    {
      blobs: expect.arrayContaining([
        { name: "part-16.nut", data: expect.any(Blob) },
      ]),
    },
    "/segments"
  );
  expect(mocks.writeFile).toHaveBeenLastCalledWith(
    "frames.txt",
    expect.stringContaining(
      "file '/segments/part-16.nut'\nduration 0.6666666666666666\n"
    )
  );
  expect(progress).toHaveBeenLastCalledWith({
    stage: VIDEO_STAGE.FINALIZING,
    completed: 500,
    total: 500,
    encodedBytes: 51,
  });
  expect(mocks.get).toHaveBeenCalledOnce();
  expect(mocks.load).toHaveBeenCalledTimes(18);
  expect(mocks.terminate).toHaveBeenCalledTimes(18);
  // Each encode/join must execute in its own worker. Reusing one eventually
  // produces a WASM out-of-bounds error even though input batches are bounded.
  for (let index = 0; index < 18; index++) {
    const load = mocks.load.mock.invocationCallOrder[index];
    const exec = mocks.exec.mock.invocationCallOrder[index];
    const terminate = mocks.terminate.mock.invocationCallOrder[index];
    expect(load).toBeLessThan(exec);
    expect(exec).toBeLessThan(terminate);
    if (index < 17) {
      expect(terminate).toBeLessThan(
        mocks.load.mock.invocationCallOrder[index + 1]
      );
    }
  }
  expect(canvas.width).toBe(0);
  await expect(fetch(wasmURL)).rejects.toThrow();
});

it("terminates an in-flight encoder on cancellation and reports AbortError", async () => {
  const controller = new AbortController();
  mocks.exec.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        mocks.terminate.mockImplementation(() =>
          reject(new Error("terminated"))
        );
        controller.abort();
      })
  );
  await expect(
    encodeVideo(
      { ...settings, frameCount: 1 },
      async () => canvas,
      controller.signal,
      vi.fn()
    )
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.terminate).toHaveBeenCalled();
  expect(canvas.width).toBe(0);
});

it("cleans up when encoding fails and permits a fresh export", async () => {
  mocks.exec.mockResolvedValueOnce(1);
  await expect(
    encodeVideo(
      { ...settings, frameCount: 1 },
      async () => canvas,
      new AbortController().signal,
      vi.fn()
    )
  ).rejects.toThrow("Video encoding failed");
  expect(mocks.terminate).toHaveBeenCalledOnce();
  await expect(
    encodeVideo(
      { ...settings, frameCount: 1 },
      async () => canvas,
      new AbortController().signal,
      vi.fn()
    )
  ).resolves.toBeInstanceOf(Blob);
});

it("reports the failed stage and frame count when the encoder throws a runtime error", async () => {
  mocks.exec.mockRejectedValueOnce("RuntimeError: index out of bounds");
  await expect(
    encodeVideo(
      { ...settings, frameCount: 1 },
      async () => canvas,
      new AbortController().signal,
      vi.fn()
    )
  ).rejects.toThrow(
    "Encoding frames failed (1/1 frames, 4×2, ffv1). RuntimeError: index out of bounds"
  );
  expect(mocks.terminate).toHaveBeenCalledOnce();
});

it("downloads uncompressed WASM once and shares its URL across fresh workers", async () => {
  mocks.wasmURL = "/core.wasm";
  mocks.get.mockResolvedValue({ data: new Blob([new Uint8Array([4, 5, 6])]) });
  mocks.load.mockImplementation(async (options: { wasmURL: string }) => {
    const response = await fetch(options.wasmURL);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([4, 5, 6])
    );
  });
  await encodeVideo(
    { ...settings, frameCount: 31 },
    async () => canvas,
    new AbortController().signal,
    vi.fn()
  );
  expect(mocks.get).toHaveBeenCalledOnce();
  expect(mocks.load).toHaveBeenCalledTimes(3);
  expect(
    new Set(mocks.load.mock.calls.map(([options]) => options.wasmURL)).size
  ).toBe(1);
});
