<script lang="ts" setup>
import { computed } from "vue";

import { buildChunkDiagram } from "./chunkDiagram.ts";
import type { TInfoDimension } from "./types.ts";

import {
  computeChunkLayout,
  formatBytes,
  getDtypeBytes,
} from "@/lib/data/chunkLayout.ts";
import type { TDimensionRange } from "@/lib/types/GlobeTypes.ts";
import PopupDialog from "@/ui/overlays/controls/PopupDialog.vue";

const props = defineProps<{
  dimensions: TInfoDimension[];
  chunks: readonly (number | null)[];
  shardShape: readonly number[] | null;
  dtype: string;
  dimRanges: TDimensionRange[] | null;
  dimIndices: readonly (number | null)[];
}>();

// ponytail: fixed threshold for "much more than shown"; 4x catches the common
// case of several time steps per chunk while tolerating partial edge chunks.
const OVERHEAD_WARNING = 4;
const LARGE_STEP_BYTES = 1024 * 1024 * 1024;

/**
 * Spatial dimensions are the ones gridlook loads completely (a `null` range).
 * The ranges belong to the variable on the globe, so they are only used once
 * they match the variable shown in the info panel.
 */
const spatial = computed(() => {
  const ranges = props.dimRanges;
  if (
    !ranges ||
    ranges.length !== props.dimensions.length ||
    ranges.some((r, i) => r?.name && r.name !== props.dimensions[i].name)
  ) {
    return null;
  }
  return ranges.map((r) => r === null);
});

const layout = computed(() =>
  computeChunkLayout(
    props.dimensions.map((dim, i) => ({
      ...dim,
      isSpatial: spatial.value?.[i] ?? false,
    })),
    props.chunks,
    getDtypeBytes(props.dtype)
  )
);

const diagram = computed(() =>
  buildChunkDiagram(layout.value.dimensions, props.dimIndices)
);

const overhead = computed(
  () => layout.value.stepBytes / layout.value.shownBytes
);

// Rounded up so the loaded amount is never understated.
const overheadLabel = computed(() =>
  Number.isInteger(overhead.value)
    ? `${overhead.value}×`
    : `~${Math.ceil(overhead.value)}×`
);

const isLargeStep = computed(() => layout.value.stepBytes > LARGE_STEP_BYTES);

const overheadDims = computed(() =>
  layout.value.dimensions
    .filter((d) => !d.isSpatial && d.chunkSize > 1)
    .map((d) => d.name)
);
</script>

<template>
  <section class="info-section">
    <h4 class="title is-6">Chunks and Dimensions</h4>
    <div
      class="is-flex is-flex-wrap-wrap is-align-items-flex-end is-justify-content-center chunk-blocks"
    >
      <svg
        v-for="(block, i) in diagram"
        :key="i"
        :width="block.width"
        :height="block.height"
        :viewBox="`0 0 ${block.width} ${block.height}`"
        class="chunk-diagram"
        role="img"
        aria-label="Chunk layout"
      >
        <polygon
          v-for="(face, j) in block.faces"
          :key="`face-${j}`"
          :points="face"
          class="chunk-face"
          :class="{ 'is-dense': block.dense }"
        />
        <template v-if="spatial">
          <polygon
            v-for="(face, j) in block.slab"
            :key="`slab-${j}`"
            :points="face"
            class="chunk-slab"
          />
        </template>
        <path :d="block.lines" class="chunk-lines" />
        <text
          v-for="label in block.labels"
          :key="label.text"
          :x="label.x"
          :y="label.y"
          :transform="`rotate(${label.angle} ${label.x} ${label.y})`"
          text-anchor="middle"
        >
          {{ label.text }}
        </text>
      </svg>
    </div>
    <p v-if="spatial" class="is-size-7 has-text-grey has-text-centered mb-2">
      Blue marks: chunks read to display the current step.
    </p>

    <div class="content">
      <table class="table is-narrow is-fullwidth is-size-7">
        <thead>
          <tr>
            <th>Dimension</th>
            <th>Size</th>
            <th>Chunk size</th>
            <th>Chunks</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="dim in layout.dimensions" :key="dim.name">
            <td>
              <code>{{ dim.name }}</code>
              <span v-if="dim.isSpatial" class="tag is-info is-light ml-1">
                spatial
              </span>
            </td>
            <td>{{ dim.size.toLocaleString() }}</td>
            <td>{{ dim.chunkSize.toLocaleString() }}</td>
            <td>{{ dim.chunkCount.toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
      <table class="table is-narrow is-fullwidth is-size-7">
        <tbody>
          <tr v-if="shardShape">
            <td>
              <strong>Shard shape</strong>
              <PopupDialog class="ml-1" :z-index="1002">
                <template #trigger="{ toggle, open }">
                  <button
                    class="button is-ghost is-small p-0"
                    type="button"
                    title="What is a shard?"
                    aria-label="What is a shard?"
                    :aria-expanded="open"
                    @click.stop="toggle"
                  >
                    <span class="icon is-small">
                      <i
                        class="fa-solid fa-circle-question"
                        aria-hidden="true"
                      ></i>
                    </span>
                  </button>
                </template>

                <template #default>
                  <p class="is-size-7 mb-0 shard-help">
                    A shard is one stored file that bundles many chunks. Each
                    chunk inside it can still be read on its own, so the shard
                    shape sets how many files there are, not how much data is
                    loaded.
                  </p>
                </template>
              </PopupDialog>
            </td>
            <td>
              <code>{{ shardShape.join(" × ") }}</code>
            </td>
          </tr>
          <tr>
            <td><strong>Total chunks</strong></td>
            <td>{{ layout.totalChunks.toLocaleString() }}</td>
          </tr>
          <tr v-if="spatial">
            <td><strong>Chunks loaded per step</strong></td>
            <td>{{ layout.stepChunks.toLocaleString() }}</td>
          </tr>
          <tr>
            <td>
              <strong>Chunk size</strong>
              <span class="ml-1 has-text-grey">(uncompressed)</span>
            </td>
            <td>{{ formatBytes(layout.chunkBytes) }}</td>
          </tr>
          <template v-if="spatial">
            <tr>
              <td>
                <strong>Data loaded per step</strong>
                <span class="ml-1 has-text-grey">(uncompressed)</span>
              </td>
              <td>{{ formatBytes(layout.stepBytes) }}</td>
            </tr>
            <tr>
              <td><strong>Data shown per step</strong></td>
              <td>{{ formatBytes(layout.shownBytes) }}</td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div
      v-if="spatial && (isLargeStep || overhead >= OVERHEAD_WARNING)"
      class="notification is-light is-size-7 py-2 px-3"
      :class="isLargeStep ? 'is-danger' : 'is-warning'"
    >
      <template v-if="isLargeStep">
        One step loads {{ formatBytes(layout.stepBytes) }} (uncompressed).
      </template>
      <template v-if="overhead >= OVERHEAD_WARNING">
        One step reads {{ overheadLabel }} the data shown.
      </template>
      <template v-if="overhead >= OVERHEAD_WARNING && overheadDims.length">
        Smaller chunks along
        <template v-for="(name, i) in overheadDims" :key="name">
          <code>{{ name }}</code
          >{{ i < overheadDims.length - 1 ? ", " : "" }}
        </template>
        can reduce this overhead.
      </template>
    </div>
  </section>
</template>

<style lang="scss" scoped>
.chunk-blocks {
  gap: 1rem;
}

// The popup is positioned at the trigger without a width limit.
.shard-help {
  max-width: 18rem;
}

.chunk-diagram {
  overflow: visible;
  font-size: 10px;

  text {
    fill: var(--bulma-text);
  }
}

.chunk-face {
  fill: var(--bulma-scheme-main-ter);
  stroke: var(--bulma-text);

  &.is-dense {
    fill: var(--bulma-border);
  }
}

.chunk-slab {
  fill: var(--bulma-link);
  fill-opacity: 0.35;
  stroke: var(--bulma-link);
}

.chunk-lines {
  fill: none;
  stroke: var(--bulma-text);
  stroke-width: 0.5;
  stroke-opacity: 0.6;
}
</style>
