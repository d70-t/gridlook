<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, nextTick, onMounted, ref } from "vue";
import {
  SelectListbox,
  type SelectModelValue,
  SelectOption,
  SelectPopover,
  SelectRoot,
  SelectTrailingIcon,
  SelectTrigger,
  SelectValue,
} from "vue3-select-component";
import "vue3-select-component/styles.css";

import { getVariableGroup } from "@/lib/data/vectorField.ts";
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
import type { TModelInfo } from "@/lib/types/GlobeTypes.ts";
import {
  BUILTIN_LAYER_NAMES,
  COASTLINE_RESOLUTIONS,
  GRATICULE_SPACINGS,
  LAYER_KINDS,
  LAYER_OPACITY,
  useGlobeControlStore,
  type TLayerEntry,
  type TLayerKind,
} from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";

const props = defineProps<{
  modelInfo?: TModelInfo;
}>();

const store = useGlobeControlStore();
const {
  coastlineResolution,
  graticuleSpacing,
  landSeaMaskChoice,
  landSeaMaskUseTexture,
  layerStack,
  showCoastLines,
  showGraticules,
  streamlinePair,
  streamlineSelection,
  varnameDisplay,
  varnameSelector,
} = storeToRefs(store);
const { logError } = useLog();

const fileInput = ref<HTMLInputElement>();
const draggedId = ref<string | undefined>(undefined);
const dropTargetIndex = ref<number | undefined>(undefined);
const expandedLayerId = ref<string | undefined>(undefined);
const addLayerSelection = ref<TAddLayerAction | null>(null);
const LAYER_ENTRY_SELECTOR = ".layer-entry";

const ADD_LAYER_ACTIONS = {
  COASTLINES: LAYER_KINDS.COASTLINES,
  GRATICULES: LAYER_KINDS.GRATICULES,
  MASK: LAYER_KINDS.MASK,
  STREAMLINES: LAYER_KINDS.STREAMLINES,
  UPLOAD: "upload",
  VARIABLE_IMAGE: "variable-image",
} as const;

type TAddLayerAction =
  (typeof ADD_LAYER_ACTIONS)[keyof typeof ADD_LAYER_ACTIONS];

type TAddLayerOption = {
  value: TAddLayerAction;
  label: string;
  icon: string;
  disabled?: boolean;
};

const vectorVariables = computed(() =>
  Object.keys(props.modelInfo?.vars ?? {})
    .filter(
      (name) =>
        !props.modelInfo?.vars[name].hidden &&
        getVariableGroup(name) === getVariableGroup(varnameSelector.value)
    )
    .sort((a, b) => a.localeCompare(b))
);

function vectorVariableLabel(name: string) {
  return name.slice(name.lastIndexOf("/") + 1);
}

function vectorComponentValue(component: "u" | "v") {
  const value = streamlineSelection.value.automatic
    ? (streamlinePair.value?.[component] ?? "")
    : (streamlineSelection.value[component] ?? "");
  return vectorVariables.value.includes(value) ? value : "";
}

function setVectorComponent(component: "u" | "v", value: string) {
  store.setStreamlineSelection({
    automatic: false,
    u: vectorComponentValue("u") || undefined,
    v: vectorComponentValue("v") || undefined,
    [component]: value || undefined,
  });
}

const LAYER_BUTTONS = {
  DOWNLOAD: "download",
  OPACITY: "opacity",
  REMOVE: "remove",
} as const;

type TLayerButton = (typeof LAYER_BUTTONS)[keyof typeof LAYER_BUTTONS];

type TLayerProperties = {
  buttons: TLayerButton[];
};

const LAYER_ICONS: Record<TLayerKind, string> = {
  [LAYER_KINDS.COASTLINES]: "fa-earth-europe",
  [LAYER_KINDS.GRATICULES]: "fa-globe",
  [LAYER_KINDS.GRID]: "fa-border-all",
  [LAYER_KINDS.MASK]: "fa-mask",
  [LAYER_KINDS.STREAMLINES]: "fa-wind",
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

function toggleMaskLayerVisibility() {
  if (landSeaMaskChoice.value === LAND_SEA_MASK_MODES.OFF) {
    const config = MASK_LAYER_OPTION_CONFIG[lastVisibleMaskLayerOption.value];
    landSeaMaskChoice.value = config.mode;
    landSeaMaskUseTexture.value = config.useTexture;
    return;
  }
  lastVisibleMaskLayerOption.value = getMaskLayerOption(
    landSeaMaskChoice.value,
    landSeaMaskUseTexture.value
  );
  landSeaMaskChoice.value = LAND_SEA_MASK_MODES.OFF;
}

const LAYER_PROPERTIES: Record<TLayerKind, TLayerProperties> = {
  [LAYER_KINDS.COASTLINES]: {
    buttons: [LAYER_BUTTONS.REMOVE],
  },
  [LAYER_KINDS.GRATICULES]: {
    buttons: [LAYER_BUTTONS.REMOVE],
  },
  [LAYER_KINDS.GRID]: {
    buttons: [],
  },
  [LAYER_KINDS.MASK]: {
    buttons: [LAYER_BUTTONS.OPACITY, LAYER_BUTTONS.REMOVE],
  },
  [LAYER_KINDS.STREAMLINES]: {
    buttons: [LAYER_BUTTONS.OPACITY, LAYER_BUTTONS.REMOVE],
  },
  [LAYER_KINDS.TEXTURE]: {
    buttons: [
      LAYER_BUTTONS.OPACITY,
      LAYER_BUTTONS.DOWNLOAD,
      LAYER_BUTTONS.REMOVE,
    ],
  },
};

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
  expandedLayerId.value = undefined;
  if (layer.kind !== LAYER_KINDS.TEXTURE && isLayerVisible(layer)) {
    toggleLayer(layer);
  }
  store.removeLayer(layer.id);
  if (layer.kind !== LAYER_KINDS.TEXTURE) {
    return;
  }
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
  return (
    target instanceof Element &&
    Boolean(
      target.closest(".layer-actions, .layer-details, .streamline-components")
    )
  );
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

function isLayerAvailable(layer: TLayerEntry) {
  return layer.kind !== LAYER_KINDS.STREAMLINES || Boolean(props.modelInfo);
}

const displayedLayerStack = computed(() =>
  layerStack.value.filter(isLayerAvailable)
);

function hasDisplayedLayer(kind: TLayerKind) {
  return displayedLayerStack.value.some((layer) => layer.kind === kind);
}

const addLayerOptions = computed<TAddLayerOption[]>(() => {
  const options: TAddLayerOption[] = [];
  if (!hasDisplayedLayer(LAYER_KINDS.COASTLINES)) {
    options.push({
      value: ADD_LAYER_ACTIONS.COASTLINES,
      label: BUILTIN_LAYER_NAMES[LAYER_KINDS.COASTLINES],
      icon: LAYER_ICONS[LAYER_KINDS.COASTLINES],
    });
  }
  if (!hasDisplayedLayer(LAYER_KINDS.GRATICULES)) {
    options.push({
      value: ADD_LAYER_ACTIONS.GRATICULES,
      label: BUILTIN_LAYER_NAMES[LAYER_KINDS.GRATICULES],
      icon: LAYER_ICONS[LAYER_KINDS.GRATICULES],
    });
  }
  if (!hasDisplayedLayer(LAYER_KINDS.MASK)) {
    options.push({
      value: ADD_LAYER_ACTIONS.MASK,
      label: BUILTIN_LAYER_NAMES[LAYER_KINDS.MASK],
      icon: LAYER_ICONS[LAYER_KINDS.MASK],
    });
  }
  if (!hasDisplayedLayer(LAYER_KINDS.STREAMLINES)) {
    options.push({
      value: ADD_LAYER_ACTIONS.STREAMLINES,
      label: BUILTIN_LAYER_NAMES[LAYER_KINDS.STREAMLINES],
      icon: LAYER_ICONS[LAYER_KINDS.STREAMLINES],
      disabled: !props.modelInfo,
    });
  }
  options.push(
    {
      value: ADD_LAYER_ACTIONS.UPLOAD,
      label: "Upload image layer",
      icon: "fa-upload",
    },
    {
      value: ADD_LAYER_ACTIONS.VARIABLE_IMAGE,
      label:
        varnameDisplay.value === "-"
          ? "Current variable as image layer"
          : `"${varnameDisplay.value}" as image layer`,
      icon: "fa-camera",
      disabled: store.gridExportLoading || varnameDisplay.value === "-",
    }
  );
  return options;
});

function addLayer(action: TAddLayerAction) {
  if (action === ADD_LAYER_ACTIONS.COASTLINES) {
    store.restoreBuiltinLayer(LAYER_KINDS.COASTLINES);
    if (!showCoastLines.value) {
      store.toggleCoastLines();
    }
  } else if (action === ADD_LAYER_ACTIONS.GRATICULES) {
    store.restoreBuiltinLayer(LAYER_KINDS.GRATICULES);
    if (!showGraticules.value) {
      store.toggleGraticules();
    }
  } else if (action === ADD_LAYER_ACTIONS.MASK) {
    store.restoreBuiltinLayer(LAYER_KINDS.MASK);
    if (landSeaMaskChoice.value === LAND_SEA_MASK_MODES.OFF) {
      const config = MASK_LAYER_OPTION_CONFIG[lastVisibleMaskLayerOption.value];
      landSeaMaskChoice.value = config.mode;
      landSeaMaskUseTexture.value = config.useTexture;
    }
  } else if (action === ADD_LAYER_ACTIONS.STREAMLINES) {
    store.restoreBuiltinLayer(LAYER_KINDS.STREAMLINES);
    store.setStreamlineLayerEnabled(true);
  } else if (action === ADD_LAYER_ACTIONS.UPLOAD) {
    fileInput.value?.click();
  } else if (
    action === ADD_LAYER_ACTIONS.VARIABLE_IMAGE &&
    !store.gridExportLoading &&
    varnameDisplay.value !== "-"
  ) {
    store.requestGridExport();
  }
}

function onAddLayerSelection(value: SelectModelValue<TAddLayerAction>) {
  if (value === null || Array.isArray(value)) {
    return;
  }
  addLayerSelection.value = value;
  addLayer(value);
  void nextTick(() => {
    addLayerSelection.value = null;
  });
}

function getLayerStackIndex(layer: TLayerEntry) {
  return layerStack.value.indexOf(layer);
}

function toggleExpandedLayer(layer: TLayerEntry) {
  expandedLayerId.value =
    expandedLayerId.value === layer.id ? undefined : layer.id;
}

function toggleLayer(layer: TLayerEntry) {
  if (layer.kind === LAYER_KINDS.COASTLINES) {
    store.toggleCoastLines();
  } else if (layer.kind === LAYER_KINDS.GRATICULES) {
    store.toggleGraticules();
  } else if (layer.kind === LAYER_KINDS.MASK) {
    toggleMaskLayerVisibility();
  } else if (layer.kind === LAYER_KINDS.TEXTURE) {
    store.updateTextureLayer(layer.id, { visible: !layer.visible });
  } else {
    store.toggleLayerVisibility(layer.id);
  }
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
        v-for="layer in displayedLayerStack"
        :key="layer.id"
        class="layer-entry"
        :class="{
          'is-inactive': !isLayerVisible(layer),
          'is-drop-target': dropTargetIndex === getLayerStackIndex(layer),
          'is-dragging': draggedId === layer.id,
        }"
        :data-layer-index="getLayerStackIndex(layer)"
        @dragstart="onDragStart($event, layer)"
        @dragover="onDragOver($event, getLayerStackIndex(layer))"
        @drop="onDrop(getLayerStackIndex(layer))"
        @dragend="endDrag"
        @touchstart="onTouchStart($event, layer, getLayerStackIndex(layer))"
        @touchmove="onTouchMove"
        @touchend="onTouchEnd"
        @touchcancel="endDrag"
      >
        <div class="layer-drag-handle" draggable="true">
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
        </div>
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
                :title="BUILTIN_LAYER_NAMES[LAYER_KINDS.MASK]"
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
          </template>
          <template v-if="layer.kind === LAYER_KINDS.GRID">
            <span
              class="tag is-info"
              :class="{ 'is-light': !store.hoverEnabled }"
              >Active data</span
            >
          </template>
          <button
            v-if="LAYER_PROPERTIES[layer.kind].buttons.length >= 1"
            class="button is-small is-light layer-expand-button"
            type="button"
            title="More layer controls"
            :aria-expanded="expandedLayerId === layer.id"
            :aria-label="`More controls for ${layer.name}`"
            @click="toggleExpandedLayer(layer)"
          >
            <span class="icon is-small">
              <i class="fa-solid fa-ellipsis"></i>
            </span>
          </button>
          <button
            class="button is-small is-light"
            :class="{ 'is-info': isLayerVisible(layer) }"
            type="button"
            :disabled="layer.kind === LAYER_KINDS.STREAMLINES && !modelInfo"
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
        </div>
        <div v-if="expandedLayerId === layer.id" class="layer-details">
          <label
            v-if="
              LAYER_PROPERTIES[layer.kind].buttons.includes(
                LAYER_BUTTONS.OPACITY
              )
            "
            class="layer-opacity-control"
          >
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
          <div
            v-if="
              LAYER_PROPERTIES[layer.kind].buttons.includes(
                LAYER_BUTTONS.REMOVE
              ) ||
              LAYER_PROPERTIES[layer.kind].buttons.includes(
                LAYER_BUTTONS.DOWNLOAD
              )
            "
            class="layer-detail-actions"
            :class="
              LAYER_PROPERTIES[layer.kind].buttons.includes(
                LAYER_BUTTONS.OPACITY
              )
                ? 'layer-detail-actions-margin'
                : ''
            "
          >
            <button
              v-if="
                LAYER_PROPERTIES[layer.kind].buttons.includes(
                  LAYER_BUTTONS.DOWNLOAD
                )
              "
              class="button is-small is-light"
              type="button"
              title="Download layer"
              @click="downloadLayer(layer)"
            >
              <span class="icon is-small">
                <i class="fa-solid fa-download"></i>
              </span>
              <span>Download Layer</span>
            </button>
            <button
              v-if="
                LAYER_PROPERTIES[layer.kind].buttons.includes(
                  LAYER_BUTTONS.REMOVE
                )
              "
              class="button is-small is-danger"
              type="button"
              title="Remove layer"
              :aria-label="`Remove ${layer.name}`"
              @click="removeLayer(layer)"
            >
              <span class="icon is-small">
                <i class="fa-solid fa-trash"></i>
              </span>
              <span>Remove Layer</span>
            </button>
          </div>
        </div>
        <div
          v-if="layer.kind === LAYER_KINDS.STREAMLINES && isLayerVisible(layer)"
          class="streamline-components"
        >
          <label>
            <span>U</span>
            <span class="select is-small">
              <select
                :value="vectorComponentValue('u')"
                aria-label="Flow eastward or x component"
                @change="
                  setVectorComponent(
                    'u',
                    ($event.target as HTMLSelectElement).value
                  )
                "
              >
                <option value="">Choose…</option>
                <option
                  v-for="name in vectorVariables"
                  :key="name"
                  :value="name"
                >
                  {{ vectorVariableLabel(name) }}
                </option>
              </select>
            </span>
          </label>
          <label>
            <span>V</span>
            <span class="select is-small">
              <select
                :value="vectorComponentValue('v')"
                aria-label="Flow northward or y component"
                @change="
                  setVectorComponent(
                    'v',
                    ($event.target as HTMLSelectElement).value
                  )
                "
              >
                <option value="">Choose…</option>
                <option
                  v-for="name in vectorVariables"
                  :key="name"
                  :value="name"
                >
                  {{ vectorVariableLabel(name) }}
                </option>
              </select>
            </span>
          </label>
        </div>
      </li>
    </ul>
    <SelectRoot
      :model-value="addLayerSelection"
      :options="addLayerOptions"
      :loading="store.gridExportLoading"
      class="add-layer-select"
      data-assembled-select
      @update:model-value="onAddLayerSelection"
    >
      <SelectTrigger aria-label="Add layer">
        <SelectValue placeholder="Add layer…" />
        <SelectTrailingIcon>
          <i class="fa-solid fa-angle-down is-size-5"></i>
        </SelectTrailingIcon>
      </SelectTrigger>

      <SelectPopover>
        <SelectListbox>
          <SelectOption
            v-for="option in addLayerOptions"
            :key="option.value"
            :value="option.value"
            :label="option.label"
            :disabled="option.disabled"
          >
            <span class="add-layer-option">
              <span class="icon is-small">
                <i class="fa-solid" :class="option.icon"></i>
              </span>
              <span>{{ option.label }}</span>
            </span>
          </SelectOption>
        </SelectListbox>
      </SelectPopover>
    </SelectRoot>
    <input
      ref="fileInput"
      :accept="TEXTURE_LAYER_UPLOAD_ACCEPT"
      class="is-hidden"
      type="file"
      @change="onFileSelected"
    />
  </div>
</template>

<style lang="scss" scoped>
.layer-stack {
  border-radius: 4px;
  background: var(--bulma-scheme-main-bis);
}

.layer-entry {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.5rem;
  flex-wrap: wrap;

  &:not(:last-child) {
    border-bottom: 1px solid var(--control-divider);
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

.layer-drag-handle {
  display: flex;
  align-items: center;
  align-self: stretch;
  flex: 1;
  gap: 0.4rem;
  min-width: 4rem;
  cursor: grab;
  touch-action: none;
}

.streamline-components {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
  flex-basis: 100%;
  padding-left: 1.65rem;

  label {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
  }

  .select,
  select {
    width: 100%;
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

.layer-expand-button {
  min-width: 2rem;
  font-weight: 700;
}

.layer-details {
  flex-basis: 100%;
  // padding: 0 1.65rem;
}

.layer-detail-actions-margin {
  margin-top: 0.5rem;
}

.layer-detail-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.35rem;
}

.layer-select select {
  max-width: 7rem;
}

.layer-opacity-control {
  display: block;
  width: 100%;
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

.add-layer-select {
  width: 100%;
  font-size: 1rem;
  font-family: inherit;
  --vs-min-height: 2rem;
  --vs-padding-y: 0;
  --vs-padding-x: 0.625em;
  --vs-border: 1px solid var(--bulma-border, #dbdbdb);
  --vs-border-radius: 4px;
  --vs-background-color: var(--bulma-scheme-main, #fff);
  --vs-text-color: var(--bulma-text, #363636);
  --vs-outline-color: rgb(66, 88, 255);
  --vs-outline-width: 3px;
  --vs-trailing-icon-color: var(--bulma-link);
}

:deep([data-select-trigger][aria-expanded="true"]),
:deep([data-select-trigger]:focus-visible) {
  box-shadow: rgba(66, 88, 255, 0.25) 0 0 0 3px;
}

:deep([data-select-value]) {
  line-height: 1;
  height: 100%;
}

:deep([data-select-trailing-icon][data-loading="true"] i) {
  display: none;
}

.add-layer-option {
  display: flex;
  align-items: center;
  gap: 0.5em;
  min-width: 0;
}

:global([data-select-popover]) {
  --vs-border: 1px solid var(--bulma-border, #dbdbdb);
  --vs-border-radius: 4px;
  --vs-menu-background-color: var(--bulma-scheme-main, #fff);
  --vs-menu-z-index: 1000;
  --vs-option-hover-background-color: var(--bulma-scheme-main-bis, #fafafa);
  --vs-option-focused-background-color: var(--bulma-scheme-main-ter, #f5f5f5);
  --vs-option-selected-background-color: var(--bulma-info-soft, #eef6fc);
}
</style>
