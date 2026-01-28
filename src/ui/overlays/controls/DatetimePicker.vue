<script lang="ts" setup>
import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import DatePicker from "primevue/datepicker";
import { computed, ref, watch } from "vue";

import { findTimeIndex, decodeTime } from "@/lib/data/timeHandling";

const props = defineProps<{
  timeValues: ArrayLike<number | bigint> | null;
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
  if (!props.timeValues || !props.timeAttrs || props.timeValues.length === 0) {
    return null;
  }
  const val = props.timeValues[props.minIndex];
  return decodeTime(
    typeof val === "bigint" ? Number(val) : val,
    props.timeAttrs
  );
});

const maxDatetime = computed(() => {
  if (!props.timeValues || !props.timeAttrs || props.timeValues.length === 0) {
    return null;
  }
  const val = props.timeValues[props.maxIndex];
  return decodeTime(
    typeof val === "bigint" ? Number(val) : val,
    props.timeAttrs
  );
});

// Current datetime at the selected index
const currentDatetime = computed(() => {
  if (!props.timeValues || !props.timeAttrs || props.timeValues.length === 0) {
    return null;
  }
  const val = props.timeValues[props.currentIndex];
  return decodeTime(
    typeof val === "bigint" ? Number(val) : val,
    props.timeAttrs
  );
});

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
    const val = props.timeValues[index];
    previewDatetime.value = decodeTime(
      typeof val === "bigint" ? Number(val) : val,
      props.timeAttrs
    );
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

  <!-- Modal -->

  <Teleport to="body">
    <div>
      <div class="modal" :class="{ 'is-active': isOpen }">
        <div class="modal-background" @click="onCancel"></div>
        <div class="modal-card">
          <header class="modal-card-head">
            <p class="modal-card-title">Select Time</p>
            <button
              class="delete"
              aria-label="close"
              type="button"
              @click="onCancel"
            ></button>
          </header>
          <section class="modal-card-body">
            <!-- Range info -->
            <div v-if="minDatetime && maxDatetime" class="mb-2">
              <p class="has-text-grey">Available range</p>
              <p>
                <strong>{{ minDatetime.format("YYYY-MM-DD HH:mm:ss") }}</strong>
                to
                <strong>{{ maxDatetime.format("YYYY-MM-DD HH:mm:ss") }}</strong>
              </p>
            </div>

            <!-- Input field -->
            <div class="field mb-2">
              <label class="label mb-1">Enter datetime</label>
              <div class="control">
                <DatePicker
                  v-model="inputDatetime"
                  show-time
                  show-seconds
                  :min-date="minDatetime?.toDate()"
                  :max-date="maxDatetime?.toDate()"
                  date-format="yy-m-d"
                  hour-format="24"
                  show-icon
                  :show-on-focus="false"
                  fluid
                  :invalid="!inputDatetime"
                  @update:model-value="onInputChange"
                  @blur="onInputChange"
                >
                  <template #footer>
                    <span
                      v-if="previewIndex !== null"
                      class="tag is-info is-light"
                    >
                      New Index: {{ previewIndex }}
                    </span>
                  </template>
                </DatePicker>
              </div>
              <p class="help">Format: YYYY-MM-DD HH:mm:ss</p>
            </div>

            <!-- Preview section - always visible with fixed height -->
            <div
              class="is-flex is-justify-content-space-between is-align-items-center mb-2"
            >
              <span class="has-text-grey">Selection Preview</span>
              <span v-if="errorMessage" class="is-size-7 has-text-danger">
                <i class="fas fa-exclamation-circle"></i>
                {{ errorMessage }}
              </span>
            </div>
            <div class="preview-content">
              <template v-if="previewIndex !== null && previewDatetime">
                <p class="mb-1">
                  <span class="has-text-grey">New Index:</span>
                  <strong class="ml-2">{{ previewIndex }}</strong>
                  <span class="has-text-grey-light ml-2"
                    >(of {{ minIndex }}–{{ maxIndex }})</span
                  >
                </p>
                <p class="mb-1">
                  <span class="has-text-grey">Datetime:</span>
                  <strong class="ml-2"
                    >{{ previewDatetime.format("YYYY-MM-DD HH:mm:ss") }}
                  </strong>
                </p>
                <p class="has-text-grey mt-2 pt-2 current-hint">
                  Old Index {{ currentIndex }}
                </p>
              </template>
              <template v-else>
                <p class="has-text-grey-light has-text-centered py-4">
                  Select a datetime to preview
                </p>
              </template>
            </div>
          </section>
          <footer class="modal-card-foot is-justify-content-flex-end">
            <div class="buttons">
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
              <button class="button" type="button" @click="onCancel">
                Cancel
              </button>
            </div>
          </footer>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.preview-content {
  min-height: 65px;
}

.current-hint {
  border-top: 1px dashed #dbdbdb;
}
</style>

<style>
.p-datepicker-input:focus {
  border-color: #485fc7 !important;
  box-shadow: 0 0 0 0.125em rgba(72, 95, 199, 0.25) !important;
}
</style>
