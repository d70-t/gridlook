<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed } from "vue";

import ShareButton from "./ShareButton.vue";
import SnapshotButton from "./SnapshotButton.vue";

import { PROJECTION_TYPES } from "@/lib/projection/projectionUtils.ts";
import type { TSnapshotOptions } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { isPresenterActive } from "@/store/usePresenterSync.ts";
import { isMobileDevice } from "@/ui/common/viewConstants.ts";

defineProps<{
  infoPanelOpen: boolean;
}>();

defineEmits<{
  onSnapshot: [options: TSnapshotOptions];
  onRotate: [];
  toggleDisplay: [];
  toggleInfoPanel: [];
}>();

const store = useGlobeControlStore();
const { projectionMode, isRotating, hoverEnabled } = storeToRefs(store);
const valueProbeSupported = computed(
  () => projectionMode.value !== PROJECTION_TYPES.AZIMUTHAL_HYBRID
);
const showPresenter = !isMobileDevice();
</script>

<template>
  <div class="column">
    <div class="grid">
      <button
        class="button cell"
        :class="{ 'is-info': infoPanelOpen }"
        type="button"
        :title="
          infoPanelOpen ? 'Close Dataset Info panel' : 'Open Dataset Info panel'
        "
        :aria-expanded="infoPanelOpen"
        @click="() => $emit('toggleInfoPanel')"
      >
        <span class="icon">
          <i class="fa-solid fa-circle-info"></i>
        </span>
        <span>Dataset Info</span>
      </button>
      <SnapshotButton @on-snapshot="(opts) => $emit('onSnapshot', opts)" />
      <button
        class="button cell"
        :class="{ 'is-info': hoverEnabled && valueProbeSupported }"
        type="button"
        :title="
          !valueProbeSupported
            ? 'Data Picker is unavailable in Azimuthal Hybrid projection'
            : hoverEnabled
              ? 'Disable Data Picker readout on hover'
              : 'Enable Data Picker readout on hover'
        "
        :disabled="!valueProbeSupported"
        @click="store.toggleHoverEnabled"
      >
        <span class="icon">
          <i class="fas fa-crosshairs"></i>
        </span>
        <span> Data Picker </span>
      </button>
      <button
        class="button cell"
        :class="{ 'is-info': isRotating }"
        type="button"
        :title="
          projectionMode !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE
            ? 'Rotate the projection around longitude'
            : 'Rotate the globe'
        "
        @click="() => $emit('onRotate')"
      >
        <span class="icon">
          <i class="fas fa-rotate"></i>
        </span>
        <span> Rotate </span>
      </button>
      <ShareButton class="cell" />
      <button
        v-if="showPresenter"
        class="button cell"
        :class="{ 'is-info': isPresenterActive }"
        type="button"
        :title="
          isPresenterActive
            ? 'Close the presenter window'
            : 'Open a second window for presenting (controls stay here, display goes there)'
        "
        @click="() => $emit('toggleDisplay')"
      >
        <span class="icon">
          <i class="fas fa-display"></i>
        </span>
        <span> Present </span>
      </button>
    </div>
  </div>
</template>
