<script lang="ts" setup>
import { computed, ref } from "vue";

import AxisDatePicker from "./AxisDatePicker.vue";
import { bytesPerGroup, datePresets, rangeCost } from "./datePresets.ts";
import {
  describeGeometry,
  geometryVertices,
  mapSettingsDiffer,
  mapSettingsFromStore,
  usesDegreeBins,
  verticalTitle,
} from "./plotLayout.ts";
import {
  boxForMode,
  capBox,
  capReach,
  CAP_EDGE,
  capOf,
  REGION_MODE_NAMES,
  REGION_MODES,
  regionModeOf,
  type TRegionMode,
} from "./regionModes.ts";
import ShapePicker from "./ShapePicker.vue";

import {
  CALENDARS,
  encodeTypedDate,
  nearestTimeIndex,
  parseCalendarDate,
  parseTimeAxis,
  timeLabelAt,
} from "@/lib/analysis/calendar.ts";
import {
  convertValue,
  defaultChartStyle,
  rateKind,
  temperatureMetadata,
  unitChoices,
} from "@/lib/analysis/displayUnits.ts";
import { editableForm } from "@/lib/analysis/shapeEdit.ts";
import { polygonCrossings } from "@/lib/analysis/sphere.ts";
import {
  chronologicalEnds,
  rowCount,
  sameSelection,
  selectionOf,
} from "@/lib/analysis/timeRows.ts";
import {
  ANALYSIS_KINDS,
  FIXED_LEVEL_KINDS,
  GEOMETRY_KINDS,
  PATH_KINDS,
  TIME_RANGE_KINDS,
  type TGeometry,
  MAX_VALUE_BINS,
  MIN_BIN_DEGREES,
} from "@/lib/analysis/types.ts";
import { useAnalysisStore, type TPlotWindow } from "@/store/analysisStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { formatValue } from "@/utils/formatValue.ts";

const props = defineProps<{ plot: TPlotWindow }>();
const emit = defineEmits<{ redraw: []; edit: []; country: [] }>();

const analysis = useAnalysisStore();
const globe = useGlobeControlStore();
/** The earliest and latest source dates, wherever the file stores them. */
const dateEnds = computed(() => {
  const raw = summary.value?.time?.raw ?? [];
  let [first, last] = [0, raw.length - 1];
  for (let at = 0; at < raw.length; at++) {
    if (Number.isFinite(raw[at])) {
      first = raw[at] < raw[first] || !Number.isFinite(raw[first]) ? at : first;
      last = raw[at] > raw[last] || !Number.isFinite(raw[last]) ? at : last;
    }
  }
  return { first, last };
});
const editingShape = ref(false);
function selectShape(geometry: TGeometry) {
  analysis.updateDraft(props.plot.id, { geometry });
  editingShape.value = false;
  analysis.shapePreview = undefined;
}
function closeShape() {
  editingShape.value = false;
  analysis.shapePreview = undefined;
}
const dateNotes = ref<Record<string, string>>({});

/** Display: units the plot can be shown in (from the file's own). */
/** The plotted variable's CF standard name: what its rate units mean. */
const standardName = computed(
  () =>
    analysis.variableSources[
      props.plot.committed?.variable ?? props.plot.draft.variable
    ]?.standardName
);
/** Its temperature meaning (a difference converts by scale only). */
const temperatureMeta = computed(() =>
  props.plot.result
    ? temperatureMetadata(props.plot.result, standardName.value)
    : undefined
);
const units = computed(() =>
  unitChoices(
    props.plot.result?.units ?? props.plot.summary?.units,
    temperatureMeta.value,
    rateKind(
      props.plot.committed?.variable ?? props.plot.draft.variable,
      standardName.value
    )
  )
);
/** Plots drawn as one series: a line, bars or points. */
const styled = computed(
  () =>
    props.plot.kind === ANALYSIS_KINDS.POINT_SERIES ||
    props.plot.kind === ANALYSIS_KINDS.REGION_SERIES
);
const autoStyle = computed(() =>
  defaultChartStyle(
    props.plot.committed?.variable ?? props.plot.draft.variable,
    props.plot.result?.units ?? props.plot.summary?.units,
    standardName.value
  )
);
const STYLES = [
  { value: "line", label: "Line", icon: "fa-chart-line" },
  { value: "bars", label: "Bars", icon: "fa-chart-column" },
  { value: "points", label: "Points", icon: "fa-braille" },
] as const;
function setUnits(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  const own = units.value[0]?.units;
  const shown = props.plot.displayUnits ?? own;
  // A distribution's "share above" keeps its meaning: converted with the
  // values (273.15 K is 0 °C), dropped when it cannot be.
  const above = props.plot.shareAbove;
  const converted =
    above === undefined
      ? undefined
      : convertValue(above, shown, value, temperatureMeta.value);
  analysis.patchWindow(props.plot.id, {
    displayUnits: value === own ? undefined : value,
    // Thresholds typed in the old units would mean something else.
    memberThreshold: undefined,
    timeThreshold: undefined,
    shareAbove:
      converted === undefined ? undefined : Number(converted.toPrecision(12)),
  });
}
function setStyle(value: "line" | "bars" | "points") {
  analysis.patchWindow(props.plot.id, {
    chartStyle: value === autoStyle.value ? undefined : value,
  });
}

const w = computed(() => props.plot);
const summary = computed(() => w.value.summary);
const map = computed(() => mapSettingsFromStore(globe));

/** Bytes a stored time chunk decodes, as far as the plot knows. */
const perGroup = computed(() =>
  bytesPerGroup({
    chunk: summary.value?.time?.chunk,
    previewPerGroup: w.value.preview?.perGroup,
    committed: w.value.committed?.time,
    estimateBytes: w.value.estimate?.decodedBytes,
    decodedBytes: w.value.result?.partial
      ? undefined
      : w.value.result?.counters.decodedBytes,
  })
);
/** Around the map's date, the last year, all: each with its price. */
const presets = computed(() => {
  const time = summary.value?.time;
  if (!time?.chunk) {
    return [];
  }
  return datePresets({
    raw: time.raw,
    units: time.units,
    calendar: time.calendar,
    chunk: time.chunk,
    perGroup: perGroup.value,
    anchor: map.value.indices[time.dimension],
  });
});
/** The range typed: how many dates, and its price when known. */
const draftDates = computed(() => {
  const range = w.value.draft.time;
  const chunk = summary.value?.time?.chunk;
  if (!range) {
    return "";
  }
  const count = rowCount(range);
  const cost = chunk ? rangeCost(range, chunk, perGroup.value) : "";
  return `${count.toLocaleString("en-US")} date${count === 1 ? "" : "s"}${cost ? `, ${cost} to decode` : ""}`;
});
const differs = computed(() => mapSettingsDiffer(w.value, map.value));
/** Plots over a time range (series, time–depth, Hovmöller). */
const isSeries = computed(() => TIME_RANGE_KINDS.includes(w.value.kind));
/** Plots at one level (the others span the vertical). */
const fixedLevel = computed(() => FIXED_LEVEL_KINDS.includes(w.value.kind));
const isPath = computed(() => PATH_KINDS.includes(w.value.kind));
const isBand = computed(() => usesDegreeBins(w.value.kind));
const id = (name: string) => `${w.value.id}-${name}`;

function numberValue(event: Event) {
  return Number((event.target as HTMLInputElement).value);
}

function setTime(start: number, stop: number) {
  const length = summary.value?.time?.raw.length ?? 1;
  const s = Math.max(0, Math.min(length - 1, Math.trunc(start)));
  const e = Math.max(s + 1, Math.min(length, Math.trunc(stop)));
  analysis.updateDraft(w.value.id, { time: { start: s, stop: e } });
}

/** Resolve a typed date to the nearest source time (ties: the earlier). */
function setDate(which: "start" | "stop", text: string) {
  const time = summary.value?.time;
  const date = parseCalendarDate(text);
  if (!time || !date) {
    dateNotes.value[which] = "Enter a date as YYYY-MM-DD or YYYY-MM-DD HH:MM.";
    return;
  }
  const axis = parseTimeAxis(time.units, time.calendar);
  if ("unsupported" in axis) {
    dateNotes.value[which] = axis.unsupported;
    return;
  }
  // An impossible date of this calendar: say so, keep the range.
  const typed = encodeTypedDate(axis, date);
  if ("problem" in typed) {
    dateNotes.value[which] = `${typed.problem} The dates are unchanged.`;
    return;
  }
  const index = nearestTimeIndex(time.raw, typed.value);
  dateNotes.value[which] = `Nearest source time: ${timeLabelAt(time, index)}`;
  if (!isSeries.value) {
    setTime(index, index + 1);
    return;
  }
  // From and To are the earliest and latest dates, wherever the file stores
  // them: on a descending file From is the later index. A From after To (or a
  // To before From) takes the other end along.
  let [from, to] = [dateEnd.value.from, dateEnd.value.to];
  if (which === "start") {
    from = index;
    to = time.raw[to] < time.raw[from] ? from : to;
  } else {
    to = index;
    from = time.raw[from] > time.raw[to] ? to : from;
  }
  // Stored out of order: the dates of the range are read in the slices the file
  // keeps them in, and no others. Every stored date in the range, wherever the
  // file keeps it.
  const chosen = selectionOf(
    time.raw,
    time.raw[from],
    time.raw[to],
    0,
    time.raw.length
  );
  analysis.updateDraft(w.value.id, { time: chosen });
  if (chosen.runs) {
    dateNotes.value[which] =
      `${dateNotes.value[which]}. The file stores these dates out of order: they are read in ${chosen.runs.length} separate slices, without the dates between.`;
  }
}

/**
 * The storage indices of the range's chronological ends, wherever the file
 * stores them.
 */
const dateEnd = computed(() =>
  chronologicalEnds(w.value.draft.time!, summary.value?.time?.raw ?? [])
);

/** The map's date picker, for one end of the range (its nearest date). */
/**
 * Whether a calendar grid can show this axis's dates: a decodable axis in
 * a calendar whose dates are Gregorian ones (not 360-day; not the Julian
 * dates of a standard calendar before 1583). Otherwise only the text field.
 */
const pickable = computed(() => {
  const time = summary.value?.time;
  if (!time?.raw.length) {
    return false;
  }
  const axis = parseTimeAxis(time.units, time.calendar);
  if ("unsupported" in axis || axis.calendar === CALENDARS.DAY360) {
    return false;
  }
  const first = parseCalendarDate(timeLabelAt(time, 0));
  return Boolean(
    first && (axis.calendar !== CALENDARS.STANDARD || first.year >= 1583)
  );
});

function editGeometry(change: (geometry: TGeometry) => void) {
  const geometry = JSON.parse(
    JSON.stringify(w.value.draft.geometry)
  ) as TGeometry;
  change(geometry);
  analysis.updateDraft(w.value.id, { geometry });
}

function setVertex(at: number, field: "lat" | "lon", value: number) {
  editGeometry((geometry) => {
    if (geometry.kind === GEOMETRY_KINDS.POINT) {
      geometry[field] = value;
    } else if (
      geometry.kind === GEOMETRY_KINDS.POLYGON ||
      geometry.kind === GEOMETRY_KINDS.POLYLINE
    ) {
      geometry.vertices[at][field] = value;
    }
  });
}

function setBox(field: "west" | "east" | "south" | "north", value: number) {
  editGeometry((geometry) => {
    if (geometry.kind === GEOMETRY_KINDS.BOX) {
      geometry[field] = value;
    }
  });
}

/** The band's longitude span, eastwards from west (as the plot reads it). */
const longitudeSpan = computed(() => {
  const g = props.plot.draft.geometry;
  if (g.kind !== GEOMETRY_KINDS.BOX) {
    return "";
  }
  const raw = (((g.east - g.west) % 360) + 360) % 360;
  const span = raw === 0 && g.east !== g.west ? 360 : raw;
  return span === 0
    ? "The band has no width: set different West and East."
    : `Spans ${formatValue(span)}° of longitude, eastwards from ${formatValue(g.west)}° E.`;
});

// Region modes of a box (area plots): box, latitude band, polar cap or
// the whole globe, all read and written as box numbers.
const regionMode = computed(() =>
  props.plot.draft.geometry.kind === GEOMETRY_KINDS.BOX
    ? regionModeOf(props.plot.draft.geometry)
    : REGION_MODES.BOX
);
/** A box drawn on the globe or a curved map (its footprint there). */
const drawnShape = computed(() => {
  const g = props.plot.draft.geometry;
  return g.kind === GEOMETRY_KINDS.SHAPE && g.drawn ? g : undefined;
});
const cap = computed(() =>
  props.plot.draft.geometry.kind === GEOMETRY_KINDS.BOX
    ? capOf(props.plot.draft.geometry)
    : undefined
);
/**
 * How the box is edited: by its mode on area plots; on plots along an axis
 * (Hovmöller diagrams, sections) always as a box, all four numbers.
 */
const editMode = computed(() =>
  offersModes.value ? regionMode.value : REGION_MODES.BOX
);
const AREA_BOX_KINDS: readonly string[] = [
  ANALYSIS_KINDS.REGION_SERIES,
  ANALYSIS_KINDS.DISTRIBUTION,
  ANALYSIS_KINDS.HOVMOLLER_LON,
  ANALYSIS_KINDS.HOVMOLLER_LAT,
];
const offersModes = computed(
  () =>
    (props.plot.draft.geometry.kind === GEOMETRY_KINDS.BOX ||
      Boolean(drawnShape.value)) &&
    AREA_BOX_KINDS.includes(props.plot.kind)
);

function setBoxNumbers(next: {
  west: number;
  east: number;
  south: number;
  north: number;
}) {
  editGeometry((geometry) => {
    if (geometry.kind === GEOMETRY_KINDS.BOX) {
      Object.assign(geometry, next);
    }
  });
}

function setMode(event: Event) {
  const g = props.plot.draft.geometry;
  const mode = (event.target as HTMLSelectElement).value as TRegionMode;
  const drawn = drawnShape.value;
  // A drawn box becomes a band, polar cap or the globe at its latitudes.
  if (drawn && mode !== REGION_MODES.BOX) {
    const lats = drawn.polygons.flat(2).map(([, lat]) => lat);
    const geometry: TGeometry = {
      kind: GEOMETRY_KINDS.BOX,
      ...boxForMode(mode, {
        west: -180,
        east: 180,
        south: Math.min(...lats),
        north: Math.max(...lats),
      }),
    };
    analysis.updateDraft(w.value.id, { geometry });
    return;
  }
  if (g.kind === GEOMETRY_KINDS.BOX) {
    setBoxNumbers(
      boxForMode((event.target as HTMLSelectElement).value as TRegionMode, g)
    );
  }
}

function setCap(hemisphere: "north" | "south", limit: number) {
  if (Number.isFinite(limit)) {
    setBoxNumbers(capBox(hemisphere, limit));
  }
}

/** Edges of an edited polygon that cross (edge k: point k to k + 1). */
const crossings = computed(() =>
  props.plot.draft.geometry.kind === GEOMETRY_KINDS.POLYGON
    ? polygonCrossings(props.plot.draft.geometry.vertices)
    : []
);
const crossingText = computed(() => {
  const [first] = crossings.value;
  const g = props.plot.draft.geometry;
  if (!first || g.kind !== GEOMETRY_KINDS.POLYGON) {
    return "";
  }
  const n = g.vertices.length;
  const edge = (k: number) => `${k + 1}→${k === n - 1 ? 1 : k + 2}`;
  return `Edges ${edge(first[0])} and ${edge(first[1])} cross: an area needs one inside. Move or remove a point; the plot keeps its last outline until then.`;
});

/** The fields a mode shows: a band only its latitudes. */
const shownBoxFields = computed(() =>
  editMode.value === REGION_MODES.BAND
    ? BOX_FIELDS.filter((f) => f.field === "south" || f.field === "north")
    : editMode.value === REGION_MODES.BOX
      ? BOX_FIELDS
      : []
);

/** A longitude band all the way round: west −180°, east 180°. */
function allLongitudes() {
  editGeometry((geometry) => {
    if (geometry.kind === GEOMETRY_KINDS.BOX) {
      geometry.west = -180;
      geometry.east = 180;
    }
  });
}

/** Bin width within the limits plots accept; empty means native spacing. */
function setBinDegrees(event: Event) {
  const text = (event.target as HTMLInputElement).value;
  const value = Number(text);
  analysis.updateDraft(props.plot.id, {
    binDegrees:
      text === "" || !Number.isFinite(value)
        ? undefined
        : Math.min(360, Math.max(MIN_BIN_DEGREES, value)),
  });
}

function setValueBins(event: Event) {
  const value = Math.round(numberValue(event));
  analysis.updateDraft(props.plot.id, {
    valueBins: Number.isFinite(value)
      ? Math.min(MAX_VALUE_BINS, Math.max(2, value))
      : 30,
  });
}

function removeVertex(at: number) {
  editGeometry((geometry) => {
    if (
      (geometry.kind === GEOMETRY_KINDS.POLYGON ||
        geometry.kind === GEOMETRY_KINDS.POLYLINE) &&
      geometry.vertices.length >
        (geometry.kind === GEOMETRY_KINDS.POLYGON ? 3 : 2)
    ) {
      geometry.vertices.splice(at, 1);
    }
  });
}

const BOX_FIELDS = [
  { field: "west", label: "West (° E)" },
  { field: "east", label: "East (° E)" },
  { field: "south", label: "South (° N)" },
  { field: "north", label: "North (° N)" },
] as const;

const orderOptions = computed(() => {
  const s = summary.value;
  if (!s || s.order === undefined) {
    return [];
  }
  return [
    { variable: s.variable, order: s.order, preview: false },
    ...s.overviews.map((o) => ({ ...o, preview: true })),
  ];
});

const levelName = computed(() => verticalTitle(summary.value?.vertical));
</script>

<template>
  <div
    class="analysis-settings is-size-7"
    role="region"
    :aria-label="`${plot.label} settings`"
  >
    <!-- Shown at once: nothing is read again. -->
    <fieldset v-if="units.length || styled" class="analysis-display">
      <legend>Display</legend>
      <div class="analysis-grid">
        <label v-if="units.length">
          <span>Units</span>
          <select
            class="input is-small"
            data-display-units
            :value="plot.displayUnits ?? units[0].units"
            @change="setUnits"
          >
            <option
              v-for="choice in units"
              :key="choice.units"
              :value="choice.units"
            >
              {{ choice.label }}
            </option>
          </select>
        </label>
        <div v-if="styled" class="analysis-style">
          <span id="chart-type">Chart type</span>
          <div
            class="analysis-segmented"
            role="radiogroup"
            aria-labelledby="chart-type"
          >
            <button
              v-for="style in STYLES"
              :key="style.value"
              type="button"
              role="radio"
              :data-chart-style="style.value"
              :aria-checked="(plot.chartStyle ?? autoStyle) === style.value"
              @click="setStyle(style.value)"
            >
              <i class="fa-solid" :class="[style.icon]" aria-hidden="true"></i>
              {{ style.label
              }}<span v-if="autoStyle === style.value" class="analysis-auto">
                (default)</span
              >
            </button>
          </div>
        </div>
      </div>
      <p class="analysis-help">
        Shown at once, nothing is read again; data exports keep the file's
        units.
      </p>
    </fieldset>
    <fieldset>
      <legend>Selection</legend>
      <div
        v-if="plot.draft.geometry.kind === GEOMETRY_KINDS.BOX"
        class="analysis-grid"
      >
        <label v-if="offersModes" class="analysis-wide">
          <span>Region</span>
          <select class="input is-small" :value="regionMode" @change="setMode">
            <option
              v-for="(name, mode) in REGION_MODE_NAMES"
              :key="mode"
              :value="mode"
            >
              {{ name }}
            </option>
          </select>
        </label>
        <template v-if="editMode === REGION_MODES.CAP && cap">
          <label>
            <span>Pole</span>
            <select
              class="input is-small"
              :value="cap.hemisphere"
              @change="
                setCap(
                  ($event.target as HTMLSelectElement).value as
                    'north' | 'south',
                  capReach(cap)
                )
              "
            >
              <option value="north">North Pole</option>
              <option value="south">South Pole</option>
            </select>
          </label>
          <label>
            <span
              >Down to (° {{ cap.hemisphere === "north" ? "N" : "S" }})</span
            >
            <input
              class="input is-small"
              type="number"
              step="any"
              min="-89.9"
              :max="CAP_EDGE"
              :value="capReach(cap)"
              @change="setCap(cap.hemisphere, numberValue($event))"
            />
          </label>
          <p v-if="capReach(cap) < 0" class="analysis-help analysis-wide">
            Past the equator: to {{ Math.abs(cap.limit) }}°
            {{ cap.limit > 0 ? "N" : "S" }}.
          </p>
        </template>
        <p v-if="crossingText" class="analysis-help analysis-wide" role="alert">
          {{ crossingText }}
        </p>
        <p
          v-if="editMode === REGION_MODES.GLOBE"
          class="analysis-help analysis-wide"
        >
          Every cell of the grid.
        </p>
        <label v-for="{ field, label } in shownBoxFields" :key="field">
          <span>{{ label }}</span>
          <input
            class="input is-small"
            type="number"
            step="any"
            :value="plot.draft.geometry[field]"
            @change="setBox(field, numberValue($event))"
          />
        </label>
      </div>
      <p
        v-if="
          plot.draft.geometry.kind === GEOMETRY_KINDS.BOX &&
          plot.kind === ANALYSIS_KINDS.HOVMOLLER_LON
        "
        class="analysis-help"
      >
        {{ longitudeSpan }}
      </p>
      <!-- Also for area plots: a box drawn a little short of the full width
           closes its gap here, its latitudes kept (review of interim7). -->
      <button
        v-if="
          plot.draft.geometry.kind === GEOMETRY_KINDS.BOX &&
          (plot.kind === ANALYSIS_KINDS.HOVMOLLER_LON ||
            (offersModes && regionMode === REGION_MODES.BOX))
        "
        type="button"
        class="button is-small analysis-quiet mt-1"
        @click="allLongitudes"
      >
        All longitudes
      </button>
      <template
        v-if="
          plot.draft.geometry.kind !== GEOMETRY_KINDS.BOX &&
          plot.draft.geometry.kind !== GEOMETRY_KINDS.COUNTRY &&
          plot.draft.geometry.kind !== GEOMETRY_KINDS.SHAPE
        "
      >
        <div
          v-for="(v, at) in geometryVertices(plot.draft.geometry)"
          :key="at"
          class="analysis-row"
        >
          <span
            v-if="plot.draft.geometry.kind !== GEOMETRY_KINDS.POINT"
            class="analysis-vertex-number"
            >{{ at + 1 }}</span
          >
          <label>
            <span>Latitude (° N)</span>
            <input
              class="input is-small"
              type="number"
              step="any"
              min="-90"
              max="90"
              :value="v.lat"
              @change="setVertex(at, 'lat', numberValue($event))"
            />
          </label>
          <label>
            <span>Longitude (° E)</span>
            <input
              class="input is-small"
              type="number"
              step="any"
              :value="v.lon"
              @change="setVertex(at, 'lon', numberValue($event))"
            />
          </label>
          <button
            v-if="plot.draft.geometry.kind !== GEOMETRY_KINDS.POINT"
            type="button"
            class="button is-small analysis-quiet"
            :aria-label="`Remove point ${at + 1}`"
            @click="removeVertex(at)"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
      </template>
      <template v-if="plot.draft.geometry.kind === GEOMETRY_KINDS.COUNTRY">
        <p>{{ describeGeometry(plot.draft.geometry) }}</p>
        <!-- Chosen on the map, the plots stepping aside (25 Nov). -->
        <button
          type="button"
          class="button is-small analysis-quiet mt-1"
          data-change-country
          @click="emit('country')"
        >
          Change country or boundary detail
        </button>
      </template>
      <template v-else-if="drawnShape">
        <p>{{ describeGeometry(drawnShape) }}</p>
        <label v-if="offersModes" class="analysis-wide">
          <span>Region</span>
          <select class="input is-small" :value="regionMode" @change="setMode">
            <option
              v-for="(name, mode) in REGION_MODE_NAMES"
              :key="mode"
              :value="mode"
            >
              {{ name }}
            </option>
          </select>
        </label>
        <button
          type="button"
          class="button is-small analysis-quiet mt-1"
          @click="emit('redraw')"
        >
          <i class="fa-solid fa-pen mr-1" aria-hidden="true"></i>Redraw on map
        </button>
      </template>
      <template v-else-if="plot.draft.geometry.kind === GEOMETRY_KINDS.SHAPE">
        <p>{{ describeGeometry(plot.draft.geometry) }}</p>
        <ShapePicker
          v-if="editingShape"
          :kind="plot.kind"
          submit-label="Use selection"
          @select="selectShape"
          @cancel="closeShape"
          @preview="analysis.shapePreview = $event"
        />
        <button
          v-else
          type="button"
          class="button is-small analysis-quiet mt-1"
          @click="editingShape = true"
        >
          <i class="fa-solid fa-file-arrow-up mr-1" aria-hidden="true"></i
          >Import another shape…
        </button>
      </template>
      <button
        v-else
        type="button"
        class="button is-small analysis-quiet mt-1"
        @click="emit('redraw')"
      >
        <i class="fa-solid fa-pen mr-1" aria-hidden="true"></i>Redraw on map
      </button>
      <button
        v-if="editableForm(plot.draft.geometry)"
        type="button"
        class="button is-small analysis-quiet mt-1"
        data-edit-shape
        @click="emit('edit')"
      >
        <i
          class="fa-solid fa-arrows-up-down-left-right mr-1"
          aria-hidden="true"
        ></i
        >Edit on map
      </button>
    </fieldset>

    <fieldset v-if="summary">
      <legend>Parameters</legend>
      <template v-if="summary.time && plot.draft.time">
        <p class="analysis-help">
          {{ summary.time.calendar ?? "standard" }} calendar<span
            v-if="summary.time.note"
            >; {{ summary.time.note }}</span
          >
        </p>
        <!-- Ranges worth reading, priced from what the plot knows. -->
        <div
          v-if="isSeries && presets.length > 1"
          class="analysis-date-presets"
          role="group"
          aria-label="Date ranges"
        >
          <button
            v-for="preset in presets"
            :key="preset.id"
            type="button"
            class="analysis-date-preset"
            :aria-pressed="sameSelection(plot.draft.time, preset.range)"
            @click="analysis.updateDraft(plot.id, { time: preset.range })"
          >
            {{ preset.label
            }}<span v-if="preset.cost" class="analysis-cost">{{
              preset.cost
            }}</span>
          </button>
        </div>
        <div class="analysis-grid">
          <label>
            <span>{{ isSeries ? "From" : "Time" }}</span>
            <span class="analysis-date-field">
              <input
                class="input is-small"
                type="text"
                placeholder="YYYY-MM-DD HH:MM"
                data-time-start
                :value="timeLabelAt(summary.time, dateEnd.from)"
                @change="
                  setDate('start', ($event.target as HTMLInputElement).value)
                "
              />
              <!-- The map's own date picker, as beside the map's time. -->
              <span v-if="pickable" class="analysis-date-pick" data-pick-start>
                <AxisDatePicker
                  :value="timeLabelAt(summary.time, dateEnd.from)"
                  :first="timeLabelAt(summary.time, dateEnds.first)"
                  :last="timeLabelAt(summary.time, dateEnds.last)"
                  @pick="setDate('start', $event)"
                />
              </span>
            </span>
          </label>
          <label v-if="isSeries">
            <span>To</span>
            <span class="analysis-date-field">
              <input
                class="input is-small"
                type="text"
                placeholder="YYYY-MM-DD HH:MM"
                :value="timeLabelAt(summary.time, dateEnd.to)"
                @change="
                  setDate('stop', ($event.target as HTMLInputElement).value)
                "
              />
              <span v-if="pickable" class="analysis-date-pick" data-pick-stop>
                <AxisDatePicker
                  :value="timeLabelAt(summary.time, dateEnd.to)"
                  :first="timeLabelAt(summary.time, dateEnds.first)"
                  :last="timeLabelAt(summary.time, dateEnds.last)"
                  @pick="setDate('stop', $event)"
                />
              </span>
            </span>
          </label>
        </div>
        <p v-if="isSeries" class="analysis-help analysis-date-cost">
          {{ draftDates }}
        </p>
        <!-- Raw indices: for checking against the file, out of the way. -->
        <details class="analysis-advanced">
          <summary>Advanced: time indices</summary>
          <div class="analysis-grid">
            <label>
              <span>{{ isSeries ? "From index" : "Time index" }}</span>
              <input
                class="input is-small"
                type="number"
                min="0"
                :max="summary.time.raw.length - 1"
                :value="plot.draft.time.start"
                @change="
                  setTime(
                    numberValue($event),
                    isSeries ? plot.draft.time.stop : numberValue($event) + 1
                  )
                "
              />
            </label>
            <label v-if="isSeries">
              <span>To index</span>
              <input
                class="input is-small"
                type="number"
                min="0"
                :max="summary.time.raw.length - 1"
                :value="plot.draft.time.stop - 1"
                @change="
                  setTime(plot.draft.time.start, numberValue($event) + 1)
                "
              />
            </label>
          </div>
        </details>
        <p
          v-for="(note, which) in dateNotes"
          :key="which"
          class="analysis-help"
        >
          {{ note }}
        </p>
      </template>
      <label v-if="summary.vertical && fixedLevel" class="analysis-field">
        <span>{{ levelName }}</span>
        <span class="select is-small">
          <select
            :value="plot.draft.level"
            @change="
              analysis.updateDraft(plot.id, { level: numberValue($event) })
            "
          >
            <option
              v-for="(value, k) in summary.vertical.values"
              :key="k"
              :value="k"
            >
              {{
                summary.vertical.physical ? formatValue(value) : `level ${k}`
              }}
            </option>
          </select>
        </span>
      </label>
      <label
        v-for="other in summary.others"
        :key="other.dimension"
        class="analysis-field"
      >
        <span>{{ other.dimension }} (index 0–{{ other.size - 1 }})</span>
        <input
          class="input is-small"
          type="number"
          min="0"
          :max="other.size - 1"
          :value="plot.draft.fixed[other.dimension]"
          @change="
            analysis.updateDraft(plot.id, {
              fixed: {
                ...plot.draft.fixed,
                [other.dimension]: numberValue($event),
              },
            })
          "
        />
      </label>
      <label v-if="orderOptions.length > 1" class="analysis-field">
        <span>HEALPix order</span>
        <span class="select is-small">
          <select
            :value="plot.draft.variable"
            @change="
              analysis.updateDraft(plot.id, {
                variable: ($event.target as HTMLSelectElement).value,
              })
            "
          >
            <option
              v-for="option in orderOptions"
              :key="option.variable"
              :value="option.variable"
            >
              {{ option.order
              }}{{ option.preview ? " (coarse preview)" : " (native)" }}
            </option>
          </select>
        </span>
      </label>
      <label v-if="isPath" class="analysis-field">
        <span>Samples along path</span>
        <input
          :id="id('samples')"
          class="input is-small"
          type="number"
          min="2"
          max="20000"
          :value="plot.draft.sectionSamples"
          @change="
            analysis.updateDraft(plot.id, {
              sectionSamples: numberValue($event),
            })
          "
        />
      </label>
      <label v-if="isBand" class="analysis-field">
        <span
          >{{
            plot.kind === ANALYSIS_KINDS.HOVMOLLER_LON ||
            plot.kind === ANALYSIS_KINDS.LON_VERTICAL
              ? "Longitude"
              : "Latitude"
          }}
          bin width (°; empty: native spacing)</span
        >
        <input
          class="input is-small"
          type="number"
          :min="MIN_BIN_DEGREES"
          max="360"
          step="any"
          :value="plot.draft.binDegrees"
          @change="setBinDegrees($event)"
        />
      </label>
      <label
        v-if="plot.kind === ANALYSIS_KINDS.DISTRIBUTION"
        class="analysis-field"
      >
        <span>Value bins</span>
        <input
          class="input is-small"
          type="number"
          min="2"
          :max="MAX_VALUE_BINS"
          step="1"
          :value="plot.draft.valueBins ?? 30"
          @change="setValueBins($event)"
        />
      </label>
      <div
        v-if="plot.kind === ANALYSIS_KINDS.REGION_SERIES"
        class="analysis-field"
      >
        <label class="checkbox">
          <input
            type="checkbox"
            :checked="plot.draft.minCoverage !== undefined"
            @change="
              analysis.updateDraft(plot.id, {
                minCoverage: ($event.target as HTMLInputElement).checked
                  ? 0.5
                  : undefined,
              })
            "
          />
          Hide means below a valid-area threshold
        </label>
        <label
          v-if="plot.draft.minCoverage !== undefined"
          class="analysis-threshold"
        >
          <span>Threshold (%)</span>
          <input
            class="input is-small"
            type="number"
            min="0"
            max="100"
            :value="Math.round(plot.draft.minCoverage * 100)"
            @change="
              analysis.updateDraft(plot.id, {
                minCoverage: numberValue($event) / 100,
              })
            "
          />
        </label>
        <p class="analysis-help analysis-indented">
          Hidden means stay in Data and in exports.
        </p>
      </div>
      <div v-if="differs && !plot.snapshot" class="analysis-row mt-1">
        <span class="analysis-help">The map shows other settings.</span>
        <button
          type="button"
          class="button is-small analysis-quiet"
          @click="analysis.useMapSettings(plot.id, map)"
        >
          Use map settings
        </button>
      </div>
    </fieldset>
  </div>
</template>

<style scoped>
/* A date: typed, or picked with the map's own date picker beside it. */
.analysis-date-field {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.analysis-date-field > .input {
  flex: 1;
  min-width: 0;
}
.analysis-date-pick {
  flex: none;
  display: inline-flex;
}
/* Room for a whole date and its picker: From and To stack when narrow. */
.analysis-grid:has(.analysis-date-field) {
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
}
.analysis-date-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 4px 0 8px;
}
.analysis-date-preset {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  font: inherit;
  font-size: 0.74rem;
  color: var(--plot-fg);
  background: var(--plot-raised);
  border: 1px solid var(--plot-border);
  border-radius: 999px;
  cursor: pointer;
}
.analysis-date-preset[aria-pressed="true"] {
  color: var(--plot-accent);
  border-color: color-mix(in srgb, var(--plot-accent) 60%, transparent);
  background: color-mix(in srgb, var(--plot-accent) 10%, transparent);
}
.analysis-date-preset .analysis-cost {
  color: var(--plot-muted);
  font-variant-numeric: tabular-nums;
}
.analysis-date-cost {
  font-variant-numeric: tabular-nums;
}
.analysis-advanced {
  margin: 6px 0;
  font-size: 0.74rem;
}
.analysis-advanced > summary {
  color: var(--plot-muted);
  cursor: pointer;
}
@media (pointer: coarse) {
  .analysis-date-preset {
    height: 44px;
  }
}
.analysis-settings {
  /* The body of the Settings dialog, inside the plot's window. */
  padding: 8px 14px 10px;
}
fieldset {
  border: none;
  margin: 0 0 8px;
  padding: 0;
}
legend {
  font-weight: 600;
  margin-bottom: 4px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
label > span:first-child {
  color: var(--plot-muted);
}
/* A checkbox sits before its words, on one line (24 Nov). */
label.checkbox {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  width: fit-content;
}
label.checkbox > input {
  margin: 0;
  flex: none;
}
/* Its threshold beside it, indented under the words. */
.analysis-threshold {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  margin: 4px 0 0 21px;
}
.analysis-threshold > input {
  width: 5.5rem;
}
.analysis-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
}
.analysis-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  margin-bottom: 4px;
}
.analysis-field {
  margin-top: 8px;
}
.analysis-vertex-number {
  min-width: 1.2rem;
  padding-bottom: 6px;
  font-variant-numeric: tabular-nums;
}
.analysis-help {
  color: var(--plot-muted);
  margin: 2px 0;
}
.analysis-help.analysis-indented {
  margin-left: 21px;
}
.analysis-quiet {
  background: transparent;
  color: var(--plot-fg);
  border-color: var(--plot-border);
}
.analysis-wide {
  grid-column: 1 / -1;
}
.analysis-style {
  display: flex;
  flex-direction: column;
  gap: 2px;
  grid-column: span 2;
}
.analysis-style > span {
  color: var(--plot-muted);
}
.analysis-segmented {
  display: inline-flex;
  width: max-content;
  border: 1px solid var(--plot-border);
  border-radius: 6px;
  overflow: hidden;
}
.analysis-segmented button {
  padding: 3px 9px;
  border: 0;
  border-right: 1px solid var(--plot-border);
  background: transparent;
  color: var(--plot-fg);
  font-size: inherit;
  cursor: pointer;
}
.analysis-segmented button:last-child {
  border-right: 0;
}
.analysis-segmented button[aria-checked="true"] {
  background: color-mix(in srgb, var(--plot-accent) 22%, transparent);
  color: var(--plot-fg);
  font-weight: 600;
}
.analysis-auto {
  color: var(--plot-muted);
  font-weight: 400;
}
@media (pointer: coarse) {
  .analysis-segmented button {
    min-height: 40px;
  }
}
</style>
