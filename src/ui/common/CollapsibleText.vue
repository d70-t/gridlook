<script setup lang="ts">
import { ref, onMounted, onUpdated, nextTick } from "vue";

interface Props {
  text: string;
}

defineProps<Props>();

const isExpanded = ref(false);
const isClamped = ref(false);
const textRef = ref<HTMLElement | null>(null);

function checkClamping() {
  nextTick(() => {
    if (textRef.value && !isExpanded.value) {
      isClamped.value = textRef.value.scrollHeight > textRef.value.clientHeight;
    }
  });
}

onMounted(checkClamping);
onUpdated(checkClamping);
</script>

<template>
  <div>
    <div ref="textRef" :class="{ 'line-clamp': !isExpanded }">
      {{ text }}
    </div>
    <button
      v-if="isClamped || isExpanded"
      class="toggle-btn"
      type="button"
      @click="isExpanded = !isExpanded"
    >
      {{ isExpanded ? "Show less" : "Show more" }}
    </button>
  </div>
</template>

<style scoped>
.line-clamp {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
}

.toggle-btn {
  text-decoration: underline;
}

.toggle-btn:hover {
  background: #c4c4c4;
}
</style>
