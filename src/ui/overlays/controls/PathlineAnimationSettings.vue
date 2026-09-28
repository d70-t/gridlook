<script setup lang="ts">
import type { TPathlineConfig } from "@/lib/data/pathlineTrajectories.ts";
import { pathlineWorkerLimit } from "@/lib/data/pathlineWorkers.ts";

const settings = defineModel<TPathlineConfig>({ required: true });
const emit = defineEmits<{ change: [] }>();
const workerLimit = pathlineWorkerLimit();
const fields = [
  {
    key: "sampleSeconds",
    label: "Trajectory sampling interval (s)",
    min: 0.001,
    step: "any",
  },
  {
    key: "maxStepSeconds",
    label: "Maximum integration step (s)",
    min: 0.001,
    step: "any",
  },
  {
    key: "maxStepMetres",
    label: "Maximum step distance (m)",
    min: 0.001,
    step: "any",
  },
  {
    key: "errorToleranceMetres",
    label: "Local error tolerance (m)",
    min: 0.001,
    step: "any",
  },
  { key: "randomSeed", label: "Random seed", min: 0, step: "1" },
] as const;
</script>

<template>
  <div class="mt-3 mb-3">
    <p class="label is-small">Horizontal pathlines</p>
    <p class="help mb-2">
      Uses the components and level selected in Streamlines, over the selected
      scalar field or vector magnitude. Particles follow dataset time. Random
      positions are seeded evenly across keyframes and integrated backward and
      forward through valid data. Components without orientation metadata are
      treated as east/north velocities.
    </p>
    <label class="label is-small" for="pathline-particles"
      >Particles (total)</label
    >
    <input
      id="pathline-particles"
      v-model.number="settings.particleCount"
      class="input is-small"
      type="number"
      min="1"
      step="1"
      @input="emit('change')"
    />
    <label class="label is-small mt-2" for="pathline-workers"
      >Integration workers</label
    >
    <input
      id="pathline-workers"
      v-model.number="settings.workerCount"
      class="input is-small"
      type="number"
      min="1"
      :max="workerLimit"
      step="1"
      @input="emit('change')"
    />
    <p class="help">
      Up to {{ workerLimit }} logical processors reported. More workers can
      shorten integration but need more RAM for velocity data.
    </p>
    <details class="mt-2">
      <summary class="is-size-7">Pathline integration settings</summary>
      <div v-for="field in fields" :key="field.key" class="field mt-2 mb-2">
        <label class="label is-small" :for="`pathline-${field.key}`">{{
          field.label
        }}</label>
        <input
          :id="`pathline-${field.key}`"
          v-model.number="settings[field.key]"
          class="input is-small"
          type="number"
          :min="field.min"
          :step="field.step"
          :max="field.key === 'randomSeed' ? 4294967295 : undefined"
          @input="emit('change')"
        />
      </div>
      <p class="help">
        Defaults favor quick visual exploration: 50 m local error tolerance and
        10 samples per shortest keyframe interval. Adaptive RK3(2). Lower the
        tolerance for greater integration accuracy; shorten the sampling
        interval for finer trajectory detail at a higher memory cost. These
        settings use dataset seconds, independently of playback FPS.
      </p>
    </details>
  </div>
</template>
