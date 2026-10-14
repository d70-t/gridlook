<script setup lang="ts">
import { computed, inject, ref } from "vue";

import PathlineAnimationSettings from "./PathlineAnimationSettings.vue";
import PopupDialog from "./PopupDialog.vue";
import VideoExportControls from "./VideoExportControls.vue";

import { PATHLINE_DISPLAY } from "@/lib/layers/pathlinePreview.ts";
import { LAYER_OPACITY } from "@/store/store.ts";
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
const pathlineSettings = ref(bake?.defaultPathlineConfig(0, 1));
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
    if (!configured.value) {
      pathlineSettings.value = bake.defaultPathlineConfig(
        start.value,
        end.value
      );
    }
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
      <p v-if="!previewing" class="is-size-7 mb-3">
        Prepare enabled layers for playback or video export.
      </p>
      <p
        v-if="bake.unavailable"
        class="notification is-warning is-light p-2 is-size-7"
      >
        {{ bake.unavailable }}
      </p>
      <details :open="!previewing" class="mb-3">
        <summary class="has-text-weight-semibold mb-2">
          {{
            previewing
              ? `${bake.estimate?.count} keyframes prepared`
              : "Preparation"
          }}
        </summary>
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
            Available indices: {{ bake.time.minBound }}–{{
              bake.time.maxBound
            }}. Other dimensions use their current selections.
          </p>
          <PathlineAnimationSettings
            v-if="bake.pathlinesEnabled && pathlineSettings"
            v-model="pathlineSettings"
            @change="changed"
          />
          <button
            class="button is-small"
            type="button"
            :disabled="!!bake.unavailable"
            @click="
              bake.plan({
                start,
                end,
                pathlines: bake.pathlinesEnabled ? pathlineSettings : undefined,
              })
            "
          >
            Estimate preparation
          </button>
          <p v-if="!previewing" class="help">
            Loads one timestep to estimate time and memory.
          </p>
        </fieldset>
        <div v-if="bake.estimate" class="content is-small mt-3 mb-2">
          <p class="mb-1">
            <strong>{{ bake.estimate.count }} keyframes</strong> · approximately
            {{ duration(bake.estimate.secondsLow) }}–{{
              duration(bake.estimate.secondsHigh)
            }}
            to prepare
          </p>
          <p class="mb-1">
            Estimated peak RAM: {{ memory(bake.estimate.peakBytes) }}
          </p>
          <details class="mt-2">
            <summary>Memory and estimate details</summary>
            <div class="field mt-3 mb-2">
              <label class="label is-small" for="bake-memory"
                >Memory reference (GiB)</label
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
            <p class="mb-1">
              Retained data: {{ memory(bake.estimate.retainedBytes) }}
              <span v-if="memoryUsage !== undefined">
                · peak RAM is {{ memoryUsage.toFixed(0) }}% of the reference
              </span>
            </p>
            <p class="mb-1">
              Active GPU data: up to
              {{ memory(bake.estimate.gpuBytes) }} additional
            </p>
            <p v-if="bake.hasPathlines" class="mb-1">
              Velocity data: {{ memory(bake.estimate.vectorBytes ?? 0) }} ·
              Trajectories: {{ memory(bake.estimate.trajectoryBytes ?? 0) }} ·
              Display buffers:
              {{ memory(bake.estimate.pathlineDisplayBytes ?? 0) }} · Worker
              data: {{ memory(bake.estimate.pathlineWorkerBytes ?? 0) }}
            </p>
            <p v-if="bake.hasVolumes" class="mb-1">
              Volume keyframes: {{ memory(bake.estimate.volumeBytes ?? 0) }} ·
              Preparation buffers:
              {{ memory(bake.estimate.volumeWorkingBytes ?? 0) }}
            </p>
            <p>
              Up to {{ bake.estimate.uniqueChunks }} source chunks,
              {{ memory(bake.estimate.decodedBytes) }} decoded.
              <span v-if="bake.hasVolumes"
                >Overlapping layer reads may be counted more than once.</span
              >
              Compressed download size and cache hits are unknown. Source
              decode/cache allowance:
              {{ memory(bake.estimate.sourceWorkingBytes) }}.
              <span v-if="bake.estimate.chunkConcurrency !== undefined">
                At most {{ bake.estimate.chunkConcurrency }} source chunks
                decoded concurrently.
              </span>
              <span v-if="bake.estimate.pathlinePreviewBytes"
                >Display buffers include
                {{ memory(bake.estimate.pathlinePreviewBytes) }} for fast
                preview. GPU totals allow for both preview modes and
                export.</span
              >
              Peak RAM also includes preparation/display buffers and 25%
              headroom. Existing globe/browser memory is additional. Timing is
              approximate and updated during preparation.
            </p>
          </details>
        </div>
      </details>
      <p v-if="bake.message" class="help is-danger" role="alert">
        {{ bake.message }}
      </p>
      <button
        v-if="planned"
        class="button is-small is-info"
        type="button"
        @click="bake.bake()"
      >
        Prepare {{ bake.estimate?.count }} keyframes
      </button>
      <div v-if="bake.busy" role="status" aria-live="polite" class="mt-3">
        <p v-if="bake.phase === SCALAR_BAKE_PHASE.ESTIMATING">
          Preparing the sample timestep…
        </p>
        <p v-else-if="bake.phase === SCALAR_BAKE_PHASE.CANCELLING">
          Cancelling after the current operation finishes…
        </p>
        <p
          v-else-if="
            bake.hasPathlines && bake.completed === bake.estimate?.count
          "
        >
          Preparing pathlines · {{ Math.floor(bake.trajectoryProgress * 100) }}%
          · about {{ duration(bake.remainingSeconds) }} remaining
        </p>
        <p v-else>
          {{ bake.completed }} / {{ bake.estimate?.count }} prepared · about
          {{ duration(bake.remainingSeconds) }} remaining
        </p>
        <progress
          class="progress is-info is-small mt-2"
          :value="
            bake.hasPathlines && bake.completed === bake.estimate?.count
              ? bake.trajectoryProgress
              : bake.completed || undefined
          "
          :max="
            bake.hasPathlines && bake.completed === bake.estimate?.count
              ? 1
              : bake.estimate?.count || 1
          "
        ></progress>
      </div>
      <fieldset v-if="previewing" class="mt-3" :disabled="bake.exporting">
        <div class="columns is-mobile mb-0">
          <div class="column pb-1">
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
          </div>
          <div
            v-if="bake.interpolationMode !== SCALAR_INTERPOLATION.ORIGINAL"
            class="column pb-1"
          >
            <label class="label is-small" for="bake-intermediate"
              >Intermediate frames</label
            >
            <input
              id="bake-intermediate"
              v-model.number="bake.intermediateFrames"
              class="input is-small"
              type="number"
              min="0"
              step="1"
              aria-label="Intermediate frames per interval"
              @input="bake.resetPlayback()"
            />
          </div>
        </div>
        <p v-if="bake.interpolationUnavailable" class="help">
          {{ bake.interpolationUnavailable }}
        </p>
        <div v-if="bake.interpolationMode !== SCALAR_INTERPOLATION.ORIGINAL">
          <p
            v-if="bake.interpolationMode === SCALAR_INTERPOLATION.SMOOTHSTEP"
            class="help"
          >
            Slows at each keyframe. Use Linear for a steady pace.
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
        <p
          v-if="bake.pathlinePlaybackError"
          class="help is-danger"
          role="alert"
        >
          {{ bake.pathlinePlaybackError }}
        </p>
        <label class="label is-small mt-3" for="bake-seek">
          Frame {{ bake.current + 1 }} / {{ bake.frameCount }}
          <span
            v-if="bake.frameCount && bake.fps > 0"
            class="has-text-weight-normal"
          >
            · {{ (bake.frameCount / bake.fps).toFixed(2) }} s
          </span>
        </label>
        <input
          id="bake-seek"
          class="w-100"
          type="range"
          :min="0"
          :max="Math.max(0, bake.frameCount - 1)"
          :disabled="!bake.frameCount || !!bake.pathlinePlaybackError"
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
            :disabled="!bake.frameCount || !!bake.pathlinePlaybackError"
            @click="bake.playing ? bake.pause() : bake.play()"
          >
            {{ bake.playing ? "Pause" : "Play" }}
          </button>
          <label class="label is-small mr-2" for="bake-fps">FPS</label>
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
          Playback continues with this window closed. Rotate and zoom as usual.
        </p>
        <details v-if="bake.hasPathlines" class="mt-3">
          <summary class="is-size-7 has-text-weight-semibold mb-2">
            Particle appearance
          </summary>
          <label class="label is-small" for="pathline-display"
            >Particle preview</label
          >
          <div class="select is-small mb-2">
            <select
              id="pathline-display"
              v-model="bake.particleDisplayMode"
              @change="bake.refreshPathlines()"
            >
              <option
                :value="PATHLINE_DISPLAY.PREVIEW"
                :disabled="!bake.estimate?.pathlinePreviewBytes"
              >
                Fast preview
              </option>
              <option :value="PATHLINE_DISPLAY.TRAJECTORY">
                Full trajectory
              </option>
            </select>
          </div>
          <p class="help mb-3">
            Fast preview approximates motion between keyframes. Export always
            uses full trajectories; both follow the selected interpolation
            timing.
          </p>
          <p v-if="!bake.estimate?.pathlinePreviewBytes" class="help mb-3">
            Fast preview exceeds this device's texture dimensions. Full
            trajectories remain available.
          </p>
          <label class="label is-small" for="pathline-size">
            Particle size (px): {{ bake.particleSize }}
          </label>
          <input
            id="pathline-size"
            v-model.number="bake.particleSize"
            class="w-100 mb-2"
            type="range"
            min="1"
            max="20"
            step="0.5"
            @input="bake.refreshPathlines()"
          />
          <label class="label is-small" for="pathline-opacity">
            Particle opacity: {{ (bake.particleOpacity * 100).toFixed(0) }}%
          </label>
          <input
            id="pathline-opacity"
            v-model.number="bake.particleOpacity"
            class="w-100 mb-2"
            type="range"
            :min="LAYER_OPACITY.MIN"
            :max="LAYER_OPACITY.MAX"
            :step="LAYER_OPACITY.STEP"
            @input="bake.refreshPathlines()"
          />
          <p class="help mb-3">
            Changes apply to playback and export without preparing again.
          </p>
          <label class="label is-small" for="pathline-fade"
            >Fade duration (dataset seconds)</label
          >
          <input
            id="pathline-fade"
            v-model.number="bake.fadeSeconds"
            class="input is-small"
            type="number"
            min="0.001"
            step="any"
            @input="bake.refreshPathlines()"
          />
          <p class="help">
            Fades particles at trajectory endpoints and time-range boundaries.
          </p>
        </details>
        <details class="mt-3">
          <summary class="is-size-7">Playback details</summary>
          <p v-if="bake.bounds" class="help">
            Time-range min/max: {{ bake.bounds.low.toPrecision(5) }} –
            {{ bake.bounds.high.toPrecision(5) }}. Applied automatically after
            preparation; change the bounds under Appearance → Colormap.
          </p>
          <p class="help">
            Interpolation retains only original keyframes. Missing scalar cells
            stay missing; source-time gaps are bridged.
          </p>
          <p v-if="bake.hasVolumes" class="help">
            Volume normalization stays fixed across the time range. Edit colors
            and opacity in Layers. Missing cells fade to zero. Preview uses
            reduced quality for speed; export uses full quality.
          </p>
        </details>
      </fieldset>
      <details v-if="previewing" class="mt-3">
        <summary class="has-text-weight-semibold">Video export</summary>
        <VideoExportControls />
      </details>
      <div class="buttons mt-3 mb-0">
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
