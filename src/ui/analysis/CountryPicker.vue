<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import {
  DEMO_CLICK,
  DEMO_CLICK2,
  DEMO_EUROPE,
  DEMO_FRAME,
  DEMO_FRANCE,
  DEMO_GERMANY,
  DEMO_LAYERS,
} from "./countryDemo.ts";
import { registerCountryPicker } from "./countryPicking.ts";
import { guidesSeen, markGuideSeen } from "./drawGuides.ts";

import { getCountryList, MAX_COUNTRIES } from "@/lib/analysis/countryAtlas.ts";
import {
  COUNTRY_RESOLUTIONS,
  countriesGeometry,
  countryIds,
  type TCountryResolution,
  type TCountryGeometry,
} from "@/lib/analysis/types.ts";

const props = defineProps<{
  initial?: TCountryGeometry;
  submitLabel: string;
  /** Offer importing a shape instead (a new plot's picker). */
  offerShapes?: boolean;
  /**
   * A phone: the map must stay in view, so the illustration is folded
   * into one line ("Tap a country…"), shown only when asked.
   */
  compact?: boolean;
  /**
   * At the top of the map, as the drawing guides are (25 Nov): one row
   * (search, detail, actions) and one line of hint, the illustration on
   * request, so the map stays in view.
   */
  bar?: boolean;
}>();
const emit = defineEmits<{
  select: [country: TCountryGeometry];
  cancel: [];
  /** Not a country: the scientist's own boundaries from a file. */
  importShape: [];
  /** The country currently chosen (for the map's outline) and the scale. */
  preview: [
    country: TCountryGeometry | undefined,
    resolution: TCountryResolution,
  ];
}>();
const resolution = ref<TCountryResolution>(
  props.initial?.resolution ?? COUNTRY_RESOLUTIONS.MEDIUM
);
/** The countries chosen, in the order chosen (one or several). */
const chosen = ref<string[]>(props.initial ? countryIds(props.initial) : []);
/** The next pick joins the chosen ones (Add a country, or Ctrl/⌘). */
const adding = ref(false);
const countries = ref<Awaited<ReturnType<typeof getCountryList>>>([]);
const search = ref<HTMLInputElement>();
const loading = ref(false);
const error = ref("");
const note = ref("");
const retry = ref(0);

watch(
  [resolution, retry],
  async ([scale], _, onCleanup) => {
    let current = true;
    onCleanup(() => {
      current = false;
    });
    loading.value = true;
    countries.value = [];
    error.value = "";
    note.value = "";
    try {
      const list = await getCountryList(scale);
      if (!current) {
        return;
      }
      countries.value = list;
      const kept = chosen.value.filter((id) =>
        list.some((country) => country.id === id)
      );
      if (kept.length < chosen.value.length) {
        const lost = chosen.value.length - kept.length;
        chosen.value = kept;
        query.value = "";
        note.value =
          lost === 1
            ? "A chosen country is unavailable at this scale."
            : `${lost} chosen countries are unavailable at this scale.`;
      }
      showChosen();
    } catch {
      if (current) {
        error.value = "The country list could not be loaded.";
      }
    } finally {
      if (current) {
        loading.value = false;
      }
    }
  },
  { immediate: true }
);

// The map outlines what is chosen, from the list or from a map click.
const known = computed(() =>
  chosen.value.filter((id) =>
    countries.value.some((country) => country.id === id)
  )
);
watch(
  [known, resolution],
  () =>
    emit(
      "preview",
      known.value.length
        ? countriesGeometry(known.value, resolution.value)
        : undefined,
      resolution.value
    ),
  { immediate: true }
);

const nameOf = (id: string) =>
  countries.value.find((country) => country.id === id)?.name ?? id;

// The search: names containing the typed text (accents and case ignored),
// those starting with it first.
const query = ref("");
const listOpen = ref(false);
const active = ref(0);
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
const matches = computed(() => {
  // The field naming the one country chosen is no search: all are listed.
  const typed = naming.value ? "" : fold(query.value.trim());
  if (!typed) {
    return countries.value;
  }
  const hits = countries.value.filter((c) => fold(c.name).includes(typed));
  const starts = (c: { name: string }) => fold(c.name).startsWith(typed);
  return [...hits.filter(starts), ...hits.filter((c) => !starts(c))];
});

/** The field shows the one chosen country's name (not a search). */
const naming = ref(false);

/** The search field names one chosen country; with several, chips do. */
function showChosen() {
  naming.value = chosen.value.length === 1 && !adding.value;
  query.value = naming.value ? nameOf(chosen.value[0]) : "";
}

/** Several countries are shown as chips, the field then searches more. */
const several = computed(() => chosen.value.length > 1 || adding.value);

function typed(event: Event) {
  query.value = (event.target as HTMLInputElement).value;
  // Typing over the one country's name replaces it; otherwise the field
  // searches for more, and what is ticked stays.
  if (naming.value && !several.value) {
    chosen.value = [];
  }
  naming.value = false;
  note.value = "";
  active.value = 0;
  listOpen.value = true;
}

/** Choose one country, or (adding) one more; a chosen one is not added twice. */
function take(id: string, additive: boolean) {
  if (!additive) {
    chosen.value = [id];
  } else if (!chosen.value.includes(id)) {
    if (chosen.value.length >= MAX_COUNTRIES) {
      note.value = `At most ${MAX_COUNTRIES} countries make one plot.`;
      return;
    }
    chosen.value = [...chosen.value, id];
  }
  adding.value = false;
  note.value = "";
  listOpen.value = false;
  showChosen();
}

/**
 * The list ticks several (25 Nov): a name picked there is added, or taken
 * out if it was ticked, and the list stays open for the next one.
 */
function toggle(country: { id: string; name: string }) {
  if (chosen.value.includes(country.id)) {
    chosen.value = chosen.value.filter((other) => other !== country.id);
  } else if (chosen.value.length >= MAX_COUNTRIES) {
    note.value = `At most ${MAX_COUNTRIES} countries make one plot.`;
    return;
  } else {
    chosen.value = [...chosen.value, country.id];
  }
  adding.value = false;
  note.value = "";
  if (naming.value) {
    naming.value = false;
    query.value = "";
  }
}

/** Closed, the field names the one country chosen again (chips: several). */
function closeList() {
  listOpen.value = false;
  showChosen();
}

function remove(id: string) {
  chosen.value = chosen.value.filter((other) => other !== id);
  showChosen();
  search.value?.focus();
}

/** Add a country: the field searches for one more. */
function addAnother() {
  adding.value = true;
  query.value = "";
  listOpen.value = true;
  search.value?.focus();
}

function searchKeys(event: KeyboardEvent) {
  const count = matches.value.length;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!listOpen.value) {
      listOpen.value = true;
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : -1;
    active.value = count ? (active.value + step + count) % count : 0;
  } else if (event.key === "Enter" && listOpen.value) {
    // Enter picks the highlighted name; with the list closed it submits.
    event.preventDefault();
    const hit = matches.value[active.value];
    if (hit) {
      toggle(hit);
    }
  } else if (event.key === "Escape" && listOpen.value) {
    // Escape closes the list first, then (again) the form.
    event.preventDefault();
    event.stopPropagation();
    closeList();
  }
}

/**
 * A country picked on the map (undefined: the click hit no country); with
 * Ctrl/⌘ (or after Add a country) it joins those chosen, and a chosen one
 * clicked so is taken out again.
 */
function choose(country: TCountryGeometry | undefined, additive = false) {
  if (!country) {
    note.value = "No country there at this boundary detail.";
    return;
  }
  if (additive && chosen.value.includes(country.id) && !adding.value) {
    remove(country.id);
    return;
  }
  take(country.id, additive || adding.value);
}

function submit() {
  if (!loading.value && known.value.length) {
    emit("select", countriesGeometry(known.value, resolution.value));
  }
}

/**
 * The illustration on a phone, only when asked for. At the top of the map
 * it shows the first time, as the drawing guides do, and folds once a
 * country is chosen (25 Nov); How? brings it back.
 */
/** On a phone: the less used choices, shown on asking. */
const optionsOpen = ref(false);
const showHow = ref(Boolean(props.bar) && !guidesSeen().has("country"));
const howAsked = ref(false);
watch(
  () => chosen.value.length,
  (count, before) => {
    if (props.bar && count > 0 && !before && showHow.value && !howAsked.value) {
      showHow.value = false;
      markGuideSeen("country");
    }
  }
);
function toggleHow() {
  showHow.value = !showHow.value;
  howAsked.value = showHow.value;
}
onMounted(() => search.value?.focus());
// While open, a country clicked on the map is chosen here.
onBeforeUnmount(
  registerCountryPicker({ resolution: () => resolution.value, choose })
);

defineExpose({ choose });
</script>

<template>
  <form
    aria-label="Choose a country"
    class="country-form"
    :class="{ 'is-bar': bar, 'is-compact': compact }"
    @submit.prevent="submit"
    @keydown.esc.stop.prevent="emit('cancel')"
  >
    <!-- A phone, or the bar at the top: one line, the illustration on
         request. -->
    <p v-if="compact || bar" class="country-hint">
      <i class="fa-solid fa-hand-pointer" aria-hidden="true"></i>
      {{
        compact
          ? "Tap a country on the map, or search."
          : "Click a country on the map, or search."
      }}
      <button
        type="button"
        class="country-hint-more"
        :class="{ 'is-open': showHow }"
        :aria-expanded="showHow"
        @click="toggleHow"
      >
        <i
          v-if="showHow"
          class="fa-solid fa-eye-slash mr-1"
          aria-hidden="true"
        ></i>
        {{ showHow ? "Hide guide" : "How?" }}
      </button>
      <!-- On a phone: the boundary detail and shape import wait behind
           Options, so the panel stays low over the map (25 Nov). -->
      <button
        v-if="compact"
        type="button"
        class="country-hint-more country-options-toggle"
        :class="{ 'is-open': optionsOpen }"
        :aria-expanded="optionsOpen"
        data-action="country-options"
        @click="optionsOpen = !optionsOpen"
      >
        <i class="fa-solid fa-sliders mr-1" aria-hidden="true"></i>Options
      </button>
    </p>
    <!-- Click a country on the map: shown, not explained. -->
    <figure v-if="!(compact || bar) || showHow" class="country-how">
      <span class="demo-badge">How to choose</span>
      <!--
        Stacked layers over one static map: only whole layers move or fade
        (transform and opacity), so the loop runs on the compositor and
        costs the page nothing while the map is being hovered.
      -->
      <div class="country-demo" aria-hidden="true">
        <svg
          v-for="layer in DEMO_LAYERS"
          :key="layer"
          class="demo-layer"
          :class="`demo-${layer}`"
          :viewBox="`0 0 ${DEMO_FRAME.width} ${DEMO_FRAME.height}`"
          preserveAspectRatio="xMidYMid slice"
          focusable="false"
        >
          <template v-if="layer === 'map'">
            <rect
              class="demo-sea"
              :width="DEMO_FRAME.width"
              :height="DEMO_FRAME.height"
            />
            <path class="demo-land" :d="DEMO_EUROPE" />
            <path class="demo-land" :d="DEMO_GERMANY" />
          </template>
          <path
            v-else-if="layer === 'lit'"
            class="demo-pick"
            :d="DEMO_GERMANY"
          />
          <path
            v-else-if="layer === 'lit2'"
            class="demo-pick"
            :d="DEMO_FRANCE"
          />
          <g
            v-else-if="layer === 'tag'"
            :transform="`translate(${DEMO_CLICK.x} ${DEMO_CLICK.y - 30})`"
          >
            <rect x="-25" y="-9" width="50" height="16" rx="8" />
            <text y="3">Germany</text>
          </g>
          <g
            v-else-if="layer === 'tag2'"
            :transform="`translate(${DEMO_CLICK2.x - 14} ${DEMO_CLICK2.y - 26})`"
          >
            <rect x="-25" y="-9" width="50" height="16" rx="8" />
            <text y="3">+ France</text>
          </g>
          <!-- The key held for the second click (Ctrl, ⌘ on a Mac). -->
          <g
            v-else-if="layer === 'key'"
            :transform="`translate(${DEMO_CLICK2.x - 52} ${DEMO_CLICK2.y + 10})`"
          >
            <rect class="demo-keycap" width="34" height="18" rx="4" />
            <text class="demo-keytext" x="17" y="12.5">Ctrl/⌘</text>
          </g>
          <!-- A cartoon hand taps the country: "click" lines burst out. -->
          <path
            v-else-if="layer === 'burst'"
            :transform="`translate(${DEMO_CLICK.x} ${DEMO_CLICK.y}) rotate(-12)`"
            d="M-3.5 -3.5L-6 -6M0 -4.5V-7.5M3.5 -3.5L6 -6"
          />
          <path
            v-else-if="layer === 'burst2'"
            :transform="`translate(${DEMO_CLICK2.x} ${DEMO_CLICK2.y}) rotate(-12)`"
            d="M-3.5 -3.5L-6 -6M0 -4.5V-7.5M3.5 -3.5L6 -6"
          />
          <g
            v-else
            :transform="`translate(${DEMO_CLICK.x} ${DEMO_CLICK.y}) rotate(-12)`"
          >
            <path
              class="demo-glove"
              d="M-2.2 2A2.2 2.2 0 0 1 2.2 2V8.6A1.9 1.9 0 0 1 5.8 9.2A1.9 1.9 0 0 1 9.2 10A1.8 1.8 0 0 1 12.4 11.2V15.5Q12.4 21.5 6.4 21.5H2.4Q-0.6 21.5 -2.2 19L-6.4 12.6A1.8 1.8 0 0 1 -3.4 10.6L-2.2 12.2Z"
            />
            <path
              class="demo-knuckles"
              d="M2.2 8.6V12M5.8 9.2V12.4M9.2 10V12.8"
            />
          </g>
        </svg>
      </div>
      <figcaption>
        Click a country on the map, or search for it. Tick several in the list,
        or hold Ctrl (⌘ on a Mac) on the map to add more.
      </figcaption>
      <!-- In the bar, the countries chosen sit beside the illustration, not
           under it: the bar keeps its height (25 Nov). -->
      <div
        v-if="bar && several && chosen.length"
        class="country-chips how-chips"
        role="group"
        :aria-label="`${chosen.length} countries chosen`"
      >
        <span v-for="chip in chosen" :key="chip" class="country-chip">
          {{ nameOf(chip) }}
          <button
            type="button"
            :aria-label="`Remove ${nameOf(chip)}`"
            :title="`Remove ${nameOf(chip)}`"
            @click="remove(chip)"
          >
            ×
          </button>
        </span>
      </div>
    </figure>
    <div
      v-if="several && chosen.length && !(bar && showHow)"
      class="country-chips"
      role="group"
      :aria-label="`${chosen.length} countries chosen`"
    >
      <span v-for="chip in chosen" :key="chip" class="country-chip">
        {{ nameOf(chip) }}
        <button
          type="button"
          :aria-label="`Remove ${nameOf(chip)}`"
          :title="`Remove ${nameOf(chip)}`"
          @click="remove(chip)"
        >
          ×
        </button>
      </span>
    </div>
    <label class="country-field">
      <span>{{ several ? "Add a country" : "Country" }}</span>
      <span class="country-search">
        <input
          ref="search"
          type="search"
          role="combobox"
          autocomplete="off"
          aria-autocomplete="list"
          aria-controls="country-options"
          :aria-expanded="listOpen"
          :aria-activedescendant="
            listOpen && matches[active]
              ? `country-${matches[active].id}`
              : undefined
          "
          :value="query"
          :placeholder="loading ? 'Loading countries…' : 'Search countries'"
          :disabled="loading || Boolean(error)"
          @input="typed"
          @focus="listOpen = !chosen.length"
          @click="listOpen = true"
          @blur="closeList"
          @keydown="searchKeys"
        />
        <ul
          v-if="listOpen"
          id="country-options"
          class="country-options"
          role="listbox"
          aria-label="Countries"
          aria-multiselectable="true"
        >
          <li
            v-for="(country, at) in matches"
            :id="`country-${country.id}`"
            :key="country.id"
            role="option"
            :aria-selected="chosen.includes(country.id)"
            :class="{
              active: at === active,
              ticked: chosen.includes(country.id),
            }"
            @mousedown.prevent="toggle(country)"
          >
            <i
              class="country-tick"
              :class="
                chosen.includes(country.id)
                  ? 'fa-solid fa-square-check'
                  : 'fa-regular fa-square'
              "
              aria-hidden="true"
            ></i>
            {{ country.name }}
          </li>
          <li v-if="!matches.length" class="country-none" role="presentation">
            No country matches “{{ query.trim() }}”
          </li>
        </ul>
      </span>
    </label>
    <label v-if="!compact || optionsOpen" class="country-detail">
      <span>Boundary detail</span>
      <select
        v-model="resolution"
        title="Boundary detail: finer boundaries take longer to load"
      >
        <option :value="COUNTRY_RESOLUTIONS.COARSE">
          Coarse{{ bar ? "" : " (1:110 million)" }}
        </option>
        <option :value="COUNTRY_RESOLUTIONS.MEDIUM">
          Standard{{ bar ? "" : " (1:50 million)" }}
        </option>
        <option :value="COUNTRY_RESOLUTIONS.FINE">
          Fine{{ bar ? "" : " (1:10 million)" }}
        </option>
      </select>
    </label>
    <div
      v-if="!compact || optionsOpen || (chosen.length === 1 && !adding)"
      class="country-more"
    >
      <button
        v-if="chosen.length === 1 && !adding"
        type="button"
        class="button is-small is-text"
        data-action="add-country"
        @click="addAnother"
      >
        <i class="fa-solid fa-plus mr-1" aria-hidden="true"></i>Add a country
      </button>
      <button
        v-if="offerShapes && (!compact || optionsOpen)"
        type="button"
        class="button is-small is-text"
        data-action="import-shape"
        title="A continent, basin, province, district or village: your own boundaries from GeoJSON, KML/KMZ or a Shapefile, read in this page"
        @click="emit('importShape')"
      >
        <i class="fa-solid fa-file-import mr-1" aria-hidden="true"></i>Not a
        country? Import a shape
      </button>
    </div>
    <p v-if="loading || note" role="status">
      {{ loading ? "Loading country list…" : note }}
    </p>
    <div v-if="error" role="alert">
      {{ error }}
      <button class="button is-small" type="button" @click="retry++">
        Retry
      </button>
    </div>
    <div class="buttons are-small is-right country-actions">
      <button type="button" class="button" @click="emit('cancel')">
        Cancel
      </button>
      <button
        type="submit"
        class="button is-link"
        :disabled="loading || Boolean(error) || !known.length"
      >
        {{
          known.length > 1
            ? `${submitLabel} (${known.length} countries)`
            : submitLabel
        }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.country-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 6.5rem;
  overflow: auto;
}
.country-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 2px 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--bulma-link) 22%, transparent);
  font-size: 0.8rem;
}
.country-chip button {
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  min-width: 20px;
  font-size: 0.95rem;
  line-height: 1;
}
.country-more {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.country-form,
.country-form label {
  display: grid;
  gap: 0.4rem;
}
.country-form {
  gap: 0.7rem;
}
.country-form select,
.country-search input {
  width: 100%;
  font: inherit;
  padding: 0.3rem;
  background: var(--plot-bg);
  color: var(--plot-fg);
  border: 1px solid var(--plot-border);
  border-radius: 4px;
}
.country-search {
  position: relative;
  display: block;
}
.country-options {
  position: absolute;
  z-index: 2;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  max-height: 11.5rem;
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--plot-bg);
  border: 1px solid var(--plot-border);
  border-radius: 6px;
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.18);
}
.country-options li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.country-tick {
  flex: none;
  width: 1em;
  color: var(--plot-muted);
}
.country-options li.ticked .country-tick {
  color: var(--plot-accent);
}
.country-options li.active {
  background: var(--plot-hover);
  color: var(--plot-accent);
}
.country-options .country-none {
  color: var(--plot-muted);
  cursor: default;
}
/*
 * A 4 s cartoon over Europe, played three times: a gloved hand glides
 * onto Germany, taps it ("click" lines burst out), and the country lights
 * up with its name.
 * Drawn as an illustration (ink outlines, a badge, no pointer reaction),
 * so it does not read as a map to click.
 */
.country-how {
  position: relative;
  display: grid;
  gap: 6px;
  margin: 0;
  color: var(--plot-muted);
  font-size: 0.8rem;
  text-align: center;
  pointer-events: none;
  user-select: none;
}
.demo-badge {
  position: absolute;
  z-index: 1;
  top: 6px;
  left: 6px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--plot-bg);
  border: 1px solid var(--plot-border);
  color: var(--plot-muted);
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.country-demo {
  /* Layers move in units of the frame's width (100cqw is 240 map units:
     the map is scaled to the width, the frame being wider than tall). */
  container-type: inline-size;
  --ink: color-mix(in srgb, var(--plot-fg) 70%, var(--plot-bg));
  /* Parchment land by day, slate by night. */
  --land: color-mix(in srgb, #f5d98b 35%, var(--plot-bg));
  position: relative;
  height: 128px;
  overflow: hidden;
  border: 1.5px dashed var(--plot-border);
  border-radius: 12px;
}
.demo-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.demo-sea {
  fill: color-mix(in srgb, var(--plot-accent) 12%, var(--plot-bg));
}
.demo-land,
.demo-pick {
  fill: var(--land);
  stroke: var(--ink);
  stroke-width: 0.7;
  stroke-linejoin: round;
}
.demo-pick {
  fill: var(--plot-accent);
}
.demo-tag rect,
.demo-tag2 rect {
  fill: var(--plot-accent);
  stroke: var(--ink);
  stroke-width: 0.7;
}
.demo-keycap {
  fill: var(--plot-bg);
  stroke: var(--ink);
  stroke-width: 1;
}
.demo-keytext {
  fill: var(--plot-fg);
  font-size: 8px;
  font-weight: 700;
  text-anchor: middle;
}
.demo-tag text,
.demo-tag2 text {
  fill: var(--plot-bg);
  font-size: 9px;
  font-weight: 700;
  text-anchor: middle;
}
.demo-burst,
.demo-burst2 {
  opacity: 0;
  fill: none;
  stroke: var(--plot-accent);
  stroke-width: 1.4;
  stroke-linecap: round;
}
.demo-glove {
  fill: #ffffff;
  stroke: #1f2937;
  stroke-width: 1.1;
  stroke-linejoin: round;
}
.demo-knuckles {
  fill: none;
  stroke: #1f2937;
  stroke-width: 1.1;
  stroke-linecap: round;
}
/* Only opacity and transform animate, each on its own layer: Germany is
   clicked, then France with Ctrl (⌘) held, and both stay chosen. */
.demo-lit,
.demo-lit2,
.demo-tag,
.demo-tag2,
.demo-key,
.demo-burst,
.demo-burst2,
.demo-hand {
  will-change: opacity, transform;
  /* Longhands: the build's minifier drops a shorthand without a name.
     Three loops, then it rests on the picked state and costs nothing. */
  animation-duration: 7s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: 3;
}
.demo-lit {
  animation-name: demo-lit;
}
.demo-lit2 {
  animation-name: demo-lit2;
}
.demo-tag {
  animation-name: demo-tag;
}
.demo-tag2 {
  animation-name: demo-tag2;
}
.demo-key {
  animation-name: demo-key;
}
.demo-burst {
  animation-name: demo-burst;
}
.demo-burst2 {
  animation-name: demo-burst2;
}
/* At rest (and with reduced motion) the hand is on France: France is
   (-33, +24) map units from Germany's click. */
.demo-hand {
  transform: translate(-13.75cqw, 10cqw);
  animation-name: demo-hand;
  animation-timing-function: cubic-bezier(0.3, 0.7, 0.3, 1);
}
@keyframes demo-hand {
  0% {
    transform: translate(70px, 55px);
    opacity: 0;
  }
  5% {
    opacity: 1;
  }
  22% {
    transform: none;
  }
  25% {
    transform: translate(0, 2px);
  }
  29%,
  42% {
    transform: none;
  }
  58% {
    transform: translate(-13.75cqw, 10cqw);
  }
  61% {
    transform: translate(-13.75cqw, calc(10cqw + 2px));
  }
  65%,
  90% {
    transform: translate(-13.75cqw, 10cqw);
    opacity: 1;
  }
  100% {
    transform: translate(-13.75cqw, 10cqw);
    opacity: 0;
  }
}
@keyframes demo-burst {
  0%,
  24% {
    opacity: 0;
  }
  28% {
    opacity: 1;
  }
  38%,
  100% {
    opacity: 0;
  }
}
@keyframes demo-burst2 {
  0%,
  60% {
    opacity: 0;
  }
  64% {
    opacity: 1;
  }
  74%,
  100% {
    opacity: 0;
  }
}
@keyframes demo-lit {
  0%,
  26% {
    opacity: 0;
  }
  30%,
  92% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
@keyframes demo-lit2 {
  0%,
  62% {
    opacity: 0;
  }
  66%,
  92% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
@keyframes demo-tag {
  0%,
  29% {
    opacity: 0;
    transform: translateY(4px);
  }
  35%,
  90% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
  }
}
@keyframes demo-tag2 {
  0%,
  65% {
    opacity: 0;
    transform: translateY(4px);
  }
  71%,
  90% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
  }
}
/* The key appears as the hand sets off for France, and stays held. */
@keyframes demo-key {
  0%,
  42% {
    opacity: 0;
  }
  48%,
  90% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
@media (prefers-color-scheme: dark) {
  .country-demo {
    --land: color-mix(in srgb, var(--plot-muted) 28%, var(--plot-bg));
  }
}
/* Reduced motion: the picked state, still. */
@media (prefers-reduced-motion: reduce) {
  .demo-lit,
  .demo-lit2,
  .demo-tag,
  .demo-tag2,
  .demo-key,
  .demo-burst,
  .demo-burst2,
  .demo-hand {
    animation: none;
  }
}
.country-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  color: var(--plot-muted);
  font-size: 0.76rem;
}
/* The bar at the top of the map: one row, then the hint line. */
.country-form.is-bar {
  position: relative;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  column-gap: 8px;
  row-gap: 4px;
}
.is-bar > * {
  grid-column: 1 / -1;
}
.is-bar .country-field {
  grid-row: 1;
  grid-column: 1;
}
.is-bar .country-detail {
  grid-row: 1;
  grid-column: 2;
}
.is-bar .country-actions {
  grid-row: 1;
  grid-column: 3;
  flex-wrap: nowrap;
  margin: 0;
}
.is-bar .country-actions .button {
  margin-bottom: 0;
}
.is-bar .country-hint {
  grid-row: 2;
  grid-column: 1;
  margin: 0;
}
.is-bar .country-more {
  grid-row: 2;
  grid-column: 2 / -1;
  justify-content: flex-end;
}
.is-bar .country-hint-more {
  min-height: 24px;
}
/* Boundary detail: a small select (Coarse, Standard, Fine), its name in
   its tooltip (25 Nov: the full-size one crowded the row). */
.is-bar .country-detail select {
  width: auto;
  padding: 0.15rem 0.25rem;
  font-size: 0.8rem;
  color: var(--plot-muted);
}
/* Its illustration, smaller: the whole demo map at 110 px high (its own
   proportions, so the hand and the countries stay in place), the caption
   beside it (25 Nov: full width, Europe filled the bar). */
.is-bar .country-how {
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  align-items: center;
  column-gap: 12px;
  row-gap: 6px;
  text-align: left;
}
.is-bar .country-how .country-demo {
  grid-row: 1 / span 2;
}
.is-bar .country-how figcaption {
  align-self: end;
}
/* The chosen countries beside the illustration, within its height. */
.is-bar .how-chips {
  align-self: start;
  align-content: flex-start;
  max-height: 4.4rem;
  pointer-events: auto;
}
.is-bar .country-demo {
  width: 176px;
  height: 110px;
}
.is-bar .demo-badge {
  display: none;
}
/* Its fields say what they are (placeholder, title): labels for readers. */
.is-bar .country-field > span:first-child,
.is-bar .country-detail > span:first-child {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
/* Hiding the guide is easy to find: the button stands out while it shows
   (25 Nov). */
.country-hint-more.is-open {
  border-color: var(--bulma-link);
  background: var(--bulma-link);
  color: var(--bulma-link-invert, #fff);
  font-weight: 600;
}
.country-hint-more.is-open:hover {
  filter: brightness(1.1);
}
/* A phone: the field says what it is (placeholder); labels for readers. */
.country-form.is-compact .country-field > span:first-child,
.country-form.is-compact .country-detail > span:first-child {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.country-options-toggle {
  margin-left: 0;
}
.country-form.is-compact {
  gap: 0.45rem;
}
.country-hint-more {
  flex: none;
  white-space: nowrap;
  margin-left: auto;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--plot-border);
  border-radius: 999px;
  background: none;
  color: var(--plot-fg);
  font: inherit;
  cursor: pointer;
}
</style>
