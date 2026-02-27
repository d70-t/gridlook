<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    footerClass?: string;
  }>(),
  {
    footerClass: "",
  }
);

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  close: [];
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
});

function close() {
  visible.value = false;
  emit("close");
}

// Handle Escape key
useEventListener(document, "keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape" && visible.value) {
    close();
  }
});
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="modal is-active">
      <div class="modal-background" @click.self="close"></div>
      <div class="modal-card">
        <header class="modal-card-head">
          <p class="modal-card-title">{{ title }}</p>
          <button
            type="button"
            class="delete"
            aria-label="close"
            @click="close"
          ></button>
        </header>
        <section class="modal-card-body">
          <slot />
        </section>
        <footer
          v-if="$slots.footer"
          class="modal-card-foot"
          :class="footerClass"
        >
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
