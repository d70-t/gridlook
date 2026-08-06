<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed } from "vue";

import {
  GRID_TYPE_DISPLAY_OVERRIDES,
  type T_GRID_TYPES,
} from "@/lib/data/gridTypeDetector.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";

const props = defineProps<{
  gridType?: T_GRID_TYPES;
}>();

const emit = defineEmits<{
  selectGridType: [gridType: T_GRID_TYPES];
}>();

const paramStore = useUrlParameterStore();
const { paramGridType } = storeToRefs(paramStore);

const activeGridType = computed(() => {
  if (!props.gridType) {
    return undefined;
  }
  return paramGridType.value || props.gridType;
});

const availableGridTypes = computed(() => {
  if (!props.gridType) {
    return [];
  }
  const overrides = GRID_TYPE_DISPLAY_OVERRIDES[props.gridType];
  if (!overrides || overrides.length === 0) {
    return [props.gridType];
  }
  return [props.gridType, ...overrides];
});
</script>

<template>
  <section class="info-section">
    <h4
      class="title is-6 is-flex is-justify-content-space-between is-align-items-center"
    >
      <span class="is-flex is-align-items-center gap-2"> Grid Type </span>
      <div v-if="availableGridTypes.length > 1" class="select is-small">
        <select
          :value="activeGridType"
          class="grid-type-select"
          @change="
            emit(
              'selectGridType',
              ($event.target as HTMLSelectElement).value as T_GRID_TYPES
            )
          "
        >
          <option
            v-for="typeOption in availableGridTypes"
            :key="typeOption"
            :value="typeOption"
          >
            {{ typeOption }}
          </option>
        </select>
      </div>
      <button
        v-else
        type="button"
        class="button is-small is-light grid-type-button"
        disabled
      >
        {{ activeGridType ?? "Unknown" }}
      </button>
    </h4>
  </section>
</template>

<style lang="scss" scoped>
.grid-type-select {
  background-color: var(--bulma-light);
  color: var(--bulma-code);
  font-family: var(--bulma-family-code);
  border: 1px solid var(--bulma-border);
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    border-color: var(--bulma-link);
  }
}

.grid-type-button {
  color: var(--bulma-code);
  font-family: var(--bulma-family-code);
  cursor: not-allowed;
}
</style>
