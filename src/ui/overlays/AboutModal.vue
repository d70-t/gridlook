<script setup lang="ts">
import QRCode from "qrcode";
import { nextTick, ref, watch } from "vue";

import Modal from "@/ui/common/Modal.vue";

const visible = ref(false);
const repoQrCanvas = ref<HTMLCanvasElement | null>(null);
const pageQrCanvas = ref<HTMLCanvasElement | null>(null);

function generateQR(canvas: HTMLCanvasElement | null, url: string) {
  if (canvas) {
    void QRCode.toCanvas(canvas, url, { width: 150 });
  }
}

watch(visible, async (newVal) => {
  if (newVal) {
    await nextTick();
    generateQR(repoQrCanvas.value, "https://github.com/d70-t/gridlook");
    generateQR(pageQrCanvas.value, "https://gridlook.pages.dev");
  }
});
</script>

<template>
  <Modal v-model="visible" title="About Gridlook">
    <p>
      GridLook is a WebGL-based viewer for Earth system model (ESM) output. It
      supports cloud-hosted Zarr datasets and provides interactive grid
      visualization tools.
    </p>
    <div class="columns is-mobile mt-3">
      <div class="column has-text-centered">
        <p class="has-text-weight-semibold">Application</p>
        <canvas
          ref="pageQrCanvas"
          role="img"
          aria-label="QR code for the Gridlook application"
        >
          QR code for the Gridlook application.
        </canvas>
      </div>
      <div class="column has-text-centered">
        <p class="has-text-weight-semibold">GitHub</p>
        <canvas
          ref="repoQrCanvas"
          role="img"
          aria-label="QR code for the Gridlook GitHub repository"
        >
          QR code for the Gridlook GitHub repository.
        </canvas>
      </div>
    </div>
    <br />
    <p>
      Developed by Max-Planck-Institute for Meteorology (MPI-M) and the German
      Climate Computing Center (DKRZ)
    </p>
    <p class="mt-3 is-size-7 has-text-grey">Earth texture credit: NASA.</p>
    <template #footer>
      <p>
        <a
          href="https://github.com/d70-t/gridlook"
          target="_blank"
          rel="noopener noreferrer"
          class="button is-link is-light"
        >
          <span class="icon">
            <i class="fa-brands fa-github"></i>
          </span>
          <span>View on GitHub</span>
        </a>
      </p>
    </template>
  </Modal>
  <button
    class="button is-info is-small"
    aria-label="About"
    type="button"
    @click="visible = true"
  >
    <span class="icon">
      <i class="fa-solid fa-circle-question"></i>
    </span>
    <span>About</span>
  </button>
</template>
