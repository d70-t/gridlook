<script setup>
import GlobeView from "./GlobeView.vue";
</script>

<script>
export default {
  data() {
    return {
      default_src: "static/index_mr_dpp0066.json",
      src: "static/index_mr_dpp0066.json",
    };
  },
  mounted() {
    window.addEventListener("hashchange", this.onHashChange);
    this.onHashChange();
  },
  methods: {
    onHashChange() {
      if (location.hash.length > 1) {
        this.src = location.hash.slice(1, location.hash.length);
      } else {
        this.src = this.default_src;
      }
    },
  },
};
</script>

<template>
  <GlobeView :src="src" />
</template>
