<script lang="ts" setup>
/**
 * Small line icons for the chart window, drawn on one 16-unit grid with
 * one stroke weight, in the text colour: views (chart, data, rose,
 * hodograph, scatter, T–S) and actions (method, settings, barbs, trend,
 * export).
 */
import type { TPlotIcon } from "./viewTabs.ts";

withDefaults(defineProps<{ name: TPlotIcon; size?: number }>(), {
  size: 12,
});
</script>

<template>
  <svg
    class="plot-icon"
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <template v-if="name === 'chart'">
      <path d="M2 2.5V13.5H14" />
      <path d="M4.5 10.5 7.5 7l2.5 2 4-5" />
    </template>
    <template v-else-if="name === 'data'">
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.5" />
      <path d="M2 6.5h12M2 10h12M6.5 6.5v6.75" />
    </template>
    <template v-else-if="name === 'rose'">
      <circle cx="8" cy="8" r="6" stroke-width="1" opacity="0.45" />
      <path
        d="M8 1.75 9.4 6.6 14.25 8 9.4 9.4 8 14.25 6.6 9.4 1.75 8 6.6 6.6Z"
        fill="currentColor"
        fill-opacity="0.22"
      />
      <path d="M8 1.75v3" />
    </template>
    <template v-else-if="name === 'hodograph'">
      <!-- Polar axes, and the curve through the wind's tips level by
           level, winding out from calm at the centre. -->
      <circle cx="8" cy="8" r="6.5" stroke-width="1" opacity="0.4" />
      <path d="M8 1.5V14.5M1.5 8H14.5" stroke-width="1" opacity="0.4" />
      <path
        d="M8 8C8.6 10.4 11.4 11.2 12.6 9.4 13.8 7.6 13 4.4 10.6 3.4 9.2 2.8 7.4 3 5.8 3.8"
      />
      <g fill="currentColor" stroke="none">
        <circle cx="8" cy="8" r="1.2" />
        <circle cx="12.6" cy="9.4" r="1" />
        <circle cx="10.6" cy="3.4" r="1" />
        <circle cx="5.8" cy="3.8" r="1.3" />
      </g>
    </template>
    <template v-else-if="name === 'scatter' || name === 'ts'">
      <path d="M2 2.5V13.5H14" opacity="0.55" />
      <g fill="currentColor" stroke="none">
        <circle cx="5.5" cy="10" r="1.1" />
        <circle cx="7.5" cy="7.6" r="1.1" />
        <circle cx="10" cy="8.8" r="1.1" />
        <circle cx="11.2" cy="5" r="1.1" />
        <circle cx="13" cy="6.6" r="1.1" />
      </g>
      <path
        v-if="name === 'ts'"
        d="M4 4.5c3 1 6 4.5 9.5 8"
        opacity="0.5"
        stroke-dasharray="1.5 1.5"
      />
    </template>
    <template v-else-if="name === 'method'">
      <path
        d="M6 1.75h4M6.8 1.75V6.1L3.1 12.4a1.3 1.3 0 0 0 1.1 1.95h7.6a1.3 1.3 0 0 0 1.1-1.95L9.2 6.1V1.75"
      />
      <path d="M4.6 10h6.8" opacity="0.6" />
    </template>
    <template v-else-if="name === 'settings'">
      <path d="M2 4h12M2 8h12M2 12h12" opacity="0.55" />
      <g fill="currentColor" stroke="none">
        <circle cx="5.5" cy="4" r="1.8" />
        <circle cx="10.5" cy="8" r="1.8" />
        <circle cx="7" cy="12" r="1.8" />
      </g>
    </template>
    <template v-else-if="name === 'barbs'">
      <!-- A wind barb: station circle, staff, a full and a half feather. -->
      <circle cx="3" cy="13" r="1.3" />
      <path d="M4 12 12.5 3.5" />
      <path d="M12.5 3.5 14.6 6.4M10.6 5.4l2.1 2.9M8.7 7.3l1 1.5" />
    </template>
    <template v-else-if="name === 'currents'">
      <!-- A current: two arrows on a wave, going where the water goes. -->
      <path d="M2 11c1.5-1.4 3-1.4 4.5 0s3 1.4 4.5 0" />
      <path d="M3 6.5h8.5M9.5 4.3l2.2 2.2-2.2 2.2" />
    </template>
    <template v-else-if="name === 'trend'">
      <path d="M2 12.5l4-4 2.5 2.5L14 5.5" />
      <path d="M10.5 5.5H14V9" />
    </template>
    <template v-else-if="name === 'export'">
      <path d="M8 2v8M5 7.2 8 10l3-2.8M2.75 11.5v1.75h10.5V11.5" />
    </template>
  </svg>
</template>

<style scoped>
.plot-icon {
  flex: 0 0 auto;
  display: inline-block;
  vertical-align: -0.125em;
}
</style>
