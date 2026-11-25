<script lang="ts" setup>
import type { TVariableGroupInfo } from "./types";

defineProps<{
  name: string;
  count: number;
  open: boolean;
  info?: TVariableGroupInfo;
}>();

const emit = defineEmits<{
  toggle: [];
}>();
</script>

<template>
  <button
    type="button"
    class="button is-light is-fullwidth is-justify-content-space-between variable-group-toggle"
    :aria-expanded="open"
    @click="emit('toggle')"
  >
    <span class="is-flex is-align-items-center">
      <span class="icon is-small mr-2" aria-hidden="true">
        <i
          class="fa-solid"
          :class="open ? 'fa-angle-down' : 'fa-angle-right'"
        ></i>
      </span>
      <span class="group-name">{{ name }}</span>
      <span v-if="info?.detail" class="group-detail has-text-grey ml-2">
        {{ info.detail }}
      </span>
    </span>
    <span class="is-flex is-align-items-center is-flex-shrink-0">
      <span v-if="info?.current" class="tag is-info is-light ml-2">
        current level
      </span>
      <span class="tag is-rounded ml-2">{{ count }}</span>
    </span>
  </button>
</template>

<style lang="scss" scoped>
.variable-group-toggle {
  height: auto;
  padding: 0.75rem;
  text-align: left;

  .group-name {
    white-space: normal;
    word-break: break-word;
  }

  .group-detail {
    white-space: normal;
    font-weight: normal;
    font-size: 0.8em;
  }
}
</style>
