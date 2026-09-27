<script setup lang="ts">
import { computed, inject, ref } from "vue";

import PopupDialog from "./PopupDialog.vue";
import VideoExportControls from "./VideoExportControls.vue";

import {
  SCALAR_BAKE_LIMITS,
  scalarBakeMemoryUsage,
} from "@/ui/grids/composables/scalarBakePlan.ts";
import { SCALAR_INTERPOLATION } from "@/ui/grids/composables/scalarTimeline.ts";
import {
  SCALAR_BAKE_KEY,
  SCALAR_BAKE_PHASE,
} from "@/ui/grids/composables/useScalarBake.ts";

const bake = inject(SCALAR_BAKE_KEY, undefined);
const open = ref(false);
const start = ref(0);
const end = ref(1);
const budgetGiB = ref<number>(SCALAR_BAKE_LIMITS.DEFAULT_MEMORY_GIB);
const configured = ref(false);
const previewing = computed(() => bake?.phase === SCALAR_BAKE_PHASE.READY);
const planned = computed(() => bake?.phase === SCALAR_BAKE_PHASE.PLANNED);
const memoryUsage = computed(() =>
  bake?.estimate
    ? scalarBakeMemoryUsage(bake.estimate.peakBytes, budgetGiB.value)
    : undefined
);

function toggle() {
  if (
    !open.value &&
    bake?.time &&
    (!configured.value ||
      start.value < bake.time.minBound ||
      end.value > bake.time.maxBound)
  ) {
    start.value =
      bake.time.selectedIndex < bake.time.maxBound
        ? bake.time.selectedIndex
        : Math.max(bake.time.minBound, bake.time.maxBound - 9);
    end.value = Math.min(start.value + 9, bake.time.maxBound);
    configured.value = true;
  }
  open.value = !open.value;
}
function changed() {
  bake?.clear();
}
function memory(bytes: number) {
  return `${(bytes / SCALAR_BAKE_LIMITS.GIB).toFixed(2)} GiB`;
}
function duration(seconds: number) {
  if (seconds < 60) {
    return `${Math.max(1, Math.ceil(seconds))} s`;
  }
  return `${Math.ceil(seconds / 60)} min`;
}
</script>

<template>
  <PopupDialog v-model:open="open" dialog-class="scalar-bake-dialog">
    <template #trigger>
      <button
        type="button"
        class="button w-100"
        :class="{ 'is-info': bake?.estimate }"
        :disabled="!bake"
        :aria-expanded="open"
        @click="toggle"
      >
        <span class="icon"><i class="fas fa-film" aria-hidden="true"></i></span>
        <span>Animation</span>
      </button>
    </template>
    <section v-if="bake" aria-label="Animation">
      <p class="has-text-weight-semibold mb-2">Animation</p>
      <p class="is-size-7 mb-3">
        Preload original timesteps for interactive playback and interpolate
        between them, or export the animation as a video.
      </p>
      <p
        v-if="bake.unavailable"
        class="notification is-warning is-light p-2 is-size-7"
      >
        {{ bake.unavailable }}
      </p>
      <fieldset :disabled="bake.busy || previewing">
        <div class="columns is-mobile mb-0">
          <div class="column pb-1">
            <label class="label is-small" for="bake-start">Start index</label>
            <input
              id="bake-start"
              v-model.number="start"
              class="input is-small"
              type="number"
              :min="bake.time?.minBound"
              :max="bake.time?.maxBound"
              step="1"
              @input="changed"
            />
          </div>
          <div class="column pb-1">
            <label class="label is-small" for="bake-end">End index</label>
            <input
              id="bake-end"
              v-model.number="end"
              class="input is-small"
              type="number"
              :min="bake.time?.minBound"
              :max="bake.time?.maxBound"
              step="1"
              @input="changed"
            />
          </div>
        </div>
        <p v-if="bake.time" class="help mb-2">
          Available indices: {{ bake.time.minBound }}–{{ bake.time.maxBound }}.
          Other dimensions use their current selections.
        </p>
        <button
          class="button is-small"
          type="button"
          :disabled="!!bake.unavailable"
          @click="bake.plan({ start, end })"
        >
          Estimate · loads one timestep
        </button>
      </fieldset>
      <div class="field mt-3 mb-2">
        <label class="label is-small" for="bake-memory"
          >Memory budget (GiB)</label
        >
        <input
          id="bake-memory"
          v-model.number="budgetGiB"
          class="input is-small"
          type="number"
          min="0.5"
          step="0.5"
          aria-describedby="bake-memory-help"
        />
        <p id="bake-memory-help" class="help">
          Planning reference only; does not limit preparation.
        </p>
      </div>
      <div v-if="bake.estimate" class="content is-small mt-3 mb-2">
        <p class="mb-1">
          <strong>{{ bake.estimate.count }} keyframes</strong> · approximately
          {{ duration(bake.estimate.secondsLow) }}–{{
            duration(bake.estimate.secondsHigh)
          }}
          to prepare
        </p>
        <p class="mb-1">
          Retained data: {{ memory(bake.estimate.retainedBytes) }} · estimated
          peak RAM: {{ memory(bake.estimate.peakBytes) }}
          <span v-if="memoryUsage !== undefined">
            ({{ memoryUsage.toFixed(0) }}% of budget)
          </span>
        </p>
        <p class="mb-1">
          Active GPU data: up to {{ memory(bake.estimate.gpuBytes) }} additional
        </p>
        <details>
          <summary>Estimate details</summary>
          <p>
            {{ bake.estimate.uniqueChunks }} distinct scalar chunks, up to
            {{ memory(bake.estimate.decodedBytes) }} decoded. Compressed
            download size and cache hits are unknown. Source decode/cache
            allowance: {{ memory(bake.estimate.sourceWorkingBytes) }}.
            <span v-if="bake.estimate.chunkConcurrency !== undefined">
              At most {{ bake.estimate.chunkConcurrency }} scalar chunks decoded
              concurrently.
            </span>
            Peak RAM also includes preparation/display buffers and 25% headroom.
            Existing globe/browser memory is additional. Timing is approximate
            and updated during preparation.
          </p>
        </details>
      </div>
      <p v-if="bake.message" class="help is-danger" role="alert">
        {{ bake.message }}
      </p>
      <div v-if="bake.busy" role="status" aria-live="polite" class="mt-3">
        <p v-if="bake.phase === SCALAR_BAKE_PHASE.ESTIMATING">
          Preparing the sample timestep…
        </p>
        <p v-else-if="bake.phase === SCALAR_BAKE_PHASE.CANCELLING">
          Cancelling after the current operation finishes…
        </p>
        <p v-else>
          {{ bake.completed }} / {{ bake.estimate?.count }} prepared · about
          {{ duration(bake.remainingSeconds) }} remaining
        </p>
        <progress
          class="progress is-info is-small mt-2"
          :value="bake.completed || undefined"
          :max="bake.estimate?.count || 1"
        ></progress>
      </div>
      <fieldset v-if="previewing" class="mt-3" :disabled="bake.exporting">
        <p v-if="bake.bounds" class="help mb-3">
          Time-range min/max: {{ bake.bounds.low.toPrecision(5) }} –
          {{ bake.bounds.high.toPrecision(5) }}. Select Animation under
          Appearance → Colormap to apply these bounds to display and export.
        </p>
        <div class="field">
          <label class="label is-small" for="bake-interpolation"
            >Interpolation</label
          >
          <div class="select is-small">
            <select
              id="bake-interpolation"
              v-model="bake.interpolationMode"
              @change="bake.resetPlayback()"
            >
              <option :value="SCALAR_INTERPOLATION.ORIGINAL">
                Original timesteps
              </option>
              <option
                :value="SCALAR_INTERPOLATION.LINEAR"
                :disabled="!!bake.interpolationUnavailable"
              >
                Linear
              </option>
              <option
                :value="SCALAR_INTERPOLATION.SMOOTHSTEP"
                :disabled="!!bake.interpolationUnavailable"
              >
                Smoothstep (cubic)
              </option>
            </select>
          </div>
          <p v-if="bake.interpolationUnavailable" class="help">
            {{ bake.interpolationUnavailable }}
          </p>
        </div>
        <div
          v-if="bake.interpolationMode !== SCALAR_INTERPOLATION.ORIGINAL"
          class="field"
        >
          <label class="label is-small" for="bake-intermediate"
            >Intermediate frames per interval</label
          >
          <input
            id="bake-intermediate"
            v-model.number="bake.intermediateFrames"
            class="input is-small"
            type="number"
            min="0"
            step="1"
            @input="bake.resetPlayback()"
          />
          <p class="help">
            Only original keyframes are stored. Missing cells stay missing
            between endpoints; source-time gaps are bridged.
          </p>
          <p
            v-if="bake.interpolationMode === SCALAR_INTERPOLATION.SMOOTHSTEP"
            class="help"
          >
            Eases into and out of each keyframe with zero slope and no
            overshoot.
          </p>
          <p v-if="!bake.frameCount" class="help is-danger">
            Enter a non-negative whole number of intermediate frames.
          </p>
          <p
            v-if="bake.unequalTimeGaps"
            class="notification is-warning is-light p-2 is-size-7"
            role="status"
          >
            Source timestamps have unequal gaps. Equal frame counts per interval
            mean the simulated time advances at different speeds.
          </p>
        </div>
        <p v-if="bake.frameCount && bake.fps > 0" class="help mb-2">
          {{ bake.frameCount }} frames ·
          {{ (bake.frameCount / bake.fps).toFixed(2) }} s at {{ bake.fps }} fps
        </p>
        <label class="label is-small" for="bake-seek"
          >Frame {{ bake.current + 1 }} / {{ bake.frameCount }}</label
        >
        <input
          id="bake-seek"
          class="w-100"
          type="range"
          :min="0"
          :max="Math.max(0, bake.frameCount - 1)"
          :disabled="!bake.frameCount"
          :value="bake.current"
          @input="
            bake.pause();
            bake.seek(Number(($event.target as HTMLInputElement).value));
          "
        />
        <div class="field is-grouped mt-2 mb-1">
          <button
            class="button is-small is-info mr-2"
            type="button"
            :disabled="!bake.frameCount"
            @click="bake.playing ? bake.pause() : bake.play()"
          >
            {{ bake.playing ? "Pause" : "Play" }}
          </button>
          <label class="label is-small mr-2" for="bake-fps"
            >Frames / second</label
          >
          <input
            id="bake-fps"
            v-model.number="bake.fps"
            class="input is-small"
            type="number"
            min="1"
            :max="SCALAR_BAKE_LIMITS.MAX_FPS"
            step="1"
            @input="bake.pause()"
          />
        </div>
        <p class="help">
          Rotate and zoom the globe as usual. Close this popup to see the full
          view.
        </p>
      </fieldset>
      <VideoExportControls v-if="previewing" />
      <div class="buttons mt-3 mb-0">
        <button
          v-if="planned"
          class="button is-small is-info"
          type="button"
          @click="bake.bake()"
        >
          Prepare {{ bake.estimate?.count }} keyframes
        </button>
        <button
          v-if="bake.busy || bake.estimate"
          class="button is-small"
          type="button"
          :disabled="
            bake.phase === SCALAR_BAKE_PHASE.CANCELLING || bake.exporting
          "
          @click="bake.clear()"
        >
          {{ bake.busy ? "Cancel" : "Release animation" }}
        </button>
        <button class="button is-small" type="button" @click="open = false">
          Close
        </button>
      </div>
    </section>
  </PopupDialog>
</template>

<style lang="scss">
.scalar-bake-dialog {
  max-width: 26rem;
  max-height: 65vh;
  overflow-y: auto;
}
</style>
