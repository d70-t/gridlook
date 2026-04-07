<script lang="ts" setup>
import { onClickOutside } from "@vueuse/core";
import { nextTick, ref, watch, type CSSProperties } from "vue";

const open = defineModel<boolean>("open", { default: false });

defineProps<{
  dialogClass?: string;
}>();

const triggerEl = ref<HTMLElement | null>(null);
const dialogEl = ref<HTMLElement | null>(null);
const dialogStyle = ref<CSSProperties>({});

onClickOutside(dialogEl, () => close(), { ignore: [triggerEl] });

function close() {
  open.value = false;
}

function toggle() {
  open.value = !open.value;
}

function updateDialogPosition() {
  if (!triggerEl.value) {
    return;
  }
  const rect = triggerEl.value.getBoundingClientRect();
  dialogStyle.value = {
    position: "fixed",
    left: `${rect.left}px`,
    bottom: `${window.innerHeight - rect.top + 8}px`,
    zIndex: 200,
  };
}

watch(open, async (isOpen) => {
  if (isOpen) {
    await nextTick();
    updateDialogPosition();
  }
});

defineExpose({ close, toggle });
</script>

<template>
  <div ref="triggerEl" class="popup-dialog-wrapper cell">
    <slot name="trigger" :toggle="toggle" :open="open" />

    <Teleport to="body">
      <Transition name="popup">
        <div
          v-if="open"
          ref="dialogEl"
          class="popup-dialog box"
          :class="dialogClass"
          :style="dialogStyle"
          @click.stop
        >
          <slot :close="close" />
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style lang="scss" scoped>
.popup-dialog-wrapper {
  position: relative;
  display: inline-block;
}
</style>

<style lang="scss">
.popup-dialog {
  min-width: 230px;
  padding: 0.75rem;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);

  @media (max-width: 768px) {
    width: calc(100vw - 1rem);
    left: 0.5rem !important;
    right: 0.5rem !important;
    bottom: 0.5rem !important;
  }
}

.popup-dialog .dialog-section-label {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--bulma-grey);
  margin-bottom: 0.4rem;
}

.popup-enter-active,
.popup-leave-active {
  transition:
    opacity 0.15s,
    transform 0.15s;
}

.popup-enter-from,
.popup-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
