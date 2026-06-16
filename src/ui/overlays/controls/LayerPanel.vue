<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { onMounted, ref } from "vue";

import { LAND_SEA_MASK_MODES } from "@/lib/layers/landSeaMask.ts";
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
} from "@/store/store.ts";
import { useLog } from "@/utils/logging.ts";

const store = useGlobeControlStore();
const { layerStack } = storeToRefs(store);
const { logError } = useLog();

const fileInput = ref<HTMLInputElement>();
const draggedId = ref<string | undefined>(undefined);
const dropTargetIndex = ref<number | undefined>(undefined);

const LAYER_ICONS: Record<string, string> = {
  [LAYER_KINDS.GRID]: "fa-border-all",
  [LAYER_KINDS.MASK]: "fa-mask",
  [LAYER_KINDS.TEXTURE]: "fa-image",
};

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
</script>

<template>
  <div class="column">
    <ul class="layer-stack mb-2">
      <li
        v-for="(layer, index) in layerStack"
        :key="layer.id"
        class="layer-entry"
        :class="{
          'is-drop-target': dropTargetIndex === index,
          'is-dragging': draggedId === layer.id,
        }"
        draggable="true"
        @dragstart="onDragStart($event, layer)"
        @dragover="onDragOver($event, index)"
        @drop="onDrop(index)"
        @dragend="endDrag"
      >
        <span class="icon is-small layer-grip">
          <i class="fa-solid fa-grip-vertical"></i>
        </span>
        <span class="icon is-small">
          <i class="fa-solid" :class="LAYER_ICONS[layer.kind]"></i>
        </span>
        <span class="layer-name" :title="layer.name">{{ layer.name }}</span>
        <template v-if="layer.kind === LAYER_KINDS.TEXTURE">
          <button
            class="button is-small is-light"
            :class="{ 'is-info': layer.visible }"
            type="button"
            :title="layer.visible ? 'Hide layer' : 'Show layer'"
            @click="
              store.updateTextureLayer(layer.id, { visible: !layer.visible })
            "
          >
            <span class="icon is-small">
              <i
                class="fa-solid"
                :class="layer.visible ? 'fa-eye' : 'fa-eye-slash'"
              ></i>
            </span>
          </button>
          <div class="select is-small">
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
        <span>Grid as texture</span>
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

  &.is-drop-target {
    outline: 2px solid var(--bulma-link);
  }
}

.layer-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
