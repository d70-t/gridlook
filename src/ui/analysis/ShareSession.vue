<script lang="ts" setup>
import { computed, onMounted, ref, watch } from "vue";

import { openSessionLink, useAnalysisStore } from "@/store/analysisStore.ts";
import { ToastType, useToast } from "@/ui/common/useToast.ts";

/**
 * The plots part of the Share dialog: what the link holds, what it leaves
 * out, and a session file for links too long to send.
 */
const emit = defineEmits<{ url: [url: string] }>();

/** Past this, some mail and chat apps cut or wrap a link. */
const LONG_LINK = 8000;
const FORMAT = "gridlook-session";

const analysis = useAnalysisStore();
const { addToast } = useToast();
const picker = ref<HTMLInputElement | null>(null);
const link = computed(() => analysis.link);

onMounted(() => {
  analysis.writeLink();
  emit("url", location.href);
});
// Opened while a link's plots were still being restored: the address was
// kept as it came; once they are open, the dialog shares the session.
watch(
  () => analysis.restorePending,
  (pending) => {
    if (!pending) {
      analysis.writeLink();
      emit("url", location.href);
    }
  }
);

/**
 * What travels with the link besides settings: imported outlines (their
 * whole coordinates) and the data address's query parameters (which can
 * grant access), named so nothing goes unnoticed.
 */
const travels = computed(() => {
  const shapes = new Map<string, number>();
  for (const w of analysis.windows) {
    const g = w.committed?.geometry;
    // A drawn box's footprint is the user's own drawing, as a polygon is.
    if (g?.kind === "shape" && !g.drawn) {
      const points = g.polygons.flat().reduce((n, ring) => n + ring.length, 0);
      shapes.set(g.name, points);
    }
  }
  let parameters: string[] = [];
  try {
    const resource = location.hash.substring(1).split("::")[0];
    parameters = [...new URL(resource).searchParams.keys()];
  } catch {
    parameters = [];
  }
  return { shapes: [...shapes], parameters };
});

const long = computed(
  () => link.value.tooLong || location.href.length > LONG_LINK
);

function saveFile() {
  const text = JSON.stringify(
    { format: FORMAT, version: 2, link: analysis.sessionLink() },
    null,
    1
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = `gridlook-session-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function openFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) {
    return;
  }
  try {
    const parsed = JSON.parse(await file.text()) as {
      format?: string;
      link?: string;
    };
    if (parsed.format !== FORMAT || typeof parsed.link !== "string") {
      throw new Error("not a session file");
    }
    if (!openSessionLink(parsed.link)) {
      addToast("Session too large to open here", {
        detail: "This browser could not keep its plots while the page reloads.",
        duration: 6000,
        type: ToastType.WARNING,
      });
    }
  } catch {
    addToast("Not a session file", {
      detail: `${file.name} is not a Gridlook session file.`,
      duration: 5000,
      type: ToastType.WARNING,
    });
  }
}
</script>

<template>
  <div class="share-session is-size-7 mt-2">
    <p v-if="link.plots" class="mb-1">
      {{ link.plots }} plot{{ link.plots === 1 ? "" : "s" }} included, with
      their settings and places. Each reopens and reads its data again.
    </p>
    <p v-if="link.plots && travels.shapes.length" class="mb-1 has-text-grey">
      It carries the whole outline of
      {{
        travels.shapes
          .map(
            ([name, points]) =>
              `“${name}” (${points.toLocaleString("en-US")} points)`
          )
          .join(", ")
      }}.
    </p>
    <p v-if="travels.parameters.length" class="mb-1 has-text-warning-dark">
      The data address includes the parameter{{
        travels.parameters.length === 1 ? "" : "s"
      }}
      {{ travels.parameters.join(", ") }}, which may grant access to the data:
      anyone with the link has
      {{ travels.parameters.length === 1 ? "it" : "them" }}.
    </p>
    <p v-if="link.edited" class="mb-1 has-text-grey">
      Edits not yet applied ({{ link.edited }}) are not in the link.
    </p>
    <p v-if="link.leftOut.length" class="mb-1 has-text-grey">
      Not included: {{ link.leftOut.join(", ") }}.
    </p>
    <p v-if="link.tooLong" class="mb-1 has-text-danger">
      Too many plots for a link: it holds the map only. Save a session file to
      keep them.
    </p>
    <p v-else-if="long" class="mb-1 has-text-warning-dark">
      A long link: some mail and chat apps may cut it. A session file is safer.
    </p>
    <div class="share-session-buttons">
      <button
        v-if="link.plots"
        class="button is-small"
        type="button"
        @click="saveFile"
      >
        Save session file
      </button>
      <button class="button is-small" type="button" @click="picker?.click()">
        Open session file…
      </button>
      <input
        ref="picker"
        class="is-hidden"
        type="file"
        accept=".json,application/json"
        @change="openFile"
      />
    </div>
  </div>
</template>

<style>
.share-session-buttons {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.4rem;
}
</style>
