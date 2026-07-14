<script lang="ts" setup>
import { ToastType, useToast, type TToastType } from "./useToast.ts";

type TToastTheme = { tone: TToastType; icon: string };

const { toasts, removeToast } = useToast();

const toastThemes: Record<TToastType, TToastTheme> = {
  [ToastType.INFO]: { tone: ToastType.INFO, icon: "fa-circle-info" },
  [ToastType.SUCCESS]: { tone: ToastType.SUCCESS, icon: "fa-check" },
  [ToastType.WARNING]: {
    tone: ToastType.WARNING,
    icon: "fa-triangle-exclamation",
  },
  [ToastType.DANGER]: { tone: ToastType.DANGER, icon: "fa-ban" },
};

const getToastTheme = (type: TToastType): TToastTheme => toastThemes[type];
</script>

<template>
  <div class="toast-container" aria-live="polite" aria-atomic="false">
    <article
      v-for="toast in toasts"
      :key="toast.id"
      class="toast-card"
      :class="`is-${getToastTheme(toast.type).tone}`"
      role="alert"
    >
      <span class="toast-icon">
        <i
          class="fa-solid"
          :class="getToastTheme(toast.type).icon"
          aria-hidden="true"
        />
      </span>
      <div class="toast-copy">
        <p class="toast-title">
          <span class="has-text-weight-semibold">
            {{ toast.summary }}
          </span>
        </p>
        <p v-if="toast.detail" class="toast-detail">
          {{ toast.detail }}
        </p>
      </div>
      <button
        class="toast-close"
        type="button"
        aria-label="Close notification"
        @click="removeToast(toast.id)"
      >
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>
    </article>
  </div>
</template>

<style lang="scss">
@use "bulma/sass/utilities" as bulmaUt;
@use "sass:color";

@mixin toast-accent($accent) {
  border: 1px solid color.adjust($accent, $lightness: 15%);
  background-color: color.adjust($accent, $lightness: 25%);
}

.toast-container {
  position: fixed;
  top: 1rem;
  right: 1rem;
  z-index: 50;
  display: grid;
  gap: 0.75rem;
  pointer-events: none;
}

.toast-card {
  @include toast-accent(bulmaUt.$info);
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.9rem 1rem;
  border-radius: bulmaUt.$radius;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.06);
  pointer-events: auto;
  width: min(28rem, calc(100vw - 2rem));
}

.toast-card.is-success {
  @include toast-accent(bulmaUt.$success);
  .toast-icon {
    color: bulmaUt.$success;
  }
}

.toast-card.is-warning {
  @include toast-accent(bulmaUt.$warning);
  .toast-icon {
    color: bulmaUt.$warning;
  }
}

.toast-card.is-danger {
  @include toast-accent(bulmaUt.$danger);
  .toast-icon {
    color: bulmaUt.$danger;
  }
}

.toast-icon {
  font-size: 2.5rem;
}

.toast-copy {
  flex: 1 1 auto;
  line-height: 1.3;
}

.toast-detail {
  margin: 0.15rem 0 0;
}

.toast-close {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  color: bulmaUt.$grey;
  font-size: 1em;
}
</style>
