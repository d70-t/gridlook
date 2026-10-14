import { nextTick, reactive, ref, type InjectionKey } from "vue";

import type { useGridSnapshot } from "./useGridSnapshot.ts";
import { SCALAR_BAKE_PHASE, type useScalarBake } from "./useScalarBake.ts";

import { PROJECTION_TYPES } from "@/lib/projection/projectionUtils.ts";
import {
  SnapshotOverlayPositions,
  type TSnapshotOptions,
} from "@/lib/types/GlobeTypes.ts";
import {
  VIDEO_FORMAT_INFO,
  type TVideoFormat,
  type TVideoProgress,
} from "@/lib/video/videoEncoding.ts";
import { useGlobeControlStore } from "@/store/store.ts";

type TSnapshotHandle = Pick<
  ReturnType<typeof useGridSnapshot>,
  "createSnapshotRenderer"
>;

// eslint-disable-next-line max-lines-per-function
export function useScalarVideoExport(
  animation: ReturnType<typeof useScalarBake>,
  getHandle: () => TSnapshotHandle | null,
  getSource: () => string
) {
  const store = useGlobeControlStore();
  const progress = ref<TVideoProgress>();
  const message = ref("");

  // eslint-disable-next-line max-lines-per-function
  async function start(
    format: TVideoFormat,
    options: TSnapshotOptions,
    rotate = false
  ) {
    if (animation.exporting) {
      return;
    }
    message.value = "";
    progress.value = undefined;
    try {
      // Capture the dataset name before awaiting encoding or restoring playback.
      let name = store.datasetTitle.trim();
      const source = getSource();
      if (!name && source) {
        try {
          const url = new URL(source, document.baseURI);
          name = decodeURIComponent(
            url.pathname.split("/").filter(Boolean).at(-1) ?? ""
          ).replace(/\.(?:zarr(?:\.new)?|json|nc4?|netcdf)$/i, "");
        } catch {
          // Keep the generic filename if the source has no usable URL name.
        }
      }
      const suffix = Array.from(
        name.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}_-]+/gu, "-")
      )
        .slice(0, 60)
        .join("")
        .replace(/^-+|-+$/g, "");
      const filename = `gridlook${suffix ? `-${suffix}` : ""}.${VIDEO_FORMAT_INFO[format].extension}`;
      const rotateGlobe =
        rotate &&
        store.projectionMode === PROJECTION_TYPES.NEARSIDE_PERSPECTIVE;
      const blob = await animation.withPreparedFrames(async (session) => {
        const handle = getHandle();
        const wasRotating = store.isRotating;
        store.isRotating = false;
        let frames: ReturnType<TSnapshotHandle["createSnapshotRenderer"]>;
        try {
          await nextTick();
          session.signal.throwIfAborted();
          frames = handle?.createSnapshotRenderer({
            ...options,
            overlayPosition: SnapshotOverlayPositions.LEFT,
          });
          if (!frames) {
            throw new Error("The globe is not ready to export.");
          }
          const { encodeVideo } = await import("@/lib/video/encodeVideo.ts");
          return await encodeVideo(
            {
              width: frames.width,
              height: frames.height,
              frameCount: session.frameCount,
              fps: session.fps,
              format,
            },
            async (index) => {
              await session.seek(index);
              // Apply the displayed bounds and labels before reading GPU pixels.
              await nextTick();
              session.signal.throwIfAborted();
              return frames!.render(rotateGlobe ? index / session.fps : 0);
            },
            session.signal,
            (value) => {
              progress.value = value;
            }
          );
        } finally {
          frames?.dispose();
          if (
            getHandle() === handle &&
            animation.phase === SCALAR_BAKE_PHASE.READY
          ) {
            store.isRotating = wasRotating;
          }
        }
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.download = filename;
      link.href = url;
      try {
        link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      message.value =
        "Video exported. Your prepared animation is ready to use again.";
    } catch (error) {
      message.value =
        error instanceof DOMException && error.name === "AbortError"
          ? "Video export cancelled."
          : error instanceof Error
            ? error.message
            : String(error);
    }
  }
  return reactive({ progress, message, start });
}
export const SCALAR_VIDEO_EXPORT_KEY: InjectionKey<
  ReturnType<typeof useScalarVideoExport>
> = Symbol("scalarVideoExport");
