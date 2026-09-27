import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { expect, it, vi } from "vitest";

import {
  VIDEO_FORMAT,
  videoLayout,
  videoSegmentArgs,
  videoJoinArgs,
} from "@/lib/video/videoEncoding.ts";

type TTestCore = {
  FS: {
    writeFile: (path: string, data: string | Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
    unlink: (path: string) => void;
    mkdir: (path: string) => void;
    filesystems: { WORKERFS: unknown };
    mount: (fs: unknown, options: unknown, path: string) => void;
    unmount: (path: string) => void;
  };
  setLogger: (logger: (entry: { message: string }) => void) => void;
  reset: () => void;
  exec: (...args: string[]) => number;
};

// Node lacks FileReaderSync; keep the same slice/read contract as browser Blobs.
function readableBlob(bytes: Uint8Array): {
  size: number;
  bytes: Uint8Array;
  slice: (start: number, end: number) => ReturnType<typeof readableBlob>;
} {
  return {
    size: bytes.byteLength,
    bytes,
    slice: (start, end) => readableBlob(bytes.slice(start, end)),
  };
}

it("pads H.264 dimensions and bounds batches without limiting animation length", () => {
  const settings = {
    width: 1921,
    height: 1081,
    frameCount: 10000,
    fps: 30,
    format: VIDEO_FORMAT.MP4,
  };
  const layout = videoLayout(settings);
  expect([layout.width, layout.height]).toEqual([1922, 1082]);
  expect(layout.batchFrames * layout.frameBytes).toBeLessThanOrEqual(
    32 * 1024 ** 2
  );
  expect(videoLayout({ ...settings, format: VIDEO_FORMAT.FFV1 }).width).toBe(
    1921
  );
  expect(() => videoLayout({ ...settings, fps: NaN })).toThrow();
  expect(() => videoLayout({ ...settings, frameCount: 0 })).toThrow();
});

// Exercise the actual shipped WASM encoders and command builders, including
// concatenation across full batches and a final partial batch.
// eslint-disable-next-line max-lines-per-function
it("exports both formats with every timestamp intact and FFV1 pixel-exact", async () => {
  const require = createRequire(import.meta.url);
  const corePath = require.resolve("@ffmpeg/core");
  vi.stubGlobal("self", { location: { href: `file://${corePath}` } });
  vi.stubGlobal("importScripts", vi.fn());
  vi.stubGlobal(
    "FileReaderSync",
    class {
      readAsArrayBuffer(blob: ReturnType<typeof readableBlob>) {
        return blob.bytes.slice().buffer;
      }
    }
  );
  try {
    const createCore = require("@ffmpeg/core") as (options: {
      wasmBinary: Uint8Array;
    }) => Promise<TTestCore>;
    const core = await createCore({
      wasmBinary: await readFile(corePath.replace(/\.js$/, ".wasm")),
    });
    core.FS.mkdir("/segments");
    const logs: string[] = [];
    core.setLogger(({ message }) => logs.push(message));
    const run = (args: string[]) => {
      logs.length = 0;
      core.reset();
      expect(core.exec("-hide_banner", "-y", ...args), logs.join("\n")).toBe(0);
    };
    for (const format of Object.values(VIDEO_FORMAT)) {
      const settings = {
        width: 64,
        height: 48,
        frameCount: 35,
        fps: 30,
        format,
      };
      const layout = videoLayout(settings);
      const colors = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [32, 64, 128],
        [128, 128, 128],
        [255, 255, 255],
        [0, 0, 0],
        [205, 180, 45],
      ];
      const pixels = Uint8Array.from(
        { length: settings.frameCount * layout.frameBytes },
        (_, i) => {
          const frame = Math.floor(i / layout.frameBytes);
          const x = Math.floor(i / 4) % layout.width;
          return i % 4 === 3
            ? 255
            : colors[(Math.floor(x / 8) + frame) % colors.length][i % 4];
        }
      );
      let manifest = "";
      const blobs: { name: string; data: ReturnType<typeof readableBlob> }[] =
        [];
      for (
        let start = 0;
        start < settings.frameCount;
        start += layout.batchFrames
      ) {
        const count = Math.min(layout.batchFrames, settings.frameCount - start);
        core.FS.writeFile(
          "input.rgba",
          pixels.slice(
            start * layout.frameBytes,
            (start + count) * layout.frameBytes
          )
        );
        run(videoSegmentArgs(settings));
        blobs.push({
          name: `part-${start}.nut`,
          data: readableBlob(core.FS.readFile("segment.nut")),
        });
        core.FS.unlink("segment.nut");
        core.FS.unlink("input.rgba");
        manifest += `file '/segments/part-${start}.nut'\nduration ${count / settings.fps}\n`;
      }
      core.FS.mount(core.FS.filesystems.WORKERFS, { blobs }, "/segments");
      core.FS.writeFile("frames.txt", manifest);
      const joinArgs = videoJoinArgs(format);
      run(joinArgs);
      core.FS.unmount("/segments");
      const output = joinArgs.at(-1)!;
      run([
        "-i",
        output,
        "-vsync",
        "0",
        "-pix_fmt",
        "rgba",
        "-f",
        "rawvideo",
        "decoded.rgba",
      ]);
      const decoded = core.FS.readFile("decoded.rgba");
      expect(decoded.length).toBe(pixels.length);
      if (format === VIDEO_FORMAT.FFV1) {
        expect(decoded).toEqual(pixels);
      } else {
        // Sample inside saturated and neutral patches, away from YUV420 edges.
        for (let frame = 0; frame < settings.frameCount; frame++) {
          for (let x = 4; x < layout.width; x += 8) {
            const offset =
              frame * layout.frameBytes + (24 * layout.width + x) * 4;
            for (let channel = 0; channel < 3; channel++) {
              expect(
                Math.abs(decoded[offset + channel] - pixels[offset + channel]),
                `frame ${frame}, patch ${x}, channel ${channel}`
              ).toBeLessThanOrEqual(8);
            }
          }
        }
      }
      run(["-i", output, "-vf", "showinfo", "-f", "null", "-"]);
      if (format === VIDEO_FORMAT.MP4) {
        expect(logs.join("\n")).toContain("color_space:bt709");
        expect(logs.join("\n")).toContain("color_range:tv");
      }
      const times = logs
        .filter((line) => /n:\s*\d+.*pts_time:/.test(line))
        .map((line) => Number(/pts_time:([\d.]+)/.exec(line)![1]));
      expect(times).toHaveLength(settings.frameCount);
      times.forEach((time, index) =>
        expect(Math.abs(time - index / settings.fps)).toBeLessThan(0.00051)
      );
    }
  } finally {
    vi.unstubAllGlobals();
  }
}, 30000);
