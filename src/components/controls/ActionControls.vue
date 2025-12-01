<script lang="ts" setup>
defineEmits<{
  onSnapshot: [];
  onRotate: [];
}>();
</script>

<template>
  <div class="panel-block">
    <div class="w-100 is-flex is-justify-content-space-between">
      <button class="button" type="button" @click="() => $emit('onSnapshot')">
        <span class="icon"><i class="fa-solid fa-image"></i></span>
        <span> Snapshot</span>
      </button>
      <button class="button" type="button" @click="() => $emit('onRotate')">
        <span class="icon">
          <i class="fas fa-rotate"></i>
        </span>
        <span> Rotate </span>
      </button>
    </div>
  </div>
</template>
