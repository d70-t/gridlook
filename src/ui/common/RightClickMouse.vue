<script lang="ts" setup>
/**
 * A small mouse whose right button clicks, over and over: the gesture a
 * tip means, shown rather than told (24 Nov). Still where motion is
 * reduced; the right button stays lit.
 */
withDefaults(defineProps<{ animated?: boolean }>(), { animated: true });
</script>

<template>
  <svg
    class="right-click-mouse"
    :class="{ animated }"
    viewBox="0 0 16 22"
    aria-hidden="true"
  >
    <rect x="1" y="1" width="14" height="20" rx="7" class="body" />
    <path d="M8 1v8M1 9h14" class="seam" />
    <path d="M8 1.2a6.8 6.8 0 0 1 6.8 6.8V9H8z" class="button" />
    <path d="M13.5 0.5l2 -1.5M15.5 3l2.2 -0.4M15.2 5.8l2 0.8" class="ripple" />
  </svg>
</template>

<style scoped>
.right-click-mouse {
  width: 1em;
  height: 1.35em;
  overflow: visible;
  vertical-align: -0.2em;
}
.body,
.seam {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
}
.button {
  fill: var(--bulma-link, #485fc7);
  transform-origin: 11px 5px;
}
.ripple {
  fill: none;
  stroke: var(--bulma-link, #485fc7);
  stroke-width: 1.2;
  stroke-linecap: round;
  opacity: 0;
}
.animated .button {
  animation: right-click-press 1.6s ease-in-out infinite;
}
.animated .ripple {
  animation: right-click-ripple 1.6s ease-out infinite;
}
@keyframes right-click-press {
  0%,
  35%,
  100% {
    opacity: 0.45;
    transform: scale(1);
  }
  45%,
  60% {
    opacity: 1;
    transform: scale(0.88);
  }
}
@keyframes right-click-ripple {
  0%,
  40% {
    opacity: 0;
  }
  50% {
    opacity: 1;
  }
  80%,
  100% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .animated .button,
  .animated .ripple {
    animation: none;
  }
  .button {
    opacity: 1;
  }
}
</style>
