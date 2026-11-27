<script lang="ts" setup>
/**
 * A calendar button beside a plot's date field. The picked date is handed back
 * as text and read like a typed one (the axis's own calendar, the nearest
 * source time), so the two controls cannot pick different rows.
 */
import { VueDatePicker } from "@vuepic/vue-datepicker";
import "@vuepic/vue-datepicker/dist/main.css";
import { computed } from "vue";

import { parseCalendarDate } from "@/lib/analysis/calendar.ts";

const props = defineProps<{
  /** The field's date, as it shows it (YYYY-MM-DD HH:MM). */
  value: string;
  /** The first and last source dates, as the field would show them. */
  first: string;
  last: string;
}>();
const emit = defineEmits<{ pick: [text: string] }>();

/** A shown date as the picker's (local) date; undefined when unreadable. */
function asDate(text: string) {
  const date = parseCalendarDate(text);
  if (!date) {
    return undefined;
  }
  const value = new Date(2000, 0, 1, date.hour, date.minute);
  value.setFullYear(date.year, date.month - 1, date.day);
  return value;
}
const model = computed(() => asDate(props.value));
/** The earliest and latest source dates, whichever is stored first. */
const limits = computed(() => {
  const ends = [asDate(props.first), asDate(props.last)];
  const [a, b] = ends;
  return a && b && a > b ? [b, a] : ends;
});

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
function picked(value: Date | null) {
  if (!value) {
    return;
  }
  emit(
    "pick",
    `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
      `${pad(value.getHours())}:${pad(value.getMinutes())}`
  );
}
</script>

<template>
  <VueDatePicker
    :model-value="model"
    :min-date="limits[0]"
    :max-date="limits[1]"
    :start-date="model"
    teleport
    :action-row="{ showNow: false, showPreview: false }"
    @update:model-value="picked"
  >
    <template #trigger>
      <button
        class="button is-small"
        type="button"
        title="Pick a date: the nearest source time is used"
        aria-label="Pick a date"
      >
        <span class="icon">
          <i class="fas fa-calendar-alt" aria-hidden="true"></i>
        </span>
      </button>
    </template>
  </VueDatePicker>
</template>
