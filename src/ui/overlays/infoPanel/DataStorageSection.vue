<script lang="ts" setup>
import { computed } from "vue";

import type { TInfoDimension } from "./types.ts";

const props = defineProps<{
  dimensions: TInfoDimension[];
  variableDtype: string | null;
  variableChunks: readonly (number | null)[] | null;
  variableMissingValue: number | null;
  variableFillValue: number | null;
  zarrFormat: number | null;
}>();

function getDtypeBytes(dtype: string): number {
  if (dtype.includes("64")) {
    return 8;
  }
  if (dtype.includes("32")) {
    return 4;
  }
  if (dtype.includes("16")) {
    return 2;
  }
  if (dtype.includes("8")) {
    return 1;
  }
  return 4;
}

const estimatedSizeMB = computed(() => {
  if (!props.dimensions.length || !props.variableDtype) {
    return null;
  }
  const totalElements = props.dimensions.reduce((acc, d) => acc * d.size, 1);
  const bytes = totalElements * getDtypeBytes(props.variableDtype);
  if (!Number.isFinite(bytes)) {
    return null;
  }
  if (bytes >= 1024 * 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2) + " TB";
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }
  return (bytes / 1024).toFixed(2) + " KB";
});
</script>

<template>
  <div>
    <section v-if="variableDtype" class="info-section">
      <h4 class="title is-6">Data Type &amp; Storage</h4>
      <div class="content">
        <table class="table is-narrow is-fullwidth is-size-7">
          <tbody>
            <tr v-if="zarrFormat">
              <td><strong>Zarr format version</strong></td>
              <td>{{ zarrFormat }}</td>
            </tr>

            <tr>
              <td><strong>Data type</strong></td>
              <td>
                <code>{{ variableDtype }}</code>
              </td>
            </tr>
            <tr v-if="variableChunks && variableChunks.length > 0">
              <td><strong>Chunk shape</strong></td>
              <td>
                <code>{{ variableChunks.join(" × ") }}</code>
              </td>
            </tr>
            <tr v-if="variableMissingValue !== null">
              <td><strong>Missing value</strong></td>
              <td>
                <code>{{ variableMissingValue }}</code>
              </td>
            </tr>
            <tr v-if="variableFillValue !== null">
              <td><strong>Fill value</strong></td>
              <td>
                <code>{{ variableFillValue }}</code>
              </td>
            </tr>
            <tr v-if="estimatedSizeMB">
              <td>
                <strong>Estimated size</strong>
                <span class="ml-1 has-text-grey is-size-7">(uncompressed)</span>
              </td>
              <td>{{ estimatedSizeMB }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
