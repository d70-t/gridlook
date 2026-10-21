<script lang="ts" setup>
import { useClipboard } from "@vueuse/core";

import { tagLabel, type TCatalogEntry } from "@/utils/catalog.ts";

const props = withDefaults(
  defineProps<{
    entries: TCatalogEntry[];
    currentSource: string;
    tagKeys?: string[];
  }>(),
  { tagKeys: () => [] }
);

const emit = defineEmits<{
  select: [entry: TCatalogEntry];
  tagClick: [key: string, value: string];
}>();

const { copy, copied, text: copiedText } = useClipboard({ copiedDuring: 1500 });

// Golden angle steps keep the hues of neighboring tag keys far apart.
function tagHue(key: string) {
  return (props.tagKeys.indexOf(key) * 137.508) % 360;
}

function withoutTrailingSlash(url: string) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function isCurrent(entry: TCatalogEntry) {
  return (
    withoutTrailingSlash(entry.url) ===
    withoutTrailingSlash(props.currentSource)
  );
}
</script>

<template>
  <div>
    <slot v-if="entries.length === 0" />
    <div
      v-for="(entry, i) in entries"
      :key="entry.url + '-' + i"
      class="catalog-entry panel-block"
      :class="{ 'is-current has-text-grey': isCurrent(entry) }"
    >
      <div class="catalog-entry-content">
        <div class="catalog-entry-header">
          <button
            type="button"
            class="catalog-entry-main"
            :aria-current="isCurrent(entry) || undefined"
            :disabled="isCurrent(entry)"
            @click="emit('select', entry)"
          >
            <span
              class="icon is-small"
              :class="isCurrent(entry) ? 'has-text-secondary' : 'has-text-grey'"
              :title="isCurrent(entry) ? 'Currently open' : undefined"
            >
              <i
                class="fa-solid"
                :class="isCurrent(entry) ? 'fa-eye' : 'fa-database'"
              ></i>
            </span>
            <strong
              class="catalog-entry-title"
              :title="entry.title ?? entry.url"
            >
              {{ entry.title ?? entry.url }}
            </strong>
          </button>
          <span
            v-if="isCurrent(entry)"
            class="is-size-7 has-text-weight-semibold has-text-secondary is-flex-shrink-0"
          >
            Currently open
          </span>
          <!-- A single tag stays in this line, several get a line of their own -->
          <div
            v-if="entry.tags"
            class="is-flex is-flex-wrap-wrap is-gap-1"
            :class="{
              'catalog-entry-tags-row': Object.keys(entry.tags).length > 1,
            }"
          >
            <button
              v-for="(value, key) in entry.tags"
              :key="key"
              type="button"
              class="tag catalog-tag"
              :style="{ '--tag-hue': tagHue(key) }"
              :title="`Filter by ${tagLabel(key)}: ${value}`"
              @click="emit('tagClick', key, value)"
            >
              {{ value }}
            </button>
          </div>
          <a
            type="button"
            class="tag is-link is-light"
            title="Copy dataset URL"
            aria-label="Copy dataset URL"
            @click="copy(entry.url)"
          >
            <span class="icon is-small">
              <i
                class="fa-solid"
                :class="
                  copied && copiedText === entry.url ? 'fa-check' : 'fa-copy'
                "
              ></i>
            </span>
          </a>
        </div>
        <p v-if="entry.description" class="help has-text-grey mt-1 mb-0">
          {{ entry.description }}
        </p>
        <p
          v-if="entry.title"
          class="help has-text-grey-light mt-1 mb-0 catalog-entry-url"
          :title="entry.url"
        >
          {{ entry.url }}
        </p>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.catalog-entry {
  display: block !important;
  &.is-current {
    background-color: var(--bulma-scheme-main-ter) !important;
    box-shadow: inset 3px 0 0 var(--bulma-grey);
  }
  border-bottom: 1px solid var(--bulma-border) !important;
  &:last-child {
    border-bottom: none !important;
  }
}

.catalog-entry-content {
  width: 100%;
  min-width: 0;
}

.catalog-entry-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-width: 0;
}

.catalog-entry-main {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  // A zero basis keeps long titles from wrapping the copy button.
  flex: 1 1 0;
  min-width: 0;
  padding: 0.25rem;
  border-radius: var(--bulma-radius);
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  color: inherit;
  transition:
    background-color 0.3s ease,
    color 0.3s ease;
  &:hover:enabled {
    background-color: var(--bulma-link-light);
    color: var(--bulma-link);
  }
  &:disabled {
    cursor: default;
  }
}

.catalog-entry-tags-row {
  order: 1;
  flex-basis: 100%;
}

.catalog-entry-title {
  display: block;
  flex: 1 1 auto;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0;
}

.catalog-entry-url {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.catalog-tag {
  border: none;
  cursor: pointer;
  transition: background-color 0.3s ease;
  background-color: hsl(var(--tag-hue) 70% 95%);
  color: hsl(var(--tag-hue) 60% 25%);
  &:hover {
    background-color: hsl(var(--tag-hue) 70% 85%);
  }
}

@media (prefers-color-scheme: dark) {
  .catalog-tag {
    background-color: hsl(var(--tag-hue) 40% 25%);
    color: hsl(var(--tag-hue) 70% 85%);
    &:hover {
      background-color: hsl(var(--tag-hue) 40% 37%);
    }
  }
}
</style>
