<script lang="ts" setup>
defineEmits<{
  onSnapshot: [];
}>();
</script>

<template>
  <div class="panel-block">
    <p class="control">
      <button
        class="button mb-2 mr-1"
        type="button"
        @click="() => $emit('onSnapshot')"
      >
        <i class="fa-solid fa-image mr-1"></i> Snapshot
      </button>
    </p>
  </div>
</template>
