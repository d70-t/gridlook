<script lang="ts" setup>
import RightClickMouse from "./RightClickMouse.vue";
import { ToastType, useToast, type TToastType } from "./useToast.ts";

type TToastTheme = { tone: TToastType; icon: string };

const { toasts, removeToast } = useToast();

function act(toast: (typeof toasts.value)[number]) {
  removeToast(toast.id);
  toast.action?.run();
}

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
      :class="[
        `is-${getToastTheme(toast.type).tone}`,
        { 'is-compact': toast.compact },
      ]"
      role="alert"
    >
      <span class="toast-icon">
        <RightClickMouse v-if="toast.icon === 'right-click'" />
        <i
          v-else
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
        v-if="toast.action"
        class="button is-small toast-action"
        type="button"
        @click="act(toast)"
      >
        {{ toast.action.label }}
      </button>
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
  z-index: 1050;
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

/* A one-line notice (an Undo, a tip): sized to its text, at the right. */
.toast-card.is-compact {
  justify-self: end;
  width: auto;
  max-width: min(24rem, calc(100vw - 2rem));
  gap: 0.6rem;
  padding: 0.4rem 0.5rem 0.4rem 0.75rem;
  font-size: 0.875rem;
  .toast-icon {
    font-size: 1rem;
  }
  .toast-action.button {
    margin-right: 0;
  }
  .toast-close {
    position: static;
  }
}

/* The map's corner indicator (animation playing, or loading: 40 px at 10 px
   from the top right) keeps its corner: notices stand left of it instead of
   under it. */
body:has(.top-right-loader) .toast-container {
  right: 58px;
}
body:has(.top-right-loader) .toast-card {
  max-width: min(24rem, calc(100vw - 58px - 1rem));
}

/* The card is always light: its text and button stay dark in dark mode. */
.toast-card {
  color: bulmaUt.$grey-darker;
}

.toast-action.button {
  flex: none;
  margin-right: 1.25rem;
  font-weight: 600;
  background-color: bulmaUt.$white;
  color: bulmaUt.$grey-darker;
  border-color: bulmaUt.$grey-lighter;
}

.toast-close {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  color: bulmaUt.$grey;
  font-size: 1em;
}
</style>
