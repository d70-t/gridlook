import coreURL from "@ffmpeg/core?url";
import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import classWorkerURL from "@ffmpeg/ffmpeg/worker?worker&url";
import axios from "axios";
import wasmURL from "virtual:ffmpeg-wasm";

import {
  VIDEO_FORMAT_INFO,
  VIDEO_STAGE,
  videoLayout,
  videoSegmentArgs,
  videoJoinArgs,
  type TVideoProgress,
  type TVideoSettings,
} from "./videoEncoding.ts";

async function loadWasmURL(signal: AbortSignal) {
  const url = new URL(wasmURL, document.baseURI).href;
  // Fetch once for the whole export, including development's uncompressed asset.
  // Each fresh worker reads the same Blob URL without downloading WASM again.
  const { data } = await axios.get<Blob>(url, { responseType: "blob", signal });
  const blob = url.endsWith(".gz")
    ? await new Response(
        data.stream().pipeThrough(new DecompressionStream("gzip")),
        {
          headers: { "Content-Type": "application/wasm" },
        }
      ).blob()
    : new Blob([data], { type: "application/wasm" });
  signal.throwIfAborted();
  return URL.createObjectURL(blob);
}

// eslint-disable-next-line max-lines-per-function
export async function encodeVideo(
  settings: TVideoSettings,
  renderFrame: (index: number) => Promise<HTMLCanvasElement>,
  signal: AbortSignal,
  progress: (value: TVideoProgress) => void
): Promise<Blob> {
  const layout = videoLayout(settings);
  const ffmpeg = new FFmpeg();
  const cancel = () => ffmpeg.terminate();
  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Could not create the video frame canvas.");
  }
  const segments: { name: string; data: Blob }[] = [];
  let manifest = "";
  let loadedWasmURL: string | undefined;
  let stage: TVideoProgress["stage"] = VIDEO_STAGE.LOADING;
  let completed = 0;
  let encodedBytes = 0;
  const logs: string[] = [];
  ffmpeg.on("log", ({ message }) => {
    logs.push(message);
    if (logs.length > 12) {
      logs.shift();
    }
  });
  const report = (nextStage: TVideoProgress["stage"]) => {
    signal.throwIfAborted();
    stage = nextStage;
    progress({ stage, completed, total: settings.frameCount, encodedBytes });
  };
  const run = async (args: string[]) => {
    signal.throwIfAborted();
    logs.length = 0;
    if ((await ffmpeg.exec(["-hide_banner", "-y", ...args])) !== 0) {
      throw new Error(`Video encoding failed. ${logs.join("\n")}`);
    }
    signal.throwIfAborted();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    report(VIDEO_STAGE.LOADING);
    loadedWasmURL = await loadWasmURL(signal);
    signal.throwIfAborted();
    const workerConfig = {
      classWorkerURL,
      coreURL: new URL(coreURL, document.baseURI).href,
      wasmURL: loadedWasmURL,
    };
    for (
      let start = 0;
      start < settings.frameCount;
      start += layout.batchFrames
    ) {
      // @ffmpeg/core 0.12.10 corrupts state after repeated exec calls, even
      // with tiny inputs. Give each batch (and the final join) its own worker.
      signal.throwIfAborted();
      await ffmpeg.load(workerConfig);
      const count = Math.min(layout.batchFrames, settings.frameCount - start);
      const pixels = new Uint8Array(count * layout.frameBytes);
      for (let index = 0; index < count; index++) {
        report(VIDEO_STAGE.RENDERING);
        const frame = await renderFrame(start + index);
        signal.throwIfAborted();
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(frame, 0, 0);
        pixels.set(
          ctx.getImageData(0, 0, canvas.width, canvas.height).data,
          index * layout.frameBytes
        );
        completed++;
        // Allow cancellation even with cached frames and synchronous GPU rendering.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      report(VIDEO_STAGE.ENCODING);
      await ffmpeg.writeFile("input.rgba", pixels);
      await run(videoSegmentArgs(settings));
      await ffmpeg.deleteFile("input.rgba");
      const bytes = await ffmpeg.readFile("segment.nut");
      if (typeof bytes === "string") {
        throw new Error("Video encoder returned invalid data.");
      }
      const name = `part-${segments.length}.nut`;
      segments.push({
        name,
        data: new Blob([bytes as Uint8Array<ArrayBuffer>]),
      });
      encodedBytes += bytes.byteLength;
      manifest += `file '/segments/${name}'\nduration ${count / settings.fps}\n`;
      ffmpeg.terminate();
    }
    report(VIDEO_STAGE.FINALIZING);
    await ffmpeg.load(workerConfig);
    // WORKERFS reads the compressed Blobs without copying all inputs into MEMFS.
    await ffmpeg.createDir("/segments");
    await ffmpeg.mount(FFFSType.WORKERFS, { blobs: segments }, "/segments");
    await ffmpeg.writeFile("frames.txt", manifest);
    await run(videoJoinArgs(settings.format));
    const info = VIDEO_FORMAT_INFO[settings.format];
    const output = await ffmpeg.readFile(`output.${info.extension}`);
    signal.throwIfAborted();
    if (typeof output === "string") {
      throw new Error("Video encoder returned invalid data.");
    }
    return new Blob([output as Uint8Array<ArrayBuffer>], { type: info.mime });
  } catch (error) {
    signal.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${stage} failed (${completed}/${settings.frameCount} frames, ${layout.width}×${layout.height}, ${settings.format}). ${message}`
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    ffmpeg.terminate();
    if (loadedWasmURL?.startsWith("blob:")) {
      URL.revokeObjectURL(loadedWasmURL);
    }
    canvas.width = canvas.height = 0;
  }
}
