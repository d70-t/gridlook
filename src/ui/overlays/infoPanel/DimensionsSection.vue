<script lang="ts" setup>
import type { TInfoDimension } from "./types.ts";

defineProps<{
  dimensions: TInfoDimension[];
}>();
</script>

<template>
  <section class="info-section">
    <h4 class="title is-6">Dimensions</h4>
    <div v-if="dimensions.length > 0" class="content">
      <table class="table is-narrow is-fullwidth is-size-7">
        <thead>
          <tr>
            <th>Name</th>
            <th>Shape</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="dim in dimensions" :key="dim.name">
            <td>
              <code>{{ dim.name }}</code>
            </td>
            <td>{{ dim.size.toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="has-text-grey-light">No dimension info available</p>
  </section>
</template>
