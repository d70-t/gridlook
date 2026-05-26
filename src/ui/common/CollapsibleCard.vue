<script lang="ts" setup>
import { onUnmounted, ref } from "vue";

const props = withDefaults(
  defineProps<{
    title?: string;
  }>(),
  {
    title: "",
  }
);

const isCollapsed = ref(false);
onUnmounted(() => {
  console.log("UNMOUnT");
});
</script>

<template>
  <div class="box m-2 p-2">
    <div
      class="is-flex is-align-items-center is-justify-content-space-between"
      :class="isCollapsed ? '' : 'mb-2'"
    >
      <div class="section-title">{{ props.title }}</div>
      <button
        class="button borderless-btn"
        type="button"
        :aria-expanded="!isCollapsed"
        :aria-label="
          isCollapsed ? `Expand ${props.title}` : `Collapse ${props.title}`
        "
        @click="isCollapsed = !isCollapsed"
      >
        <span class="icon">
          <i
            class="fa-solid"
            :class="isCollapsed ? 'fa-angle-down' : 'fa-angle-up'"
            aria-hidden="true"
          ></i>
        </span>
      </button>
    </div>
    <div
      class="collapsible-card-content"
      :class="{ 'is-collapsed': isCollapsed }"
      :inert="isCollapsed"
    >
      <div class="is-clipped">
        <slot />
      </div>
    </div>
  </div>
</template>

<style lang="scss">
.collapsible-card-content {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.2s ease;
}

.collapsible-card-content.is-collapsed {
  grid-template-rows: 0fr;
}
</style>
