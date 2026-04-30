<script lang="ts" setup>
import VueJsonPretty from "vue-json-pretty";
import * as zarr from "zarrita";

type TVariableTableRow = {
  name: string;
  dimensions: string[];
  dtype: string | null;
  attrs: zarr.Attributes | null;
  loading: boolean;
  error: string | null;
};

withDefaults(
  defineProps<{
    title: string;
    rows: TVariableTableRow[];
    emptyLabel: string;
    selectedAttributesVariable: string | null;
    selectedVariable?: string | null;
    showVisualize?: boolean;
  }>(),
  {
    selectedVariable: null,
    showVisualize: false,
  }
);

const emit = defineEmits<{
  toggleAttributes: [varName: string];
  visualize: [varName: string];
}>();

function formatDimensions(dimensions: string[]) {
  return `(${dimensions.join(", ")})`;
}

function hasAttributes(attrs: zarr.Attributes | null) {
  return attrs ? Object.keys(attrs).length > 0 : false;
}
</script>

<template>
  <div class="dataset-table-section">
    <p class="is-size-7 has-text-weight-bold mb-1">
      {{ title }}
      <span class="has-text-grey-light">({{ rows.length }})</span>
    </p>

    <div v-if="rows.length > 0" class="table-container">
      <table class="table is-narrow is-fullwidth is-size-7 dataset-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Dimensions</th>
            <th>dtype</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in rows" :key="row.name">
            <tr
              class="variable-row"
              :class="{
                'is-selected-variable': row.name === selectedVariable,
              }"
            >
              <td class="variable-name">
                <code>{{ row.name }}</code>
              </td>
              <td class="variable-dimensions">
                <code>{{ formatDimensions(row.dimensions) }}</code>
              </td>
              <td>
                <span v-if="row.loading" class="has-text-grey-light">
                  Loading
                </span>
                <span
                  v-else-if="row.error"
                  class="has-text-danger"
                  :title="row.error"
                >
                  Unavailable
                </span>
                <code v-else-if="row.dtype">{{ row.dtype }}</code>
                <span v-else class="has-text-grey-light">-</span>
              </td>
              <td class="variable-actions has-text-right">
                <button
                  class="button is-small"
                  :class="
                    row.name === selectedAttributesVariable
                      ? 'is-info'
                      : 'is-light'
                  "
                  :aria-label="'View attributes for ' + row.name"
                  :aria-pressed="row.name === selectedAttributesVariable"
                  :title="'View attributes for ' + row.name"
                  type="button"
                  @click="emit('toggleAttributes', row.name)"
                >
                  <span class="icon is-small">
                    <i class="fa-solid fa-circle-info"></i>
                  </span>
                </button>
                <button
                  v-if="showVisualize"
                  class="button is-small ml-1"
                  :class="
                    row.name === selectedVariable ? 'is-info' : 'is-light'
                  "
                  :aria-label="'Visualize ' + row.name"
                  :title="'Visualize ' + row.name"
                  type="button"
                  @click="emit('visualize', row.name)"
                >
                  <span class="icon is-small">
                    <i class="fa-solid fa-globe"></i>
                  </span>
                </button>
              </td>
            </tr>
            <tr
              v-if="row.name === selectedAttributesVariable"
              class="variable-attributes-row"
            >
              <td colspan="4">
                <div class="variable-attributes">
                  <p v-if="row.loading" class="has-text-grey-light">
                    Loading metadata...
                  </p>
                  <div
                    v-else-if="row.error"
                    class="notification is-danger is-light is-size-7"
                  >
                    {{ row.error }}
                  </div>
                  <div v-else-if="hasAttributes(row.attrs)" class="info-pre">
                    <VueJsonPretty :data="row.attrs" />
                  </div>
                  <p v-else class="has-text-grey-light">
                    No variable attributes
                  </p>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <p v-else class="has-text-grey-light is-size-7">{{ emptyLabel }}</p>
  </div>
</template>

<style lang="scss" scoped>
.dataset-table-section {
  margin-top: 0.75rem;
}

.dataset-table {
  th,
  td {
    vertical-align: middle;
  }

  th {
    white-space: nowrap;
  }
}

.variable-row.is-selected-variable {
  background: color-mix(in srgb, var(--bulma-info) 14%, transparent);

  .variable-name code {
    background: color-mix(in srgb, var(--bulma-info) 20%, transparent);
    color: var(--bulma-info-dark);
    font-weight: 700;
  }
}

.variable-name {
  word-break: break-word;
}

.variable-dimensions {
  min-width: 7rem;

  code {
    white-space: normal;
  }
}

.variable-actions {
  white-space: nowrap;
  width: 1%;

  .button {
    height: 1.65rem;
    width: 1.65rem;
    padding-left: 0;
    padding-right: 0;
  }
}

.variable-attributes-row {
  td {
    border-top: 0;
    padding-top: 0;
  }
}

.variable-attributes {
  border-left: 3px solid var(--bulma-info);
  padding: 0.5rem 0.5rem 0.5rem 0.75rem;
  background: color-mix(in srgb, var(--bulma-info) 6%, transparent);
}
</style>
