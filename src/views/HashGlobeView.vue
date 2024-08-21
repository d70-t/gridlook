<script setup>
import { ref, onMounted } from "vue";
import GlobeView from "./GlobeView.vue";
const defaultSrc = ref("static/index_mr_dpp0066.json");
const src = ref("static/index_mr_dpp0066.json");

onMounted(() => {
  window.addEventListener("hashchange", onHashChange);
  onHashChange();
});

const onHashChange = () => {
  if (location.hash.length > 1) {
    src.value = location.hash.slice(1, location.hash.length);
  } else {
    src.value = defaultSrc.value;
  }
};
</script>

<template>
  <GlobeView :src="src" />
</template>
