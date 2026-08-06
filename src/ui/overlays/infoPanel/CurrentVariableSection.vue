<script lang="ts" setup>
import { ref, watch } from "vue";

import queryVariable, { type TNercVariable } from "@/lib/data/variableQuery.ts";
import CollapsibleText from "@/ui/common/CollapsibleText.vue";

const props = defineProps<{
  varname?: string | null;
  variableLongName: string | null;
  variableStandardName: string | null;
  variableUnits: string | null;
}>();

const nercInfo = ref<TNercVariable | null>(null);

let nercRequestId = 0;

watch(
  () => props.variableStandardName,
  async (standardName) => {
    const requestId = ++nercRequestId;
    nercInfo.value = null;
    if (!standardName) {
      return;
    }
    const result = await queryVariable(standardName);
    if (requestId === nercRequestId) {
      nercInfo.value = result;
    }
  },
  { immediate: true }
);
</script>

<template>
  <section class="info-section">
    <h4
      class="title is-6 is-flex is-justify-content-space-between is-align-items-center"
    >
      <span>Current Variable</span>
      <code>{{ varname }}</code>
    </h4>
    <div class="content">
      <table class="table is-narrow is-fullwidth is-size-7">
        <tbody>
          <tr>
            <td><strong>Long name</strong></td>
            <td>
              <span v-if="variableLongName">{{ variableLongName }}</span>
              <span v-else class="has-text-grey-light">-</span>
            </td>
          </tr>
          <tr>
            <td><strong>Standard name</strong></td>
            <td>
              <div
                class="is-flex is-align-items-baseline is-justify-content-space-between"
                style="gap: 0.25rem"
              >
                <span
                  v-if="variableStandardName"
                  style="word-break: break-all; min-width: 0"
                >
                  <a
                    v-if="nercInfo"
                    :href="nercInfo.variable.Url.value"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <code>{{ variableStandardName }}</code>
                  </a>
                  <code v-else>{{ variableStandardName }}</code>
                </span>
                <span v-else class="has-text-grey-light">-</span>
                <span
                  v-if="nercInfo"
                  class="tag is-success is-light is-size-7 is-flex-shrink-0"
                  title="Recognised CF standard name"
                  >CF</span
                >
              </div>
            </td>
          </tr>
          <tr>
            <td><strong>Units</strong></td>
            <td>
              <code v-if="variableUnits">{{ variableUnits }}</code>
              <span v-else class="has-text-grey-light">-</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <details v-if="nercInfo" class="is-size-7 mt-2">
      <summary class="has-text-grey coord-details-summary">
        CF standard name info (NERC)
        <span
          v-if="nercInfo.variable.Deprecated.value === 'true'"
          class="tag is-danger is-light is-size-7 ml-1"
          >DEPRECATED</span
        >
      </summary>
      <div class="mt-2">
        <div v-if="nercInfo.variable.Definition?.value" class="mb-2">
          <CollapsibleText :text="nercInfo.variable.Definition.value" />
        </div>
        <table
          v-if="
            nercInfo.replacedBy.length ||
            nercInfo.replaces.length ||
            nercInfo.alternatives.length
          "
          class="table is-narrow is-fullwidth is-size-7"
        >
          <tbody>
            <tr v-if="nercInfo.replacedBy.length">
              <td><strong>Replaced by</strong></td>
              <td>
                <span
                  v-for="v in nercInfo.replacedBy"
                  :key="v.Url.value"
                  class="mr-2"
                >
                  <a
                    :href="v.Url.value"
                    target="_blank"
                    rel="noopener noreferrer"
                    >{{ v.PrefLabel.value }}</a
                  >
                </span>
              </td>
            </tr>
            <tr v-if="nercInfo.replaces.length">
              <td><strong>Replaces</strong></td>
              <td>
                <span
                  v-for="v in nercInfo.replaces"
                  :key="v.Url.value"
                  class="mr-2"
                >
                  <a
                    :href="v.Url.value"
                    target="_blank"
                    rel="noopener noreferrer"
                    >{{ v.PrefLabel.value }}</a
                  >
                </span>
              </td>
            </tr>
            <tr v-if="nercInfo.alternatives.length">
              <td><strong>Alternatives</strong></td>
              <td>
                <span
                  v-for="v in nercInfo.alternatives"
                  :key="v.Url.value"
                  class="mr-2"
                >
                  <a
                    :href="v.Url.value"
                    target="_blank"
                    rel="noopener noreferrer"
                    >{{ v.PrefLabel.value }}</a
                  >
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="is-size-7 is-italic has-text-grey-light">
          Variable information provided by The NERC Vocabulary Server (NVS),
          National Oceanography Centre – BODC,
          <a
            href="https://vocab.nerc.ac.uk"
            target="_blank"
            rel="noopener noreferrer"
            >vocab.nerc.ac.uk</a
          >
        </p>
      </div>
    </details>
  </section>
</template>
