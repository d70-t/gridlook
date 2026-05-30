<script lang="ts" setup>
import { VueDatePicker } from "@vuepic/vue-datepicker";
import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc.js";
import "@vuepic/vue-datepicker/dist/main.css";
import { computed, ref, watch } from "vue";

import { findTimeIndex, decodeTime } from "@/lib/data/timeHandling.ts";
import Modal from "@/ui/common/Modal.vue";

const props = defineProps<{
  timeValues: ArrayLike<number | bigint | string> | null;
  timeAttrs: Record<string, unknown> | null;
  currentIndex: number;
  minIndex: number;
  maxIndex: number;
}>();

const emit = defineEmits<{
  (e: "update:index", index: number): void;
}>();

dayjs.extend(utc);

const isOpen = ref(false);
const inputDatetime = ref<Date | null>(null);
const previewIndex = ref<number | null>(null);
const previewDatetime = ref<Dayjs | null>(null);
const errorMessage = ref<string | null>(null);

// Compute the datetime range for display
const minDatetime = computed(() => {
  return decodeTimeAtIndex(props.minIndex);
});

const maxDatetime = computed(() => {
  return decodeTimeAtIndex(props.maxIndex);
});

// Current datetime at the selected index
const currentDatetime = computed(() => {
  return decodeTimeAtIndex(props.currentIndex);
});

function decodeTimeAtIndex(index: number): Dayjs | null {
  if (!props.timeValues || !props.timeAttrs || props.timeValues.length === 0) {
    return null;
  }
  const val = props.timeValues[index];
  return decodeTime(
    typeof val === "bigint"
      ? Number(val)
      : typeof val === "string"
        ? Number(val)
        : val,
    props.timeAttrs
  );
}

// Initialize input with current datetime when opening
watch(isOpen, (open) => {
  if (open && currentDatetime.value) {
    inputDatetime.value = currentDatetime.value.toDate();
    previewIndex.value = null;
    previewDatetime.value = null;
    errorMessage.value = null;
  }
});

// Parse and preview on input change
function onInputChange() {
  errorMessage.value = null;
  previewIndex.value = null;
  previewDatetime.value = null;

  if (!inputDatetime.value || !props.timeValues || !props.timeAttrs) {
    errorMessage.value = "Invalid datetime format";
    return;
  }

  try {
    // The DatePicker returns a Date object in local time, but we want to
    // interpret the displayed values as UTC. Extract the components and
    // construct a UTC datetime directly.
    const date = inputDatetime.value;
    const parsed = dayjs
      .utc()
      .year(date.getFullYear())
      .month(date.getMonth())
      .date(date.getDate())
      .hour(date.getHours())
      .minute(date.getMinutes())
      .second(date.getSeconds());
    if (!parsed.isValid()) {
      errorMessage.value = "Invalid datetime format";
      return;
    }

    const index = findTimeIndex(parsed, props.timeValues, props.timeAttrs);
    previewIndex.value = index;

    // Show the actual datetime at that index
    previewDatetime.value = decodeTimeAtIndex(index);
  } catch (e) {
    errorMessage.value =
      e instanceof Error ? e.message : "Error parsing datetime";
  }
}

function onConfirm() {
  if (previewIndex.value !== null) {
    emit("update:index", previewIndex.value);
    isOpen.value = false;
  }
}

function onCancel() {
  isOpen.value = false;
}

function openPicker() {
  if (props.timeValues && props.timeAttrs) {
    isOpen.value = true;
  }
}
</script>

<template>
  <button
    class="button is-small"
    :disabled="!timeValues || !timeAttrs"
    title="Select time"
    type="button"
    @click="openPicker"
  >
    <span class="icon">
      <i class="fas fa-calendar-alt"></i>
    </span>
  </button>

  <Modal
    v-model="isOpen"
    title="Select Time"
    footer-class="is-justify-content-flex-end"
  >
    <!-- Range info -->
    <div v-if="minDatetime && maxDatetime" class="mb-2">
      <p class="label mb-1">Available range</p>
      <p>
        {{ minDatetime.format("YYYY-MM-DD HH:mm:ss") }}
        to
        {{ maxDatetime.format("YYYY-MM-DD HH:mm:ss") }}
      </p>
    </div>

    <!-- Input field -->
    <div class="field mb-2">
      <label class="label mb-1">Enter datetime</label>
      <div class="control">
        <VueDatePicker
          v-model="inputDatetime"
          :formats="{ input: 'yyyy-MM-dd HH:mm:ss' }"
          :min-date="minDatetime?.toDate()"
          :max-date="maxDatetime?.toDate()"
          teleport
          text-input
          @update:model-value="onInputChange"
          @text-input="onInputChange"
        >
          <template #action-row="{ selectDate, closePicker, modelValue }">
            <span class="ml-2 mr-4" :class="[!modelValue && 'has-text-danger']">
              {{
                modelValue
                  ? dayjs(modelValue as Date).format("YYYY-MM-DD HH:mm")
                  : "Invalid date"
              }}
            </span>
            <div class="buttons ml-auto">
              <button class="button" type="button" @click="closePicker">
                Cancel
              </button>
              <button
                class="button is-success"
                type="button"
                :disabled="!modelValue"
                @click="selectDate"
              >
                Select
              </button>
            </div>
          </template>
        </VueDatePicker>
      </div>
      <p class="help">Format: YYYY-MM-DD HH:mm:ss</p>
    </div>

    <!-- Preview section - always visible with fixed height -->
    <div
      class="is-flex is-justify-content-space-between is-align-items-center mb-2"
    >
      <span v-if="errorMessage" class="is-size-7 has-text-danger">
        <i class="fas fa-exclamation-circle"></i>
        {{ errorMessage }}
      </span>
    </div>
    <div class="preview-content">
      <template v-if="previewIndex !== null && previewDatetime">
        <dl>
          <dt class="label">
            New Index
            <span class="has-text-grey-light"
              >(of {{ minIndex }}–{{ maxIndex }})</span
            >
          </dt>
          <dd>{{ previewIndex }}</dd>
          <dt class="label">Datetime at new index</dt>
          <dd>{{ previewDatetime.format("YYYY-MM-DD HH:mm:ss") }}</dd>
          <dt class="label has-text-grey-light">Current Index</dt>
          <dd>{{ currentIndex }}</dd>
        </dl>
      </template>
      <template v-else>
        <p class="has-text-grey-light has-text-centered py-4">
          Select a datetime to preview
        </p>
      </template>
    </div>

    <template #footer>
      <div class="buttons">
        <button class="button" type="button" @click="onCancel">Cancel</button>
        <button
          class="button is-success"
          :disabled="previewIndex === null"
          type="button"
          @click="onConfirm"
        >
          <span class="icon">
            <i class="fas fa-check"></i>
          </span>
          <span>Apply</span>
        </button>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.preview-content {
  min-height: 65px;
}

.preview-content dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25em 0.5em;
}

:root {
  --dp-border-radius: var(--bulma-control-radius);
  --dp-cell-border-radius: var(--bulma-control-radius);
  --dp-cell-size: 45px; /*Width and height of calendar cell*/
}

.dp--theme-light {
  --dp-primary-color: var(--bulma-success);
  --dp-primary-disabled-color: var(--bulma-button-disabled-background-color);
  --dp-primary-text-color: var(--bulma-text);
}

.dp--input {
  box-shadow: var(
    --bulma-input-shadow,
    inset 0 0.0625em 0.125em rgba(10, 10, 10, 0.05)
  );
  height: var(--bulma-control-height, 2.5em);
}

.dp--input-focus {
  border-color: #485fc7 !important;
  box-shadow: 0 0 0 0.125em
    color-mix(in srgb, var(--bulma-link) 25%, transparent);
}

.dp--overlay-cell-disabled {
  background-color: var(--bulma-background);
  color: var(--bulma-text);
  opacity: 0.5;
}
</style>
