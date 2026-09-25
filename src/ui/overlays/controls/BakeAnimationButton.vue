<script setup lang="ts">
import { computed, inject, ref } from "vue";

import PopupDialog from "./PopupDialog.vue";

import {
  SCALAR_BAKE_LIMITS,
  scalarBakeMemoryUsage,
} from "@/ui/grids/composables/scalarBakePlan.ts";
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
        class="button cell"
        :class="{ 'is-info': bake?.estimate }"
        :disabled="!bake"
        :aria-expanded="open"
        @click="toggle"
      >
        <span class="icon"><i class="fas fa-film" aria-hidden="true"></i></span>
        <span>Bake animation</span>
      </button>
    </template>
    <section v-if="bake" aria-label="Bake scalar animation">
      <p class="has-text-weight-semibold mb-2">Bake scalar animation</p>
      <p class="is-size-7 mb-3">
        Preload original timesteps for interactive playback. Interpolation and
        video export follow in later steps.
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
          Planning reference only; does not limit baking.
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
            and updated during baking.
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
      <div v-if="previewing" class="mt-3">
        <label class="label is-small" for="bake-seek"
          >Keyframe {{ bake.current + 1 }} / {{ bake.completed }}</label
        >
        <input
          id="bake-seek"
          class="w-100"
          type="range"
          :min="0"
          :max="bake.completed - 1"
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
            @click="bake.playing ? bake.pause() : bake.play()"
          >
            {{ bake.playing ? "Pause" : "Play" }}
          </button>
          <label class="label is-small mr-2" for="bake-fps"
            >Steps / second</label
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
          One original timestep per frame. Rotate and zoom the globe as usual.
          Close this popup to see the full view.
        </p>
      </div>
      <div class="buttons mt-3 mb-0">
        <button
          v-if="planned"
          class="button is-small is-info"
          type="button"
          @click="bake.bake()"
        >
          Bake {{ bake.estimate?.count }} keyframes
        </button>
        <button
          v-if="bake.busy || bake.estimate"
          class="button is-small"
          type="button"
          :disabled="bake.phase === SCALAR_BAKE_PHASE.CANCELLING"
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
