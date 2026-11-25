<script lang="ts" setup>
import { computed } from "vue";
import VueJsonPretty from "vue-json-pretty";
import * as zarr from "zarrita";

import type { TVariableSample, TVariableTableRow } from "./types";
import {
  SearchField,
  searchFieldLabels,
  type TVariableHighlight,
} from "./variableSearch";

const props = defineProps<{
  row: TVariableTableRow;
  displayName: string;
  // the parts that matched a search
  highlight?: TVariableHighlight;
  selectedAttributesVariable: string | null;
  selectedVariable: string | null;
  showVisualize: boolean;
  showSample?: boolean;
  // the first values, when requested
  sample?: TVariableSample;
  resolveDimensionVariable: (rowName: string, dim: string) => string | null;
}>();

const emit = defineEmits<{
  toggleAttributes: [varName: string];
  visualize: [varName: string];
  toggleSample: [varName: string];
  goToDimension: [rowName: string, dim: string];
}>();

const compactCount = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumSignificantDigits: 3,
});

// the product of the shape; 1 for a scalar
const valueCount = computed(() => {
  const shape = props.row.shape;
  if (!shape) {
    return null;
  }
  const count = shape.reduce((total, size) => total * size, 1);
  return {
    count,
    title: `${count.toLocaleString()} values (${shape.join(" × ") || "scalar"})`,
  };
});

// hidden while a search shows the matched standard_name highlighted instead
const standardName = computed(() => {
  const value = props.row.attrs?.standard_name;
  return typeof value === "string" &&
    props.highlight?.attribute?.label !==
      searchFieldLabels[SearchField.STANDARD_NAME]
    ? value
    : null;
});

function hasAttributes(attrs: zarr.Attributes | null) {
  return attrs ? Object.keys(attrs).length > 0 : false;
}
</script>

<template>
  <tr
    :data-variable-row="row.name"
    class="variable-row"
    :class="{
      'is-selected-variable': row.name === selectedVariable,
    }"
  >
    <td class="variable-name">
      <code :title="row.name">
        <template v-if="highlight">
          <template v-for="(segment, index) in highlight.name" :key="index">
            <mark v-if="segment.match">{{ segment.text }}</mark>
            <template v-else>{{ segment.text }}</template>
          </template>
        </template>
        <template v-else>{{ displayName }}</template>
      </code>
      <div v-if="standardName" class="has-text-grey">{{ standardName }}</div>
      <div v-if="highlight?.attribute" class="has-text-grey">
        {{ highlight.attribute.label }}:
        <template
          v-for="(segment, index) in highlight.attribute.segments"
          :key="index"
        >
          <mark v-if="segment.match">{{ segment.text }}</mark>
          <template v-else>{{ segment.text }}</template>
        </template>
      </div>
    </td>
    <td class="variable-dimensions">
      <span v-if="row.error" class="has-text-danger" :title="row.error">
        Unavailable
      </span>
      <code v-else
        >(<template v-for="(dim, dimIndex) in row.dimensions" :key="dim"
          ><a
            v-if="resolveDimensionVariable(row.name, dim)"
            href="#"
            class="has-text-link dimension-link"
            @click.prevent="emit('goToDimension', row.name, dim)"
            >{{ dim }}</a
          ><template v-else>{{ dim }}</template
          ><template v-if="dimIndex < row.dimensions.length - 1"
            >,
          </template></template
        >)</code
      >
      <div
        v-if="valueCount && !row.error"
        class="has-text-grey"
        :title="valueCount.title"
      >
        {{ compactCount.format(valueCount.count) }}
        {{ valueCount.count === 1 ? "value" : "values" }}
      </div>
    </td>
    <td>
      <span v-if="row.error || !row.dtype" class="has-text-grey-light">
        -
      </span>
      <code v-else-if="row.dtype">{{ row.dtype }}</code>
    </td>
    <td class="variable-actions has-text-right">
      <button
        class="button is-small"
        :class="
          row.name === selectedAttributesVariable ? 'is-info' : 'is-light'
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
        v-if="showSample"
        class="button is-small ml-1"
        :class="sample ? 'is-info' : 'is-light'"
        :aria-label="'Load sample of ' + row.name"
        :aria-pressed="!!sample"
        :title="'Load sample of ' + row.name"
        type="button"
        :disabled="!!row.error"
        @click="emit('toggleSample', row.name)"
      >
        <span class="icon is-small">
          <i class="fa-solid fa-list-ol"></i>
        </span>
      </button>
      <button
        v-if="showVisualize && !row.hidden"
        class="button is-small ml-1"
        :class="row.name === selectedVariable ? 'is-info' : 'is-light'"
        :aria-label="'Visualize ' + row.name"
        :title="row.visualizeDisabled ?? 'Visualize ' + row.name"
        type="button"
        :disabled="!!row.error || !!row.visualizeDisabled"
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
    :data-variable-details="row.name"
    class="variable-attributes-row"
  >
    <td colspan="4">
      <div class="variable-attributes">
        <div v-if="row.error" class="notification is-danger is-light is-size-7">
          {{ row.error }}
        </div>
        <div v-else-if="hasAttributes(row.attrs)" class="info-pre">
          <VueJsonPretty :data="row.attrs" />
        </div>
        <p v-else class="has-text-grey-light">No variable attributes</p>
      </div>
    </td>
  </tr>
  <tr
    v-if="sample"
    :data-variable-sample="row.name"
    class="variable-attributes-row"
  >
    <td colspan="4">
      <div class="variable-attributes is-size-7">
        <p v-if="sample.error" class="has-text-danger">{{ sample.error }}</p>
        <p v-else-if="!sample.values" class="has-text-grey">Loading sample…</p>
        <p v-else-if="sample.values.length === 0" class="has-text-grey-light">
          No values
        </p>
        <template v-else>
          <p class="has-text-grey mb-1">
            First {{ sample.values.length }} stored values
            <template v-if="row.dimensions.length > 1">
              along <code>{{ row.dimensions.at(-1) }}</code> (index 0 of the
              other dimensions)
            </template>
          </p>
          <div class="tags">
            <span
              v-for="(value, index) in sample.values"
              :key="index"
              class="tag is-info is-light is-family-monospace"
              >{{ value }}</span
            >
          </div>
        </template>
      </div>
    </td>
  </tr>
</template>

<style lang="scss" scoped>
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

  mark {
    background: color-mix(in srgb, var(--bulma-warning) 45%, transparent);
    color: inherit;
  }
}

.variable-dimensions {
  min-width: 7rem;

  code {
    white-space: normal;
    word-break: break-word;
  }

  .dimension-link:hover {
    text-decoration: underline;
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
