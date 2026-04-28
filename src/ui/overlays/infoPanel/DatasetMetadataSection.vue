<script lang="ts" setup>
import { computed } from "vue";
import * as zarr from "zarrita";

import CollapsibleText from "@/ui/common/CollapsibleText.vue";

const props = defineProps<{
  groupAttrs: zarr.Attributes | null;
}>();

const datasetTitle = computed(() => (props.groupAttrs?.title as string) || "-");

const datasetContact = computed(
  () =>
    (props.groupAttrs?.contact as string) ||
    (props.groupAttrs?.creator_email as string) ||
    "-"
);

const datasetCreationDate = computed(
  () =>
    (props.groupAttrs?.creation_date as string) ||
    (props.groupAttrs?.date_created as string) ||
    "-"
);

const datasetInstitution = computed(
  () =>
    (props.groupAttrs?.institution as string) ||
    (props.groupAttrs?.institute as string) ||
    "-"
);

const datasetLicense = computed(
  () =>
    (props.groupAttrs?.license as string) ||
    (props.groupAttrs?.licence as string) ||
    "-"
);

const datasetDescription = computed(
  () =>
    (props.groupAttrs?.description as string) ||
    (props.groupAttrs?.summary as string) ||
    "-"
);

const datasetCreators = computed(
  () =>
    (props.groupAttrs?.creators as string) ||
    (props.groupAttrs?.authors as string) ||
    (props.groupAttrs?.creator_name as string) ||
    "-"
);
</script>

<template>
  <section class="info-section">
    <h4 class="title is-6">Dataset Metadata</h4>
    <div class="content">
      <table class="table is-narrow is-fullwidth is-size-7">
        <tbody>
          <tr>
            <td><strong>Title</strong></td>
            <td>{{ datasetTitle }}</td>
          </tr>
          <tr>
            <td><strong>Description</strong></td>
            <td>
              <CollapsibleText :text="datasetDescription" />
            </td>
          </tr>
          <tr>
            <td><strong>Institution</strong></td>
            <td>{{ datasetInstitution }}</td>
          </tr>
          <tr>
            <td><strong>Creators</strong></td>
            <td>
              <CollapsibleText :text="datasetCreators" />
            </td>
          </tr>
          <tr>
            <td><strong>Contact</strong></td>
            <td>{{ datasetContact }}</td>
          </tr>
          <tr>
            <td><strong>Creation Date</strong></td>
            <td>{{ datasetCreationDate }}</td>
          </tr>
          <tr>
            <td><strong>License</strong></td>
            <td>
              <CollapsibleText :text="datasetLicense" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
