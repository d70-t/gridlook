<script lang="ts" setup>
import VueJsonPretty from "vue-json-pretty";
import * as zarr from "zarrita";

defineProps<{
  attrs: zarr.Attributes | null;
  emptyLabel: string;
  title: string;
}>();
</script>

<template>
  <section class="info-section">
    <h4 class="title is-6">{{ title }}</h4>
    <div v-if="attrs && Object.keys(attrs).length > 0" class="info-pre">
      <VueJsonPretty :data="attrs" />
    </div>
    <p v-else class="has-text-grey-light">{{ emptyLabel }}</p>
  </section>
</template>
