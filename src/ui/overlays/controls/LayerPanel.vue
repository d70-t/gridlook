<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, onMounted, ref } from "vue";

import {
  LAND_SEA_MASK_MODES,
  type TLandSeaMaskMode,
} from "@/lib/layers/landSeaMask.ts";
import {
  deleteTexture,
  getTexture,
  loadTextures,
  saveTexture,
} from "@/lib/layers/textureStore.ts";
import {
  LAYER_KINDS,
  useGlobeControlStore,
  type TLayerEntry,
  type TLayerKind,
} from "@/store/store.ts";
import { useLog } from "@/utils/logging.ts";

const store = useGlobeControlStore();
const {
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

const maskLayerOption = computed<TMaskLayerOption>({
  get() {
    return getMaskLayerOption(
      landSeaMaskChoice.value,
      landSeaMaskUseTexture.value
    );
  },
  set(value) {
    const config = MASK_LAYER_OPTION_CONFIG[value];
    landSeaMaskChoice.value = config.mode;
    landSeaMaskUseTexture.value = config.useTexture;
  },
});

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

onMounted(async () => {
  try {
    const stored = await loadTextures();
    for (const texture of stored) {
      if (!layerStack.value.some((layer) => layer.id === texture.id)) {
        store.addTextureLayer(texture.id, texture.name);
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
  if (!file || !["image/png", "image/jpeg"].includes(file.type)) {
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
    link.download = texture.name;
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
      landSeaMaskChoice.value = LAND_SEA_MASK_MODES.LAND;
      landSeaMaskUseTexture.value = false;
    } else {
      landSeaMaskChoice.value = LAND_SEA_MASK_MODES.OFF;
    }
  } else if (layer.kind === LAYER_KINDS.TEXTURE) {
    store.updateTextureLayer(layer.id, { visible: !layer.visible });
  }
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
        draggable="true"
        @dragstart="onDragStart($event, layer)"
        @dragover="onDragOver($event, index)"
        @drop="onDrop(index)"
        @dragend="endDrag"
      >
        <span class="icon is-small">
          <i class="fa-solid" :class="LAYER_ICONS[layer.kind]"></i>
        </span>
        <span class="layer-name is-size-7" :title="getLayerName(layer)">
          {{ getLayerName(layer) }}
        </span>
        <div class="layer-actions">
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
          <template v-else-if="layer.kind === LAYER_KINDS.GRID">
            <button
              class="button is-small is-light"
              disabled
              type="button"
              title="Data grid anchor"
            >
              <span class="icon is-small">
                <i class="fa-solid fa-lock"></i>
              </span>
            </button>
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
        title="Upload a texture image (PNG or JPG, equirectangular)"
        @click="fileInput?.click()"
      >
        <span class="icon is-small"><i class="fa-solid fa-upload"></i></span>
        <span>Add texture</span>
      </button>
      <button
        class="button is-small is-light"
        type="button"
        title="Export the current grid as an equirectangular texture layer"
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
        accept="image/png,image/jpeg"
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
</style>
