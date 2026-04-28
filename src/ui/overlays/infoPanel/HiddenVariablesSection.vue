<script lang="ts" setup>
import { computed, ref, watch } from "vue";
import VueJsonPretty from "vue-json-pretty";
import * as zarr from "zarrita";

import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useLog } from "@/utils/logging.ts";

const props = defineProps<{
  datasources?: TSources;
  metadataResetKey: number;
}>();

const { logError } = useLog();

const metadataVariableName = ref<string | null>(null);
const metadataVariableAttrs = ref<zarr.Attributes | null>(null);
const metadataVariableDimensions = ref<{ name: string; size: number }[]>([]);
const metadataVariableDtype = ref<string | null>(null);
const metadataVariableChunks = ref<readonly (number | null)[] | null>(null);
const metadataVariableError = ref<string | null>(null);
const metadataVariableLoading = ref(false);

const hiddenVariables = computed(() => {
  if (!props.datasources) {
    return [];
  }
  return Object.entries(props.datasources.levels[0].datasources)
    .filter(([, source]) => source.hidden ?? false)
    .map(([name]) => ({ name }));
});

function clearMetadataVariable() {
  metadataVariableName.value = null;
  metadataVariableAttrs.value = null;
  metadataVariableDimensions.value = [];
  metadataVariableDtype.value = null;
  metadataVariableChunks.value = null;
  metadataVariableError.value = null;
  metadataVariableLoading.value = false;
}

function toggleVariableMetadata(varName: string) {
  if (metadataVariableName.value === varName) {
    clearMetadataVariable();
    return;
  }
  showVariableMetadata(varName);
}

async function showVariableMetadata(varName: string) {
  if (!props.datasources) {
    return;
  }

  metadataVariableName.value = varName;
  metadataVariableAttrs.value = null;
  metadataVariableDimensions.value = [];
  metadataVariableDtype.value = null;
  metadataVariableChunks.value = null;
  metadataVariableError.value = null;
  metadataVariableLoading.value = true;

  try {
    const varSource = props.datasources.levels[0].datasources[varName];
    const variable = await ZarrDataManager.getVariableInfo(varSource, varName);
    if (metadataVariableName.value !== varName) {
      return;
    }
    metadataVariableAttrs.value = variable.attrs;
    metadataVariableDtype.value = String(variable.dtype);
    metadataVariableChunks.value = variable.chunks;
    const dimensionNames = Array.isArray(variable.dimensionNames)
      ? variable.dimensionNames
      : [];
    metadataVariableDimensions.value = variable.shape.map((size, idx) => ({
      name: dimensionNames[idx] ?? `dim_${idx}`,
      size,
    }));
  } catch (err) {
    logError(err);
    if (metadataVariableName.value === varName) {
      metadataVariableError.value = `Could not load metadata for ${varName}`;
    }
  } finally {
    if (metadataVariableName.value === varName) {
      metadataVariableLoading.value = false;
    }
  }
}

watch(() => [props.datasources, props.metadataResetKey], clearMetadataVariable);
</script>

<template>
  <div>
    <div v-if="hiddenVariables.length > 0" class="mt-2">
      <p class="is-size-7 has-text-grey mb-1">
        Dimensions &amp; coordinates
        <span class="has-text-grey-light">({{ hiddenVariables.length }})</span>
      </p>
      <div class="tags dimension-metadata-tags">
        <button
          v-for="v in hiddenVariables"
          :key="v.name"
          class="tag is-family-monospace dimension-metadata-tag"
          :class="
            v.name === metadataVariableName
              ? 'is-info'
              : 'is-light has-text-grey'
          "
          :title="
            v.name === metadataVariableName
              ? 'Hide metadata for ' + v.name
              : 'Show metadata for ' + v.name
          "
          type="button"
          @click="toggleVariableMetadata(v.name)"
        >
          <span>{{ v.name }}</span>
          <span class="icon is-small ml-1">
            <i class="fa-solid fa-circle-info"></i>
          </span>
        </button>
      </div>

      <div v-if="metadataVariableName" class="card">
        <header class="card-header">
          <span class="card-header-title is-justify-content-space-between">
            <span class="title is-6 m-0">
              Metadata for <code>{{ metadataVariableName }}</code>
            </span>
            <button
              type="button"
              class="delete is-small"
              aria-label="close metadata"
              @click="clearMetadataVariable"
            ></button>
          </span>
        </header>
        <div class="card-content">
          <p v-if="metadataVariableLoading" class="has-text-grey-light">
            Loading metadata...
          </p>
          <div
            v-else-if="metadataVariableError"
            class="notification is-danger is-light is-size-7"
          >
            {{ metadataVariableError }}
          </div>
          <template v-else>
            <table class="table is-narrow is-fullwidth is-size-7">
              <tbody>
                <tr v-if="metadataVariableDtype">
                  <td><strong>Data type</strong></td>
                  <td>
                    <code>{{ metadataVariableDtype }}</code>
                  </td>
                </tr>
                <tr
                  v-if="
                    metadataVariableChunks && metadataVariableChunks.length > 0
                  "
                >
                  <td><strong>Chunk shape</strong></td>
                  <td>
                    <code>{{ metadataVariableChunks.join(" × ") }}</code>
                  </td>
                </tr>
              </tbody>
            </table>

            <div v-if="metadataVariableDimensions.length > 0">
              <table class="table is-narrow is-fullwidth is-size-7">
                <thead>
                  <tr>
                    <th>Dimension</th>
                    <th>Shape</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="dim in metadataVariableDimensions" :key="dim.name">
                    <td>
                      <code>{{ dim.name }}</code>
                    </td>
                    <td>{{ dim.size.toLocaleString() }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p class="is-size-7 has-text-weight-semibold mt-3">Attributes</p>
            <div
              v-if="
                metadataVariableAttrs &&
                Object.keys(metadataVariableAttrs).length > 0
              "
              class="info-pre"
            >
              <VueJsonPretty :data="metadataVariableAttrs" />
            </div>
            <p v-else class="has-text-grey-light">No variable attributes</p>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
