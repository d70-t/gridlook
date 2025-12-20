<script lang="ts" setup>
import Toast from "primevue/toast";
type ToastTone = "info" | "success" | "warning" | "danger";

const toastThemes: Record<string, { tone: ToastTone; icon: string }> = {
  info: { tone: "info", icon: "fa-circle-info" },
  success: { tone: "success", icon: "fa-check" },
  warn: { tone: "warning", icon: "fa-triangle-exclamation" },
  warning: { tone: "warning", icon: "fa-triangle-exclamation" },
  error: { tone: "danger", icon: "fa-ban" },
  danger: { tone: "danger", icon: "fa-ban" },
};

const getToastTheme = (severity?: string) =>
  toastThemes[severity ?? ""] ?? toastThemes.info;
</script>

<template>
  <Toast unstyled position="top-right">
    <template #container="{ message, closeCallback }">
      <article
        class="toast-card mb-3"
        :class="`is-${getToastTheme(message.severity).tone}`"
        role="alert"
      >
        <span class="toast-icon">
          <i
            class="fa-solid"
            :class="getToastTheme(message.severity).icon"
            aria-hidden="true"
          />
        </span>
        <div class="toast-copy">
          <p class="toast-title">
            <span class="has-text-weight-semibold">
              {{ message.summary }}
            </span>
          </p>
          <p v-if="message.detail" class="toast-detail">
            {{ message.detail }}
          </p>
        </div>
        <button
          class="toast-close"
          type="button"
          aria-label="Close notification"
          @click="closeCallback"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </article>
    </template>
  </Toast>
</template>

<style lang="scss">
@use "bulma/sass/utilities" as bulmaUt;
@use "sass:color";

@mixin toast-accent($accent) {
  border: 1px solid color.adjust($accent, $lightness: 15%);
  background-color: color.adjust($accent, $lightness: 25%);
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
  width: 28rem;
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
