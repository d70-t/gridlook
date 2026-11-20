<script lang="ts" setup>
import { computed } from "vue";

import ChunksSection from "./ChunksSection.vue";
import type { TChunkLevel, TInfoDimension } from "./types.ts";

import {
  formatBytes,
  getDtypeBytes,
  type TIndexRange,
} from "@/lib/data/chunkLayout.ts";
import { ZARR_FORMAT, type TDimensionRange } from "@/lib/types/GlobeTypes.ts";

const props = defineProps<{
  dimensions: TInfoDimension[];
  variableDtype: string | null;
  variableChunks: readonly (number | null)[] | null;
  variableShardShape: readonly number[] | null;
  variableMissingValue: number | null;
  variableFillValue: number | null;
  zarrFormat: number | null;
  dimRanges: TDimensionRange[] | null;
  spatialRanges: (TIndexRange[] | null)[] | null;
  level: TChunkLevel | null;
  dimIndices: readonly (number | null)[];
}>();

const estimatedSizeMB = computed(() => {
  if (!props.dimensions.length || !props.variableDtype) {
    return null;
  }
  const totalElements = props.dimensions.reduce((acc, d) => acc * d.size, 1);
  const bytes = totalElements * getDtypeBytes(props.variableDtype);
  if (!Number.isFinite(bytes)) {
    return null;
  }
  return formatBytes(bytes);
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
              <td><strong>Data format</strong></td>
              <td>
                {{
                  zarrFormat === ZARR_FORMAT.NETCDF
                    ? "NetCDF"
                    : zarrFormat === ZARR_FORMAT.ICECHUNK
                      ? "Zarr 3 (icechunk)"
                      : `Zarr ${zarrFormat}`
                }}
              </td>
            </tr>

            <tr>
              <td><strong>Data type</strong></td>
              <td>
                <code>{{ variableDtype }}</code>
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
      <ChunksSection
        v-if="variableChunks && variableChunks.length === dimensions.length"
        :dimensions="dimensions"
        :chunks="variableChunks"
        :shard-shape="variableShardShape"
        :dtype="variableDtype"
        :dim-ranges="dimRanges"
        :spatial-ranges="spatialRanges"
        :level="level"
        :dim-indices="dimIndices"
      />
    </section>
  </div>
</template>
