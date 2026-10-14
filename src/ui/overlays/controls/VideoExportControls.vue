<script setup lang="ts">
import { computed, inject, onScopeDispose, ref } from "vue";

import { PROJECTION_TYPES } from "@/lib/projection/projectionUtils.ts";
import {
  DEFAULT_SNAPSHOT_OPTIONS,
  type TSnapshotResolutionScale,
} from "@/lib/types/GlobeTypes.ts";
import { VIDEO_FORMAT, type TVideoFormat } from "@/lib/video/videoEncoding.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { SCALAR_BAKE_KEY } from "@/ui/grids/composables/useScalarBake.ts";
import { SCALAR_VIDEO_EXPORT_KEY } from "@/ui/grids/composables/useScalarVideoExport.ts";

const animation = inject(SCALAR_BAKE_KEY, undefined);
const video = inject(SCALAR_VIDEO_EXPORT_KEY, undefined);
const dialog = ref<HTMLDialogElement>();
const format = ref<TVideoFormat>(VIDEO_FORMAT.MP4);
const resolutionScale = ref<TSnapshotResolutionScale>(1);
const showDatasetInfo = ref(true);
const showColormap = ref(true);
const rotate = ref(false);
const store = useGlobeControlStore();
const canRotate = computed(
  () => store.projectionMode === PROJECTION_TYPES.NEARSIDE_PERSPECTIVE
);
const valid = computed(
  () =>
    animation &&
    animation.frameCount > 0 &&
    !animation.pathlinePlaybackError &&
    Number.isFinite(animation.fps) &&
    animation.fps >= 1 &&
    animation.fps <= 60
);

async function exportVideo() {
  if (!video || !valid.value || animation?.exporting) {
    return;
  }
  dialog.value?.showModal();
  try {
    await video.start(
      format.value,
      {
        ...DEFAULT_SNAPSHOT_OPTIONS,
        resolutionScale: resolutionScale.value,
        showDatasetInfo: showDatasetInfo.value,
        showColormap: showColormap.value,
      },
      rotate.value && canRotate.value
    );
  } finally {
    dialog.value?.close();
  }
}
onScopeDispose(() => animation?.cancelExport());
</script>

<template>
  <div class="mt-2">
    <template v-if="video && animation">
      <fieldset :disabled="animation.exporting">
        <label class="label is-small" for="animation-video-format"
          >Format</label
        >
        <div class="select is-small mb-2">
          <select id="animation-video-format" v-model="format">
            <option :value="VIDEO_FORMAT.MP4">Sharing · H.264 / MP4</option>
            <option :value="VIDEO_FORMAT.FFV1">Lossless · FFV1 / MKV</option>
          </select>
        </div>
        <label class="label is-small" for="animation-video-resolution"
          >Resolution</label
        >
        <div class="select is-small mb-2">
          <select id="animation-video-resolution" v-model="resolutionScale">
            <option :value="1">1× current view</option>
            <option :value="2">2× current view</option>
            <option :value="4">4× current view</option>
          </select>
        </div>
        <div class="field mb-1">
          <label class="checkbox is-size-7"
            ><input v-model="showDatasetInfo" type="checkbox" /> Dataset
            labels</label
          >
        </div>
        <div class="field mb-2">
          <label class="checkbox is-size-7"
            ><input v-model="showColormap" type="checkbox" /> Colormap
            bar</label
          >
        </div>
        <div class="field mb-2">
          <label class="checkbox is-size-7">
            <input v-model="rotate" type="checkbox" :disabled="!canRotate" />
            Rotate globe
          </label>
          <p class="help">
            {{
              canRotate
                ? "Same speed as Rotate (one turn every 30 seconds)."
                : "Rotation is available in globe view."
            }}
          </p>
        </div>
        <p class="help mb-2">
          Uses the selected interpolation, FPS, color bounds and current view.
          Labels and the colormap appear on the left.
        </p>
        <p class="help mb-2">
          The video stays in memory until download. Lossless files can be large.
        </p>
        <button
          type="button"
          class="button is-small is-info"
          :disabled="!valid"
          @click="exportVideo"
        >
          Export video
        </button>
      </fieldset>
      <p v-if="video.message" role="status" class="help">{{ video.message }}</p>
      <dialog
        ref="dialog"
        class="box"
        aria-labelledby="animation-export-title"
        @cancel.prevent="animation.cancelExport()"
      >
        <p id="animation-export-title" class="has-text-weight-semibold">
          Exporting animation
        </p>
        <p role="status" aria-live="polite" class="mt-2">
          {{ video.progress?.stage ?? "Preparing export" }}…
        </p>
        <progress
          class="progress is-info is-small mt-2"
          :value="video.progress?.completed || undefined"
          :max="video.progress?.total || 1"
        ></progress>
        <p v-if="video.progress" class="is-size-7 mb-3">
          {{ video.progress.completed }} / {{ video.progress.total }} frames ·
          {{ (video.progress.encodedBytes / 1024 ** 2).toFixed(1) }} MiB encoded
        </p>
        <button
          type="button"
          class="button is-small"
          autofocus
          @click="animation.cancelExport()"
        >
          Cancel export
        </button>
      </dialog>
    </template>
  </div>
</template>

<style scoped>
dialog:not([open]) {
  display: none;
}
</style>
