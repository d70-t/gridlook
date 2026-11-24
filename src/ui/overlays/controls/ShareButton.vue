<script lang="ts" setup>
import QRCode from "qrcode";
import { defineAsyncComponent, ref, watch } from "vue";

import PopupDialog from "./PopupDialog.vue";

import { ToastType, useToast } from "@/ui/common/useToast.ts";

// The plots part, in the build only with plots (see GlobeView).
const ShareSession =
  import.meta.env.VITE_GRIDLOOK_PLOTS === "false"
    ? undefined
    : defineAsyncComponent(() => import("@/ui/analysis/ShareSession.vue"));

/** Longer links make QR codes too dense to scan reliably. */
const QR_LIMIT = 2000;

const { addToast } = useToast();
const dialogOpen = ref(false);
const currentUrl = ref("");
const qrCodeDataUrl = ref("");
const isGeneratingQr = ref(false);

const popupRef = ref<InstanceType<typeof PopupDialog> | null>(null);

function close() {
  dialogOpen.value = false;
}

watch(dialogOpen, (open) => {
  if (open) {
    currentUrl.value = window.location.href;
    void generateQrCode(currentUrl.value);
  }
});

/** The link with the plots written in it. */
function sessionUrl(url: string) {
  currentUrl.value = url;
  void generateQrCode(url);
}

async function generateQrCode(url: string) {
  if (url.length > QR_LIMIT) {
    qrCodeDataUrl.value = "";
    return;
  }
  isGeneratingQr.value = true;
  try {
    qrCodeDataUrl.value = await QRCode.toDataURL(url, {
      width: 350,
      margin: 1,
    });
  } catch {
    qrCodeDataUrl.value = "";
    addToast("QR code unavailable", {
      detail: "Could not generate a QR code for this URL",
      duration: 4000,
      type: ToastType.WARNING,
    });
  } finally {
    isGeneratingQr.value = false;
  }
}

async function captureCanvas(): Promise<File | null> {
  const canvas = document.querySelector(".globe_canvas") as HTMLCanvasElement;
  if (!canvas) {
    return null;
  }
  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject()), "image/png");
    });
    return new File([blob], "data.png", { type: "image/png" });
  } catch {
    return null;
  }
}

async function shareViaAPI(url: string): Promise<boolean> {
  const shareData: ShareData = {
    title: document.title,
    text: "Check out this view from Gridlook!",
    url,
  };

  const canvasFile = await captureCanvas();
  if (canvasFile && navigator.canShare?.({ files: [canvasFile] })) {
    shareData.files = [canvasFile];
  }

  try {
    await navigator.share(shareData);
    return true;
  } catch (err) {
    // User cancelled – don't fall back to clipboard
    return (err as Error).name === "AbortError";
  }
}

async function shareUrl() {
  const url = currentUrl.value || window.location.href;

  // Try native share API first (mobile devices)
  if (navigator.canShare?.({ url })) {
    const handled = await shareViaAPI(url);
    if (handled) {
      close();
      return;
    }
  }

  // Fall back to clipboard
  try {
    await navigator.clipboard.writeText(url);
    addToast("Link copied", {
      detail: "The URL has been copied to your clipboard",
      duration: 4000,
      type: ToastType.SUCCESS,
    });
  } catch {
    addToast("Failed to copy", {
      detail: "Could not copy the URL to clipboard",
      duration: 4000,
      type: ToastType.DANGER,
    });
  }
  close();
}
</script>

<template>
  <PopupDialog
    ref="popupRef"
    v-model:open="dialogOpen"
    dialog-class="share-dialog"
  >
    <template #trigger="{ toggle }">
      <button
        class="button w-100"
        type="button"
        title="Share the current view URL"
        @click.stop="toggle"
      >
        <span class="icon">
          <i class="fa-solid fa-share-nodes"></i>
        </span>
        <span>Share</span>
      </button>
    </template>

    <template #default>
      <p class="dialog-section-label">CURRENT VIEW</p>

      <div class="qr-frame">
        <img
          v-if="qrCodeDataUrl"
          :src="qrCodeDataUrl"
          alt="QR code for the current view URL"
        />
        <div v-else class="qr-placeholder">
          {{
            isGeneratingQr
              ? "Generating QR code..."
              : currentUrl.length > QR_LIMIT
                ? "Too long for a QR code: copy the link instead."
                : "QR code unavailable"
          }}
        </div>
      </div>

      <p class="mb-2 is-size-7">
        Scan to open this exact view on another device.
      </p>
      <p class="has-text-danger is-size-7">
        <strong class="has-text-danger">Warning:</strong> Using the QR-Code may
        incur data roaming charges on mobile devices.
      </p>

      <component :is="ShareSession" v-if="ShareSession" @url="sessionUrl" />

      <hr class="my-2" />
      <div class="is-flex is-justify-content-space-between">
        <button class="button is-small" type="button" @click="close">
          Cancel
        </button>
        <button
          class="button is-small is-primary"
          type="button"
          @click="shareUrl"
        >
          <span class="icon"><i class="fa-solid fa-share-nodes"></i></span>
          <span>Share / Copy</span>
        </button>
      </div>
    </template>
  </PopupDialog>
</template>

<style lang="scss">
.share-dialog {
  width: 300px;

  @media (max-width: 768px) {
    width: calc(100vw - 1rem);
    left: 0.5rem !important;
    right: 0.5rem !important;
    bottom: 0.5rem !important;
  }
}

.share-dialog .qr-frame {
  display: flex;
  align-items: center;
  justify-content: center;
  // min-height: 250px;
  margin-bottom: 0.75rem;
  padding: 0.5rem;
  border-radius: 0.5rem;
  background: white;
}

.share-dialog .qr-frame img {
  display: block;
  width: min(250px, 100%);
  height: auto;
  aspect-ratio: 1 / 1;
}

.share-dialog .qr-placeholder {
  color: var(--bulma-grey);
  font-size: 0.85rem;
  text-align: center;
}
</style>
