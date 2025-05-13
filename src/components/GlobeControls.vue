<script lang="ts" setup>
import ColorBar from "@/components/ColorBar.vue";
import { computed, ref, watch, type Ref, onMounted } from "vue";
import { useGlobeControlStore } from "./store/store.ts";
import { storeToRefs } from "pinia";
import type {
  TColorMap,
  TModelInfo,
  TBounds,
  TVarInfo,
  TSelection,
} from "../types/GlobeTypes.js";

const props = defineProps<{ varinfo?: TVarInfo; modelInfo?: TModelInfo }>();

const emit = defineEmits<{
  selection: [TSelection];
  onSnapshot: [];
  onExample: [];
  onRotate: [];
}>();

const store = useGlobeControlStore();
const { timeIndexSlider, varnameSelector } = storeToRefs(store);
const menuCollapsed: Ref<boolean> = ref(false);
const colormap: Ref<TColorMap> = ref("turbo");
const invertColormap: Ref<boolean> = ref(true);
const autoColormap: Ref<boolean> = ref(true);
const defaultBounds: Ref<TBounds> = ref({});
const userBoundsLow: Ref<number | undefined> = ref(undefined);
const userBoundsHigh: Ref<number | undefined> = ref(undefined);
const pickedBounds = ref("auto");

// Theme management
const theme = ref<'light' | 'dark'>('light');
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute("data-theme", theme.value);
  localStorage.setItem('preferred-theme', theme.value);
}

// Initialize theme from system preference or localStorage
onMounted(() => {
  const savedTheme = localStorage.getItem('preferred-theme');
  if (savedTheme === 'dark' || savedTheme === 'light') {
    theme.value = savedTheme;
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    theme.value = 'dark';
  }
  document.documentElement.setAttribute("data-theme", theme.value);
});

const activeBounds = computed(() => {
  if (pickedBounds.value === "auto") {
    if (
      defaultBounds.value.low !== undefined &&
      defaultBounds.value.high !== undefined
    ) {
      return "default";
    } else {
      return "data";
    }
  } else {
    return pickedBounds.value;
  }
});

const dataBounds = computed(() => {
  return props.varinfo?.bounds ?? {};
});

const bounds = computed(() => {
  if (activeBounds.value === "data") {
    return dataBounds;
  } else if (activeBounds.value === "default") {
    return defaultBounds;
  } else if (activeBounds.value === "user") {
    return { low: userBoundsLow.value, high: userBoundsHigh.value };
  }
  return undefined;
});

const timeRange = computed(() => {
  return props.varinfo?.timeRange ?? { start: 0, end: 1 };
});

const currentTimeValue = computed(() => {
  return props.varinfo?.timeinfo?.current;
});

const currentVarName = computed(() => {
  return store.varname ?? "-";
});

const currentVarLongname = computed(() => {
  return props.varinfo?.attrs?.long_name ?? "-";
});

const currentVarUnits = computed(() => {
  return props.varinfo?.attrs?.units ?? "-";
});

watch(
  () => varnameSelector.value,
  () => {
    const varinfo = props.modelInfo!.vars[varnameSelector.value];
    defaultBounds.value = varinfo.default_range ?? {};
    setDefaultColormap();
    publish();
  }
);

watch(
  () => colormap.value,
  () => publish()
);

watch(
  () => invertColormap.value,
  () => publish()
);

watch(
  () => bounds.value,
  () => publish()
);

watch(
  () => autoColormap,
  () => setDefaultColormap()
);

function toggleMenu() {
  menuCollapsed.value = !menuCollapsed.value;
}

const publish = () => {
  emit("selection", {
    bounds: bounds.value as TBounds,
    colormap: colormap.value,
    invertColormap: invertColormap.value,
  });
};

const setDefaultColormap = () => {
  const defaultColormap =
    props.modelInfo?.vars[varnameSelector.value].default_colormap;
  if (autoColormap.value && defaultColormap !== undefined) {
    invertColormap.value = defaultColormap.inverted || false;
    colormap.value = defaultColormap.name;
  }
};

publish();  // ensure initial settings are published
</script>

<template>
  <nav id="main_controls" class="panel gl_controls" :class="{'dark-theme': theme === 'dark'}">
    <div class="panel-heading">
      <div v-if="modelInfo" class="model-title">
        {{ modelInfo.title }}
      </div>
      <div v-else>No data available</div>
      <div class="controls-header-actions">
        <button class="theme-toggle-btn" @click="toggleTheme" aria-label="Toggle theme">
          <i class="fa-solid" :class="theme === 'dark' ? 'fa-sun' : 'fa-moon'"></i>
        </button>
        <button class="menu-toggle-btn" @click="toggleMenu" aria-label="Toggle menu">
          <i class="fa-solid" :class="menuCollapsed ? 'fa-angle-down' : 'fa-angle-up'"></i>
        </button>
      </div>
    </div>

    <div
      v-if="modelInfo"
      class="panel-content"
      :class="{ 'is-hidden': menuCollapsed }"
    >
<<<<<<< HEAD
      <div class="panel-section">
        <div class="select-container">
          <select v-model="varnameSelector" class="form-select">
            <option
              v-for="varname in Object.keys(modelInfo.vars)"
              :key="varname"
              :value="varname"
            >
              {{ varname }}
            </option>
          </select>
        </div>
=======
      <div class="select is-fullwidth">
        <select v-model="varnameSelector" class="form-control">
          <option
            v-for="varname in Object.keys(modelInfo.vars)"
            :key="varname"
            :value="varname"
          >
            {{ varname }} <span v-if=" modelInfo.vars[varname]?.attrs?.standard_name">- 
              {{ modelInfo.vars[varname].attrs.standard_name }}</span>
          </option>
        </select>
>>>>>>> 76bbd5d250292263c35db81712a01f82731e9c1d
      </div>

      <div class="panel-section time-controls">
        <div class="section-header">Time Control</div>
        <div class="time-display">
          <div>Time:</div>
          <div class="time-input-group">
            <input
              v-model.number="timeIndexSlider"
              class="time-input"
              type="number"
              min="1"
              :max="timeRange.end"
            />
            <div class="time-max">/ {{ timeRange.end }}</div>
          </div>
        </div>
        
        <input
          v-model.number="timeIndexSlider"
          class="time-slider"
          type="range"
          :min="timeRange.start"
          :max="timeRange.end"
        />
        
        <div class="current-view-info">
          <div class="loading-status">
            Currently shown:
            <span :class="{ 'loading-indicator': store.loading === true }"></span>
          </div>
          <div class="view-details">
            {{ currentVarName }} @ {{ store.timeIndex }}
            <div v-if="currentTimeValue">
              {{ currentTimeValue.format() }}
            </div>
            <div class="var-meta">
              {{ currentVarLongname }} / {{ currentVarUnits }}
            </div>
          </div>
        </div>
      </div>

      <div class="panel-section">
        <div class="section-header">Range Settings</div>
        <table class="range-table">
          <tr>
            <th>Range</th>
            <th>Low</th>
            <th class="right">High</th>
          </tr>
          <tr :class="{ active: activeBounds === 'data' }">
            <td>
              <div class="radio-option">
                <input
                  id="data_bounds"
                  v-model="pickedBounds"
                  type="radio"
                  value="data"
                />
                <label for="data_bounds">Data</label>
              </div>
            </td>
            <td>{{ Number(dataBounds.low).toPrecision(4) }}</td>
            <td class="right">{{ Number(dataBounds.high).toPrecision(4) }}</td>
          </tr>
          <tr :class="{ active: activeBounds === 'default' }">
            <td>
              <div class="radio-option">
                <input
                  id="default_bounds"
                  v-model="pickedBounds"
                  type="radio"
                  value="default"
                />
                <label for="default_bounds">Default</label>
              </div>
            </td>
            <td>{{ Number(defaultBounds.low).toPrecision(2) }}</td>
            <td class="right">
              {{ Number(defaultBounds.high).toPrecision(2) }}
            </td>
          </tr>
          <tr :class="{ active: activeBounds === 'user' }">
            <td>
              <div class="radio-option">
                <input
                  id="user_bounds"
                  v-model="pickedBounds"
                  type="radio"
                  value="user"
                />
                <label for="user_bounds">User</label>
              </div>
            </td>
            <td>
              <input v-model.number="userBoundsLow" class="bounds-input" />
            </td>
            <td class="right">
              <input v-model.number="userBoundsHigh" class="bounds-input" />
            </td>
          </tr>
          <tr>
            <td>
              <div class="radio-option">
                <input
                  id="auto_bounds"
                  v-model="pickedBounds"
                  type="radio"
                  value="auto"
                />
                <label for="auto_bounds">Auto</label>
              </div>
            </td>
            <td></td>
            <td class="right"></td>
          </tr>
        </table>
      </div>

      <div class="panel-section colormap-section">
        <div class="colormap-controls">
          <div class="select-container">
            <select v-model="colormap" class="form-select">
              <option v-for="cm in modelInfo.colormaps" :key="cm" :value="cm">
                {{ cm }}
              </option>
            </select>
          </div>
          <ColorBar
            class="hcolormap"
            :colormap="colormap"
            :invert-colormap="invertColormap"
          />
        </div>
        <div class="colormap-options">
          <div class="checkbox-option">
            <input
              id="invert_colormap"
              v-model="invertColormap"
              type="checkbox"
            />
            <label for="invert_colormap">Invert</label>
          </div>
          <div class="checkbox-option">
            <input
              id="auto_colormap"
              v-model="autoColormap"
              type="checkbox"
            />
            <label for="auto_colormap">Auto</label>
          </div>
        </div>
      </div>

      <div class="panel-section">
        <div class="display-options">
          <div class="checkbox-option">
            <input
              id="enable_coastlines"
              type="checkbox"
              :checked="store.showCoastLines"
              @change="store.toggleCoastLines"
            />
            <label for="enable_coastlines">Coastlines</label>
          </div>
          <button class="action-button rotate-btn" @click="() => $emit('onRotate')">
            <i class="fa-solid fa-rotate"></i>
            Toggle Rotation
          </button>
        </div>
      </div>

      <div class="panel-section actions-section">
        <button class="action-button snapshot-btn" @click="() => $emit('onSnapshot')">
          <i class="fa-solid fa-image"></i> Snapshot
        </button>
        <button class="action-button copy-btn" @click="() => $emit('onExample')">
          <i class="fa-solid fa-clipboard"></i>
          Copy Python Example
        </button>
      </div>
    </div>
  </nav>
</template>

<style>
:root {
  --primary-color: #3273dc;
  --background-color: #fff;
  --text-color: #363636;
  --border-color: #dbdbdb;
  --panel-background: #f5f5f5;
  --panel-header-bg: #eee;
  --input-bg: #fff;
  --active-bg: #e0f7e0;
  --button-hover: #f0f0f0;
  --shadow-color: rgba(0, 0, 0, 0.1);
}

[data-theme="dark"] {
  --primary-color: #5e9eff;
  --background-color: #121212;
  --text-color: #e0e0e0;
  --border-color: #444;
  --panel-background: #1e1e1e;
  --panel-header-bg: #252525;
  --input-bg: #303030;
  --active-bg: #2E7D32;
  --button-hover: #333;
  --shadow-color: rgba(0, 0, 0, 0.4);
}

.gl_controls {
  color: var(--text-color);
  background-color: var(--panel-background);
  border-radius: 6px;
  box-shadow: 0 2px 5px var(--shadow-color);
  transition: background-color 0.3s, color 0.3s;
  max-width: 100%;
  overflow: hidden;
}

.panel-heading {
  background-color: var(--panel-header-bg);
  padding: 12px 16px;
  font-weight: 600;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border-color);
}

.model-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.controls-header-actions {
  display: flex;
  gap: 10px;
}

.theme-toggle-btn, .menu-toggle-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-color);
  font-size: 16px;
  padding: 4px;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.theme-toggle-btn:hover, .menu-toggle-btn:hover {
  background-color: var(--button-hover);
}

.panel-content {
  padding: 0;
  transition: max-height 0.3s ease;
}

.panel-content.is-hidden {
  max-height: 0;
  overflow: hidden;
}

.panel-section {
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.section-header {
  font-weight: 600;
  margin-bottom: 10px;
}

.select-container {
  position: relative;
  width: 100%;
}

.form-select {
  width: 100%;
  padding: 8px 12px;
  background-color: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: $px;
  color: var(--text-color);
  font-size: 14px;
  cursor: pointer;
  appearance: none;
  padding-right: 30px;
}

.select-container::after {
  content: '▼';
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
  font-size: 10px;
}

.time-controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.time-display {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.time-input-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.time-input {
  width: 70px;
  padding: 6px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background-color: var(--input-bg);
  color: var(--text-color);
}

.time-slider {
  width: 100%;
  margin: 8px 0;
  cursor: pointer;
  -webkit-appearance: none;
  height: 6px;
  background: var(--border-color);
  border-radius: 3px;
}

.time-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--primary-color);
  cursor: pointer;
}

.current-view-info {
  display: flex;
  justify-content: space-between;
  font-size: 14px;
}

.loading-status {
  display: flex;
  align-items: center;
  gap: 6px;
}

.loading-indicator {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--primary-color);
  border-radius: 50%;
  border-top-color: transparent;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.view-details {
  text-align: right;
}

.var-meta {
  font-size: 12px;
  opacity: 0.8;
  margin-top: 4px;
}

.range-table {
  width: 100%;
  border-collapse: collapse;
}

.range-table th, 
.range-table td {
  padding: 8px 4px;
}

.range-table th {
  text-align: left;
  font-weight: 600;
  border-bottom: 1px solid var(--border-color);
}

.range-table tr.active {
  background-color: var(--active-bg);
}

.radio-option, .checkbox-option {
  display: flex;
  align-items: center;
  gap: 6px;
}

.bounds-input {
  width: 100%;
  padding: 6px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background-color: var(--input-bg);
  color: var(--text-color);
}

.colormap-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.colormap-controls {
  display: flex;
  gap: 10px;
  align-items: center;
}

.colormap-options {
  display: flex;
  justify-content: space-between;
}

.hcolormap {
  width: 100%;
  height: 1.5em;
  max-height: 1.5em;
  overflow: hidden;
  border-radius: 4px;
  flex-grow: 1;
}


.action-button {
  background-color: var(--primary-color);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 8px 12px;
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: background-color 0.2s, transform 0.1s;
}

.action-button:hover {
  background-color: color-mix(in srgb, var(--primary-color) 90%, white);
}

.action-button:active {
  transform: translateY(1px);
}

.actions-section {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.display-options {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.rotate-btn {
  background-color: var(--text-color);
}

@media (max-width: 600px) {
  .time-display,
  .current-view-info,
  .colormap-controls,
  .display-options,
  .actions-section {
    flex-direction: column;
    gap: 10px;
  }
  
  .action-button {
    width: 100%;
  }
  
  .right {
    text-align: left !important;
  }
}

.right {
  text-align: right;
}
</style>