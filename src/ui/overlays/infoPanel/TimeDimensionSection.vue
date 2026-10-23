<script lang="ts" setup>
import type { TTimeInfo } from "./types.ts";

withDefaults(
  defineProps<{
    timeInfo: TTimeInfo | null;
    noTimeCoordinate?: boolean;
  }>(),
  { noTimeCoordinate: false }
);
</script>

<template>
  <div>
    <section v-if="timeInfo" class="info-section">
      <h4 class="title is-6">Time Dimension</h4>
      <div class="content">
        <table class="table is-narrow is-fullwidth is-size-7">
          <tbody>
            <tr>
              <td><strong>Units</strong></td>
              <td>
                <code>{{ timeInfo.units }}</code>
              </td>
            </tr>
            <tr>
              <td><strong>Calendar</strong></td>
              <td>
                <code>{{ timeInfo.calendar }}</code>
              </td>
            </tr>
            <tr>
              <td><strong>Timesteps</strong></td>
              <td>{{ timeInfo.numTimesteps.toLocaleString() }}</td>
            </tr>
            <tr v-if="timeInfo.timestep">
              <td>
                <strong>Initial interval</strong>
                <span class="ml-1 has-text-grey is-size-7">(1st→2nd)</span>
              </td>
              <td>{{ timeInfo.timestep }}</td>
            </tr>
            <tr>
              <td><strong>First timestamp</strong></td>
              <td>
                <code>{{ timeInfo.firstTimestamp }}</code>
              </td>
            </tr>
            <tr>
              <td><strong>Last timestamp</strong></td>
              <td>
                <code>{{ timeInfo.lastTimestamp }}</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section v-else-if="noTimeCoordinate" class="info-section">
      <h4 class="title is-6">Time Dimension</h4>
      <p class="has-text-grey-light">
        No time coordinate variable is available for the current variable.
      </p>
    </section>
  </div>
</template>
