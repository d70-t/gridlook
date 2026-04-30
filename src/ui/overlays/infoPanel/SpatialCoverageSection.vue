<script lang="ts" setup>
import { computed } from "vue";

import type { TCoordinateSlice, TInfoDimension } from "./types.ts";

const props = defineProps<{
  latSlice: TCoordinateSlice | null;
  latDimensions: TInfoDimension[];
  latLength: number | null;
  latMin: number | null;
  latMax: number | null;
  lonSlice: TCoordinateSlice | null;
  lonDimensions: TInfoDimension[];
  lonLength: number | null;
  lonMin: number | null;
  lonMax: number | null;
}>();

const hasLatLon = computed(
  () => props.latSlice !== null || props.lonSlice !== null
);

function formatValue(value: unknown): string {
  if (typeof value === "number") {
    return value.toFixed(6);
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}
</script>

<template>
  <div>
    <section v-if="hasLatLon" class="info-section">
      <h4 class="title is-6">Spatial Coverage</h4>

      <div v-if="latSlice" class="mb-4">
        <p class="is-size-7 has-text-weight-semibold mb-2">
          Latitude
          <span class="has-text-grey-light has-text-weight-normal"
            >({{ latLength?.toLocaleString() }} values)</span
          >
        </p>
        <div class="mb-2">
          <code> min {{ formatValue(latMin ?? 0) }} </code>
          →
          <code> max {{ formatValue(latMax ?? 0) }} </code>
        </div>
        <div v-if="latDimensions && latDimensions.length > 0" class="content">
          <table class="table is-narrow is-fullwidth is-size-7">
            <thead>
              <tr>
                <th>Dimension</th>
                <th>Shape</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="dim in latDimensions" :key="dim.name">
                <td>
                  <code>{{ dim.name }}</code>
                </td>
                <td>{{ dim.size.toLocaleString() }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <details class="is-size-7">
          <summary class="has-text-grey coord-details-summary">
            Raw sample values
          </summary>
          <p class="has-text-weight-semibold mt-2 mb-1">First 10:</p>
          <div class="tags">
            <span
              v-for="(val, i) in latSlice.first10"
              :key="'lat-f-' + i"
              class="tag is-info is-light is-family-monospace"
              >{{ formatValue(val) }}</span
            >
          </div>
          <p class="has-text-weight-semibold mt-2 mb-1">Last 10:</p>
          <div class="tags">
            <span
              v-for="(val, i) in latSlice.last10"
              :key="'lat-l-' + i"
              class="tag is-info is-light is-family-monospace"
              >{{ formatValue(val) }}</span
            >
          </div>
        </details>
      </div>

      <div v-if="lonSlice">
        <p class="is-size-7 has-text-weight-semibold mb-2">
          Longitude
          <span class="has-text-grey-light has-text-weight-normal"
            >({{ lonLength?.toLocaleString() }} values)</span
          >
        </p>
        <div class="mb-2">
          <code> min {{ formatValue(lonMin ?? 0) }} </code>
          →
          <code> max {{ formatValue(lonMax ?? 0) }} </code>
        </div>
        <div v-if="lonDimensions && lonDimensions.length > 0" class="content">
          <table class="table is-narrow is-fullwidth is-size-7">
            <thead>
              <tr>
                <th>Dimension</th>
                <th>Shape</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="dim in lonDimensions" :key="dim.name">
                <td>
                  <code>{{ dim.name }}</code>
                </td>
                <td>{{ dim.size.toLocaleString() }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <details class="is-size-7">
          <summary class="has-text-grey coord-details-summary">
            Raw sample values
          </summary>
          <p class="has-text-weight-semibold mt-2 mb-1">First 10:</p>
          <div class="tags">
            <span
              v-for="(val, i) in lonSlice.first10"
              :key="'lon-f-' + i"
              class="tag is-warning is-light is-family-monospace"
              >{{ formatValue(val) }}</span
            >
          </div>
          <p class="has-text-weight-semibold mt-2 mb-1">Last 10:</p>
          <div class="tags">
            <span
              v-for="(val, i) in lonSlice.last10"
              :key="'lon-l-' + i"
              class="tag is-warning is-light is-family-monospace"
              >{{ formatValue(val) }}</span
            >
          </div>
        </details>
      </div>
    </section>

    <div v-if="!hasLatLon" class="info-section">
      <div class="notification is-info is-light is-size-7">
        <strong>Note:</strong> No lat/lon coordinates found for this grid type.
      </div>
    </div>
  </div>
</template>
