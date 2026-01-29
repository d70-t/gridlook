<script lang="ts" setup>
import { useToast } from "primevue/usetoast";
const toast = useToast();

async function shareViaAPI(url: string) {
  let canvasFile: File | null = null;

  // Capture canvas if requested
  const canvas = document.querySelector(".globe_canvas") as HTMLCanvasElement;
  if (canvas) {
    try {
      // Convert canvas to blob
      const canvasBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("Canvas conversion failed"));
          }
        }, "image/png");
      });

      // Create a File object for sharing
      canvasFile = new File([canvasBlob], "data.png", {
        type: "image/png",
      });
    } catch {
      // Ignore errors in capturing canvas
    }
  }

  try {
    const shareData: ShareData = {
      title: document.title,
      text: "Check out this view from Gridlook!",
      url: url,
    };

    // Add file if canvas was captured and sharing files is supported
    if (
      canvasFile &&
      navigator.canShare &&
      navigator.canShare({ files: [canvasFile] })
    ) {
      shareData.files = [canvasFile];
    }

    await navigator.share(shareData);
    return true; // Success
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return true; // User cancelled - don't fall back to clipboard
    }
    return false; // Share failed - allow fallback to clipboard
  }
}

async function shareUrl() {
  const url = window.location.href;

  // Try native share API first (mobile devices)
  if (navigator.canShare && navigator.canShare({ url })) {
    const shareSucceeded = await shareViaAPI(url);
    if (shareSucceeded) {
      return;
    }
    // If share failed (not cancelled), fall through to clipboard
  }

  // Fall back to clipboard (URL only)
  try {
    await navigator.clipboard.writeText(url);
    toast.add({
      summary: "Link copied",
      detail: "The URL has been copied to your clipboard",
      severity: "success",
      life: 4000,
    });
  } catch {
    toast.add({
      summary: "Failed to copy",
      detail: "Could not copy the URL to clipboard",
      severity: "error",
      life: 4000,
    });
  }
}
</script>

<template>
  <button
    class="button"
    type="button"
    title="Share the current view URL"
    @click="shareUrl"
  >
    <span class="icon">
      <i class="fa-solid fa-share-nodes"></i>
    </span>
    <span> Share </span>
  </button>
</template>
