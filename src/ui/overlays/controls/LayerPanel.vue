<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, onMounted, ref } from "vue";

import PopupDialog from "./PopupDialog.vue";

import {
  LAND_SEA_MASK_MODES,
  type TLandSeaMaskMode,
} from "@/lib/layers/landSeaMask.ts";
import {
  isSupportedTextureLayerFile,
  TEXTURE_LAYER_UPLOAD_ACCEPT,
} from "@/lib/layers/textureLayerFormats.ts";
import {
  deleteTexture,
  getTexture,
  loadTextures,
  saveTexture,
} from "@/lib/layers/textureStore.ts";
import {
  COASTLINE_RESOLUTIONS,
  GRATICULE_SPACINGS,
  LAYER_KINDS,
  LAYER_OPACITY,
  useGlobeControlStore,
  type TLayerEntry,
  type TLayerKind,
} from "@/store/store.ts";
import { useLog } from "@/utils/logging.ts";

const store = useGlobeControlStore();
const {
  coastlineResolution,
  graticuleSpacing,
  landSeaMaskChoice,
  landSeaMaskUseTexture,
  layerStack,
  showCoastLines,
  showGraticules,
  varnameDisplay,
} = storeToRefs(store);
const { logError } = useLog();

const fileInput = ref<HTMLInputElement>();
const draggedId = ref<string | undefined>(undefined);
const dropTargetIndex = ref<number | undefined>(undefined);
const LAYER_ENTRY_SELECTOR = ".layer-entry";

const LAYER_ICONS: Record<TLayerKind, string> = {
  [LAYER_KINDS.COASTLINES]: "fa-earth-europe",
  [LAYER_KINDS.GRATICULES]: "fa-globe",
  [LAYER_KINDS.GRID]: "fa-border-all",
  [LAYER_KINDS.MASK]: "fa-mask",
  [LAYER_KINDS.TEXTURE]: "fa-image",
};

const MASK_LAYER_OPTIONS = {
  GLOBE: "globe",
  GLOBE_SIMPLE: "globe_simple",
  LAND: "land",
  LAND_SIMPLE: "land_simple",
  SEA: "sea",
  SEA_SIMPLE: "sea_simple",
} as const;

type TMaskLayerOption =
  (typeof MASK_LAYER_OPTIONS)[keyof typeof MASK_LAYER_OPTIONS];

type TVisibleLandSeaMaskMode = Exclude<
  TLandSeaMaskMode,
  typeof LAND_SEA_MASK_MODES.OFF
>;

const MASK_LAYER_OPTION_CONFIG: Record<
  TMaskLayerOption,
  { mode: TVisibleLandSeaMaskMode; useTexture: boolean }
> = {
  [MASK_LAYER_OPTIONS.GLOBE]: {
    mode: LAND_SEA_MASK_MODES.GLOBE,
    useTexture: true,
  },
  [MASK_LAYER_OPTIONS.GLOBE_SIMPLE]: {
    mode: LAND_SEA_MASK_MODES.GLOBE,
    useTexture: false,
  },
  [MASK_LAYER_OPTIONS.LAND]: {
    mode: LAND_SEA_MASK_MODES.LAND,
    useTexture: true,
  },
  [MASK_LAYER_OPTIONS.LAND_SIMPLE]: {
    mode: LAND_SEA_MASK_MODES.LAND,
    useTexture: false,
  },
  [MASK_LAYER_OPTIONS.SEA]: {
    mode: LAND_SEA_MASK_MODES.SEA,
    useTexture: true,
  },
  [MASK_LAYER_OPTIONS.SEA_SIMPLE]: {
    mode: LAND_SEA_MASK_MODES.SEA,
    useTexture: false,
  },
};

function getMaskLayerOption(
  mode: TLandSeaMaskMode,
  useTexture: boolean
): TMaskLayerOption {
  if (mode === LAND_SEA_MASK_MODES.GLOBE) {
    return useTexture
      ? MASK_LAYER_OPTIONS.GLOBE
      : MASK_LAYER_OPTIONS.GLOBE_SIMPLE;
  }
  if (mode === LAND_SEA_MASK_MODES.SEA) {
    return useTexture ? MASK_LAYER_OPTIONS.SEA : MASK_LAYER_OPTIONS.SEA_SIMPLE;
  }
  return useTexture ? MASK_LAYER_OPTIONS.LAND : MASK_LAYER_OPTIONS.LAND_SIMPLE;
}

const lastVisibleMaskLayerOption = ref<TMaskLayerOption>(
  getMaskLayerOption(landSeaMaskChoice.value, landSeaMaskUseTexture.value)
);

const maskLayerOption = computed<TMaskLayerOption>({
  get() {
    if (landSeaMaskChoice.value === LAND_SEA_MASK_MODES.OFF) {
      return lastVisibleMaskLayerOption.value;
    }
    return getMaskLayerOption(
      landSeaMaskChoice.value,
      landSeaMaskUseTexture.value
    );
  },
  set(value) {
    const config = MASK_LAYER_OPTION_CONFIG[value];
    lastVisibleMaskLayerOption.value = value;
    landSeaMaskChoice.value = config.mode;
    landSeaMaskUseTexture.value = config.useTexture;
  },
});

onMounted(async () => {
  try {
    const stored = await loadTextures();
    for (const texture of stored) {
      if (!layerStack.value.some((layer) => layer.id === texture.id)) {
        store.addTextureLayer(texture.id, texture.name, false);
      }
    }
  } catch (error) {
    logError(error, "Couldn't load stored texture layers");
  }
});

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !isSupportedTextureLayerFile(file)) {
    return;
  }
  try {
    const stored = await saveTexture(file.name, file);
    store.addTextureLayer(stored.id, stored.name);
  } catch (error) {
    logError(error, "Couldn't store the uploaded texture");
  }
}

async function removeLayer(layer: TLayerEntry) {
  store.removeTextureLayer(layer.id);
  try {
    await deleteTexture(layer.id);
  } catch (error) {
    logError(error, "Couldn't delete the stored texture");
  }
}

async function downloadLayer(layer: TLayerEntry) {
  try {
    const texture = await getTexture(layer.id);
    if (!texture) {
      return;
    }
    const url = URL.createObjectURL(texture.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = texture.name.replace(/\s/g, "");
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    logError(error, "Couldn't download the stored texture");
  }
}

function onDragStart(event: DragEvent, layer: TLayerEntry) {
  draggedId.value = layer.id;
  event.dataTransfer!.effectAllowed = "move";
}

function onDragOver(event: DragEvent, index: number) {
  event.preventDefault();
  dropTargetIndex.value = index;
}

function onDrop(index: number) {
  if (draggedId.value) {
    store.moveLayer(draggedId.value, index);
  }
  endDrag();
}

function isLayerControl(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(".layer-actions"));
}

function getLayerIndexAtPoint(clientX: number, clientY: number) {
  const target = document.elementFromPoint(clientX, clientY);
  const entry = target?.closest(LAYER_ENTRY_SELECTOR);
  if (!(entry instanceof HTMLElement)) {
    return undefined;
  }
  const index = Number(entry.dataset.layerIndex);
  return Number.isNaN(index) ? undefined : index;
}

function onTouchStart(event: TouchEvent, layer: TLayerEntry, index: number) {
  if (event.touches.length !== 1 || isLayerControl(event.target)) {
    return;
  }
  event.preventDefault();
  draggedId.value = layer.id;
  dropTargetIndex.value = index;
}

function onTouchMove(event: TouchEvent) {
  if (!draggedId.value) {
    return;
  }
  const touch = event.touches[0];
  if (!touch) {
    return;
  }
  event.preventDefault();
  const index = getLayerIndexAtPoint(touch.clientX, touch.clientY);
  if (index !== undefined) {
    dropTargetIndex.value = index;
  }
}

function onTouchEnd() {
  if (draggedId.value && dropTargetIndex.value !== undefined) {
    store.moveLayer(draggedId.value, dropTargetIndex.value);
  }
  endDrag();
}

function endDrag() {
  draggedId.value = undefined;
  dropTargetIndex.value = undefined;
}

function isLayerVisible(layer: TLayerEntry) {
  if (layer.kind === LAYER_KINDS.COASTLINES) {
    return showCoastLines.value;
  }
  if (layer.kind === LAYER_KINDS.GRATICULES) {
    return showGraticules.value;
  }
  if (layer.kind === LAYER_KINDS.MASK) {
    return landSeaMaskChoice.value !== LAND_SEA_MASK_MODES.OFF;
  }
  return layer.visible;
}

function toggleLayer(layer: TLayerEntry) {
  if (layer.kind === LAYER_KINDS.COASTLINES) {
    store.toggleCoastLines();
  } else if (layer.kind === LAYER_KINDS.GRATICULES) {
    store.toggleGraticules();
  } else if (layer.kind === LAYER_KINDS.MASK) {
    if (landSeaMaskChoice.value === LAND_SEA_MASK_MODES.OFF) {
      const config = MASK_LAYER_OPTION_CONFIG[lastVisibleMaskLayerOption.value];
      landSeaMaskChoice.value = config.mode;
      landSeaMaskUseTexture.value = config.useTexture;
    } else {
      lastVisibleMaskLayerOption.value = getMaskLayerOption(
        landSeaMaskChoice.value,
        landSeaMaskUseTexture.value
      );
      landSeaMaskChoice.value = LAND_SEA_MASK_MODES.OFF;
    }
  } else if (layer.kind === LAYER_KINDS.TEXTURE) {
    store.updateTextureLayer(layer.id, { visible: !layer.visible });
  }
}

function canChangeLayerOpacity(layer: TLayerEntry) {
  return layer.kind === LAYER_KINDS.MASK || layer.kind === LAYER_KINDS.TEXTURE;
}

function getLayerOpacity(layer: TLayerEntry) {
  return layer.opacity ?? LAYER_OPACITY.MAX;
}

function formatLayerOpacity(layer: TLayerEntry) {
  return `${(getLayerOpacity(layer) * 100).toFixed(0)}%`;
}

function setLayerOpacity(layer: TLayerEntry, event: Event) {
  store.updateLayerOpacity(
    layer.id,
    (event.target as HTMLInputElement).valueAsNumber
  );
}

function getLayerName(layer: TLayerEntry) {
  if (layer.kind === LAYER_KINDS.GRID && varnameDisplay.value !== "-") {
    return `${layer.name}: ${varnameDisplay.value}`;
  }
  return layer.name;
}
</script>

<template>
  <div class="column">
    <ul class="layer-stack mb-2">
      <li
        v-for="(layer, index) in layerStack"
        :key="layer.id"
        class="layer-entry"
        :class="{
          'is-inactive': !isLayerVisible(layer),
          'is-drop-target': dropTargetIndex === index,
          'is-dragging': draggedId === layer.id,
        }"
        :data-layer-index="index"
        draggable="true"
        @dragstart="onDragStart($event, layer)"
        @dragover="onDragOver($event, index)"
        @drop="onDrop(index)"
        @dragend="endDrag"
        @touchstart="onTouchStart($event, layer, index)"
        @touchmove="onTouchMove"
        @touchend="onTouchEnd"
        @touchcancel="endDrag"
      >
        <span class="icon is-small">
          <i class="fa-solid" :class="LAYER_ICONS[layer.kind]"></i>
        </span>
        <span class="layer-name is-size-7" :title="getLayerName(layer)">
          {{ layer.name }}
          <template
            v-if="layer.kind === LAYER_KINDS.GRID && varnameDisplay !== '-'"
          >
            : <strong class="is-family-code">{{ varnameDisplay }}</strong>
          </template>
        </span>
        <div class="layer-actions">
          <template v-if="layer.kind === LAYER_KINDS.COASTLINES">
            <div class="select is-small layer-select">
              <select v-model="coastlineResolution" title="Coastline detail">
                <option :value="COASTLINE_RESOLUTIONS.TEN_M">10m</option>
                <option :value="COASTLINE_RESOLUTIONS.FIFTY_M">50m</option>
              </select>
            </div>
          </template>
          <template v-if="layer.kind === LAYER_KINDS.GRATICULES">
            <div class="select is-small layer-select">
              <select v-model="graticuleSpacing" title="Graticule spacing">
                <option :value="GRATICULE_SPACINGS.FIFTEEN_DEGREES">
                  15&deg;
                </option>
                <option :value="GRATICULE_SPACINGS.THIRTY_DEGREES">
                  30&deg;
                </option>
              </select>
            </div>
          </template>
          <template v-if="layer.kind === LAYER_KINDS.MASK">
            <div class="select is-small layer-select">
              <select
                id="land_sea_mask"
                v-model="maskLayerOption"
                title="Land/sea mask"
              >
                <option :value="MASK_LAYER_OPTIONS.GLOBE">Globe</option>
                <option :value="MASK_LAYER_OPTIONS.GLOBE_SIMPLE">
                  Globe simple
                </option>
                <option :value="MASK_LAYER_OPTIONS.LAND">Land</option>
                <option :value="MASK_LAYER_OPTIONS.LAND_SIMPLE">
                  Land simple
                </option>
                <option :value="MASK_LAYER_OPTIONS.SEA">Sea</option>
                <option :value="MASK_LAYER_OPTIONS.SEA_SIMPLE">
                  Sea simple
                </option>
              </select>
            </div>
          </template>
          <template v-if="layer.kind === LAYER_KINDS.TEXTURE">
            <div class="select is-small layer-select">
              <select
                :value="layer.maskMode"
                title="Land/sea cutout"
                @change="
                  store.updateTextureLayer(layer.id, {
                    maskMode: ($event.target as HTMLSelectElement)
                      .value as typeof layer.maskMode,
                  })
                "
              >
                <option :value="LAND_SEA_MASK_MODES.OFF">All</option>
                <option :value="LAND_SEA_MASK_MODES.LAND">Land</option>
                <option :value="LAND_SEA_MASK_MODES.SEA">Sea</option>
              </select>
            </div>
            <button
              class="button is-small is-light"
              type="button"
              title="Download layer"
              @click="downloadLayer(layer)"
            >
              <span class="icon is-small">
                <i class="fa-solid fa-download"></i>
              </span>
            </button>
            <button
              class="button is-small is-light"
              type="button"
              title="Delete layer"
              @click="removeLayer(layer)"
            >
              <span class="icon is-small">
                <i class="fa-solid fa-trash"></i>
              </span>
            </button>
          </template>
          <template v-if="canChangeLayerOpacity(layer)">
            <PopupDialog dialog-class="layer-opacity-popover">
              <template #trigger="{ toggle, open }">
                <button
                  class="button is-small is-light"
                  :class="{
                    'is-info':
                      open || getLayerOpacity(layer) < LAYER_OPACITY.MAX,
                  }"
                  type="button"
                  :title="`Opacity: ${formatLayerOpacity(layer)}`"
                  :aria-expanded="open"
                  :aria-label="`${layer.name} opacity`"
                  @click.stop="toggle"
                  @mousedown.stop
                  @touchstart.stop
                >
                  <span class="icon is-small">
                    <i class="fa-solid fa-circle-half-stroke"></i>
                  </span>
                </button>
              </template>

              <template #default>
                <label class="layer-opacity-control">
                  <span class="layer-opacity-header">
                    <span>Opacity</span>
                    <span class="tag is-light layer-opacity-value">
                      {{ formatLayerOpacity(layer) }}
                    </span>
                  </span>
                  <input
                    class="layer-opacity"
                    type="range"
                    :min="LAYER_OPACITY.MIN"
                    :max="LAYER_OPACITY.MAX"
                    :step="LAYER_OPACITY.STEP"
                    :value="getLayerOpacity(layer)"
                    :aria-label="`${layer.name} opacity`"
                    @input="setLayerOpacity(layer, $event)"
                  />
                </label>
              </template>
            </PopupDialog>
          </template>
          <template v-else-if="layer.kind === LAYER_KINDS.GRID">
            <span
              class="tag is-info"
              :class="{ 'is-light': !store.hoverEnabled }"
              >Active data</span
            >
          </template>
          <template v-if="layer.kind !== LAYER_KINDS.GRID">
            <button
              class="button is-small is-light"
              :class="{ 'is-info': isLayerVisible(layer) }"
              type="button"
              :title="isLayerVisible(layer) ? 'Hide layer' : 'Show layer'"
              :aria-pressed="isLayerVisible(layer)"
              @click="toggleLayer(layer)"
            >
              <span class="icon is-small">
                <i
                  class="fa-solid"
                  :class="isLayerVisible(layer) ? 'fa-eye' : 'fa-eye-slash'"
                ></i>
              </span>
            </button>
          </template>
        </div>
      </li>
    </ul>
    <div class="buttons">
      <button
        class="button is-small is-light"
        type="button"
        title="Upload a texture image (PNG, JPG, or GeoTIFF)"
        @click="fileInput?.click()"
      >
        <span class="icon is-small"><i class="fa-solid fa-upload"></i></span>
        <span>Upload</span>
      </button>
      <button
        class="button is-small is-light"
        :class="{ 'is-loading': store.gridExportLoading }"
        type="button"
        :disabled="store.gridExportLoading || varnameDisplay === '-'"
        title="Export the current grid as a GeoTIFF texture layer"
        @click="store.requestGridExport()"
      >
        <span class="icon is-small"><i class="fa-solid fa-camera"></i></span>
        <span>
          <span class="is-family-code is-danger">"{{ varnameDisplay }}"</span>
          as image layer</span
        >
      </button>
      <input
        ref="fileInput"
        :accept="TEXTURE_LAYER_UPLOAD_ACCEPT"
        class="is-hidden"
        type="file"
        @change="onFileSelected"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.layer-stack {
  border: 1px solid var(--bulma-border);
  border-radius: 4px;
}

.layer-entry {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.5rem;
  cursor: grab;
  touch-action: none;

  &:not(:last-child) {
    border-bottom: 1px solid var(--bulma-border);
  }

  &.is-dragging {
    opacity: 0.4;
  }

  &.is-inactive {
    color: var(--bulma-grey);
    background-color: rgba(128, 128, 128, 0.06);
  }

  &.is-inactive .layer-name,
  &.is-inactive > .icon {
    opacity: 0.55;
  }

  &.is-drop-target {
    outline: 2px solid var(--bulma-link);
  }
}

.layer-name {
  flex: 1;
  min-width: 4rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layer-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 0.35rem;
}

.layer-select select {
  max-width: 7rem;
}

.layer-opacity-control {
  display: block;
  min-width: 11rem;
}

.layer-opacity-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.4rem;
  font-size: 0.75rem;
  font-weight: 700;
}

.layer-opacity {
  width: 100%;
}

.layer-opacity-value {
  min-width: 2.5rem;
  justify-content: center;
}
</style>
