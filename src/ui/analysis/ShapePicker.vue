<script lang="ts" setup>
import { computed, onMounted, ref, watch } from "vue";

import {
  importShapeFiles,
  SHAPE_ACCEPT,
  shapeDigest,
  shapeOfFeatures,
  type TImportedShape,
} from "@/lib/analysis/shapeImport.ts";
import {
  ANALYSIS_KINDS,
  GEOMETRY_KINDS,
  type TAnalysisKind,
  type TShapeGeometry,
} from "@/lib/analysis/types.ts";
import { PLOT_KIND_NAMES } from "@/store/analysisStore.ts";

/**
 * Import a shape to plot over: a file from this computer (picked or
 * dropped), any of its areas (a checklist; all by default), previewed on
 * the map together.
 */
const props = defineProps<{
  submitLabel: string;
  /** Files dropped on the map, read at once. */
  files?: File[];
  /** The plot, chosen here when the shape came first (dropped). */
  kind: TAnalysisKind;
  chooseKind?: boolean;
}>();
const emit = defineEmits<{
  select: [shape: TShapeGeometry, kind: TAnalysisKind];
  cancel: [];
  preview: [shape: TShapeGeometry | undefined];
}>();

const input = ref<HTMLInputElement>();
const chooser = ref<HTMLButtonElement>();
const shape = ref<TImportedShape>();
/** The areas of the file to plot together (indices). */
const chosen = ref<number[]>([]);
/** Filter of a long checklist. */
const filter = ref("");
const plotKind = ref<TAnalysisKind>(props.kind);
const geometry = ref<TShapeGeometry>();
const loading = ref(false);
const error = ref("");
const over = ref(false);
let reading = 0;

const AREA_KINDS = [ANALYSIS_KINDS.REGION_SERIES, ANALYSIS_KINDS.DISTRIBUTION];

const points = computed(
  () => shape.value?.features.reduce((n, f) => n + f.points, 0) ?? 0
);

async function read(files: File[]) {
  const ticket = ++reading;
  loading.value = true;
  error.value = "";
  shape.value = undefined;
  geometry.value = undefined;
  emit("preview", undefined);
  try {
    const imported = await importShapeFiles(files);
    if (ticket === reading) {
      shape.value = imported;
      filter.value = "";
      chosen.value = imported.features.map((_, at) => at);
    }
  } catch (cause) {
    if (ticket === reading) {
      error.value = (cause as Error).message || "The file could not be read.";
    }
  } finally {
    if (ticket === reading) {
      loading.value = false;
    }
  }
}

// The chosen area(s), clipped at the antimeridian, hashed and previewed.
watch([shape, chosen], async () => {
  const imported = shape.value;
  const ticket = reading;
  geometry.value = undefined;
  if (!imported || !chosen.value.length) {
    emit("preview", undefined);
    return;
  }
  try {
    // Clipped as country boundaries are (loaded only for imports).
    const { shapeRings } = await import("@/lib/analysis/countryGeoJSON.ts");
    const { name, polygons } = shapeOfFeatures(imported, chosen.value);
    const clipped = shapeRings(polygons, name);
    if (!clipped.length) {
      throw new Error("The shape encloses no area.");
    }
    const made: TShapeGeometry = {
      kind: GEOMETRY_KINDS.SHAPE,
      name,
      polygons: clipped,
      digest: shapeDigest(clipped),
    };
    if (ticket === reading && shape.value === imported) {
      geometry.value = made;
      emit("preview", made);
    }
  } catch (cause) {
    error.value = (cause as Error).message;
  }
});

// The checklist: names containing the filter (case and accents ignored).
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
const listed = computed(() => {
  const features = shape.value?.features ?? [];
  const typed = fold(filter.value.trim());
  return features
    .map((feature, at) => ({ name: feature.name, at }))
    .filter(({ name }) => !typed || fold(name).includes(typed));
});
const chosenSet = computed(() => new Set(chosen.value));

function toggle(at: number) {
  chosen.value = chosenSet.value.has(at)
    ? chosen.value.filter((other) => other !== at)
    : [...chosen.value, at].sort((a, b) => a - b);
}

/** All or none of the areas listed (the filter's, when filtering). */
function chooseListed(on: boolean) {
  const listedAt = new Set(listed.value.map(({ at }) => at));
  const kept = chosen.value.filter((at) => !listedAt.has(at));
  chosen.value = (on ? [...kept, ...listedAt] : kept).sort((a, b) => a - b);
}

function picked(event: Event) {
  const files = [...((event.target as HTMLInputElement).files ?? [])];
  if (files.length) {
    void read(files);
  }
}

function dropped(event: DragEvent) {
  over.value = false;
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length) {
    void read(files);
  }
}

function submit() {
  if (geometry.value && !loading.value) {
    emit("select", geometry.value, plotKind.value);
  }
}

onMounted(() => {
  if (props.files?.length) {
    void read(props.files);
  }
  chooser.value?.focus();
});
</script>

<template>
  <form
    aria-label="Import a shape"
    class="shape-form"
    @submit.prevent="submit"
    @keydown.esc.stop.prevent="emit('cancel')"
  >
    <div
      class="shape-drop"
      :class="{ over }"
      @dragover.prevent="over = true"
      @dragleave="over = false"
      @drop.prevent="dropped"
    >
      <i
        class="fa-solid fa-file-arrow-up shape-drop-icon"
        aria-hidden="true"
      ></i>
      <span class="shape-drop-line">
        <button
          ref="chooser"
          type="button"
          class="button is-small"
          @click="input?.click()"
        >
          Choose a file…
        </button>
        or drop it here
      </span>
      <span class="shape-help">
        GeoJSON, KML/KMZ or a Shapefile (.zip, or .shp with .dbf and .prj), in
        longitude/latitude. It stays on this computer.
      </span>
      <input
        ref="input"
        type="file"
        multiple
        class="is-hidden"
        :accept="SHAPE_ACCEPT"
        @change="picked"
      />
    </div>
    <p v-if="loading" role="status">Reading the file…</p>
    <p v-if="error" role="alert" class="shape-error">{{ error }}</p>
    <template v-if="shape">
      <p class="shape-file">
        <i class="fa-solid fa-draw-polygon mr-1" aria-hidden="true"></i>
        <strong>{{ shape.file }}</strong> |
        {{ shape.features.length }}
        {{ shape.features.length === 1 ? "area" : "areas" }} |
        {{ points.toLocaleString("en-US") }} points
        <span v-if="shape.skipped">
          | {{ shape.skipped }}
          {{ shape.skipped === 1 ? "point or line" : "points or lines" }}
          left out (only areas can be plotted)</span
        >
      </p>
      <fieldset v-if="shape.features.length > 1" class="shape-pieces">
        <legend>
          Areas | {{ chosen.length }} of {{ shape.features.length }} chosen
        </legend>
        <span class="shape-pieces-tools">
          <input
            v-if="shape.features.length > 8"
            v-model="filter"
            type="search"
            placeholder="Filter areas"
            aria-label="Filter areas"
          />
          <button
            type="button"
            class="button is-small is-text"
            @click="chooseListed(true)"
          >
            All
          </button>
          <button
            type="button"
            class="button is-small is-text"
            @click="chooseListed(false)"
          >
            None
          </button>
        </span>
        <ul class="shape-pieces-list">
          <li v-for="item in listed" :key="item.at">
            <label class="shape-piece">
              <input
                type="checkbox"
                :checked="chosenSet.has(item.at)"
                @change="toggle(item.at)"
              />
              <span>{{ item.name }}</span>
            </label>
          </li>
          <li v-if="!listed.length" class="shape-help">
            No area matches “{{ filter.trim() }}”
          </li>
        </ul>
      </fieldset>
    </template>
    <label v-if="chooseKind">
      <span>Plot</span>
      <select v-model="plotKind">
        <option v-for="k in AREA_KINDS" :key="k" :value="k">
          {{ PLOT_KIND_NAMES[k] }}
        </option>
      </select>
    </label>
    <p class="shape-help">
      The map shows the shape dashed. The page link carries it; a very detailed
      shape makes a long link (Share offers a session file).
    </p>
    <div class="buttons are-small is-right">
      <button type="button" class="button" @click="emit('cancel')">
        Cancel
      </button>
      <button
        type="submit"
        class="button is-link"
        :disabled="loading || !geometry || !chosen.length"
      >
        {{ submitLabel }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.shape-pieces {
  display: grid;
  gap: 0.3rem;
  border: 0;
  padding: 0;
  margin: 0;
}
.shape-pieces legend {
  font-size: 0.85rem;
}
.shape-pieces-tools {
  display: flex;
  gap: 4px;
  align-items: center;
}
.shape-pieces-tools input {
  flex: 1;
  min-width: 0;
}
/* In a plot's Settings (itself a scrolling panel) the list does not
   scroll on its own: one scroll, every area reachable. */
:global(.analysis-settings) .shape-pieces-list {
  max-height: none;
  overflow: visible;
}
.shape-pieces-list {
  max-height: 9.5rem;
  overflow: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}
.shape-form .shape-piece {
  display: flex;
  gap: 6px;
  align-items: center;
  min-height: 24px;
}
.shape-form,
.shape-form label {
  display: grid;
  gap: 0.4rem;
}
.shape-form {
  gap: 0.7rem;
}
.shape-form select {
  width: 100%;
  font: inherit;
  padding: 0.3rem;
  background: var(--plot-bg);
  color: var(--plot-fg);
  border: 1px solid var(--plot-border);
  border-radius: 4px;
}
.shape-drop {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 14px 10px;
  border: 1.5px dashed var(--plot-border);
  border-radius: 10px;
  text-align: center;
}
.shape-drop.over {
  border-color: var(--plot-accent);
  background: var(--plot-hover);
}
.shape-drop-line {
  display: flex;
  align-items: center;
  gap: 6px;
}
.shape-drop-icon {
  font-size: 1.4rem;
  color: var(--plot-accent);
}
.shape-help {
  color: var(--plot-muted);
  font-size: 0.78rem;
}
.shape-file {
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
.shape-error {
  color: var(--plot-danger);
}
</style>
