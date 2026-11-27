<script lang="ts" setup>
/**
 * Handles on the shape of the plot being edited: drag a box's corners or
 * edges, a polygon's or path's points (the small + between two adds one),
 * or a point. A point is selected by clicking it: it is ringed and
 * numbered, and is deleted with "Delete point N" in the edit bar, the
 * Delete key, or its own menu (right-click, or a long press on a touch
 * screen), as map drawing tools do (Mapbox GL Draw, Google Maps). The
 * arrow keys move a focused handle by 0.5° (Shift: 0.1°). Every move goes
 * to the plot's draft: its dashed outline follows, nothing is read.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import {
  dragBox,
  dragStartLon,
  editHandles,
  followLon,
  followPointer,
  insertedHandle,
  keyedBox,
  moveHandle,
  nudged,
  removeVertex,
  type THandle,
  type TKeyDrag,
} from "@/lib/analysis/shapeEdit.ts";
import type { TLatLon } from "@/lib/analysis/sphere.ts";
import { GEOMETRY_KINDS, type TGeometry } from "@/lib/analysis/types.ts";
import { useAnalysisStore } from "@/store/analysisStore.ts";
import {
  getMapScene,
  mapFrame,
} from "@/ui/grids/composables/useMapInteraction.ts";
import { formatValue } from "@/utils/formatValue.ts";

const analysis = useAnalysisStore();
const box = ref<HTMLDivElement>();
const plot = computed(() =>
  analysis.windows.find((w) => w.id === analysis.shapeEdit?.id)
);
const geometry = computed(() => plot.value?.draft.geometry);
/** The point selected (its index), kept with the edit. */
const chosen = computed({
  get: () => analysis.shapeEdit?.selected,
  set: (index) => analysis.selectEditPoint(index),
});
/** The point whose menu is open (right-click or a long press). */
const menuFor = ref<{ index: number; x: number; y: number; label: string }>();
let pressTimer: ReturnType<typeof setTimeout> | undefined;
/** The handle being dragged. */
let dragging: THandle | undefined;
/** A box side's drag: the box when it began, the pointer's longitude. */
let boxDrag:
  | {
      start: Extract<TGeometry, { kind: typeof GEOMETRY_KINDS.BOX }>;
      lon: number;
      /** The pointer's last screen position: the path is followed. */
      from?: { x: number; y: number };
    }
  | undefined;

const placed = computed(() => {
  void mapFrame.value;
  const origin = box.value?.getBoundingClientRect();
  const scene = getMapScene();
  if (!geometry.value || !origin || !scene) {
    return [];
  }
  return editHandles(geometry.value).flatMap((handle) => {
    const p = scene.project(handle.lat, handle.lon);
    return p?.visible
      ? [{ handle, x: p.x - origin.left, y: p.y - origin.top }]
      : [];
  });
});

const place = (h: TLatLon) =>
  `${formatValue(Math.abs(h.lat))}° ${h.lat >= 0 ? "N" : "S"}, ${formatValue(Math.abs(h.lon))}° ${h.lon >= 0 ? "E" : "W"}`;

function move(handle: THandle, to: TLatLon) {
  const id = plot.value?.id;
  if (id && geometry.value) {
    analysis.updateDraft(id, {
      geometry: moveHandle(geometry.value, handle, to),
    });
  }
}

function down(event: PointerEvent, handle: THandle) {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  dragging = handle;
  forgetKeys();
  // A box side is dragged from the box as it was (see dragBox).
  const g = geometry.value;
  boxDrag =
    g?.kind === GEOMETRY_KINDS.BOX && handle.sides?.length
      ? {
          start: g,
          lon: dragStartLon(g, handle),
          from: { x: event.clientX, y: event.clientY },
        }
      : undefined;
  menuFor.value = undefined;
  chosen.value = handle.role === "vertex" ? handle.index : undefined;
  // A long press without moving opens the point's menu (touch screens
  // have no right-click).
  clearTimeout(pressTimer);
  if (event.pointerType !== "mouse" && handle.role === "vertex") {
    const target = event.currentTarget as HTMLElement;
    pressTimer = setTimeout(() => openMenu(handle, target), 550);
  }
}

/** The menu of one point: right beside it, naming it. */
function openMenu(handle: THandle, target: HTMLElement) {
  if (handle.role !== "vertex" || handle.index === undefined) {
    return;
  }
  const origin = box.value?.getBoundingClientRect();
  const at = target.getBoundingClientRect();
  chosen.value = handle.index;
  menuFor.value = {
    index: handle.index,
    label: handle.label,
    x: at.left + at.width / 2 - (origin?.left ?? 0),
    y: at.top + at.height / 2 - (origin?.top ?? 0),
  };
}
function contextMenu(event: MouseEvent, handle: THandle) {
  if (handle.role !== "vertex") {
    return;
  }
  event.preventDefault();
  dragging = undefined;
  openMenu(handle, event.currentTarget as HTMLElement);
}

function drag(event: PointerEvent) {
  if (!dragging) {
    return;
  }
  const at = getMapScene()?.pick(event.clientX, event.clientY);
  if (at) {
    clearTimeout(pressTimer);
    const id = plot.value?.id;
    if (boxDrag && id && dragging.sides) {
      const scene = getMapScene();
      const to = { x: event.clientX, y: event.clientY };
      boxDrag.lon =
        boxDrag.from && scene
          ? followPointer(
              boxDrag.lon,
              boxDrag.from,
              to,
              (x, y) => scene.pick(x, y) ?? undefined
            )
          : followLon(boxDrag.lon, at.lon);
      boxDrag.from = to;
      analysis.updateDraft(id, {
        geometry: dragBox(boxDrag.start, dragging.sides, at.lat, boxDrag.lon),
      });
      return;
    }
    move(dragging, at);
    // An added point is dragged on as the point it became.
    if (dragging.role === "insert") {
      dragging = insertedHandle(dragging);
      chosen.value = dragging.index;
    } else {
      dragging = { ...dragging, ...at };
    }
  }
}

function up() {
  dragging = undefined;
  boxDrag = undefined;
  clearTimeout(pressTimer);
}

function remove(index: number) {
  chosen.value = index;
  analysis.deleteEditPoint();
  menuFor.value = undefined;
}

const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [1, 0],
  ArrowDown: [-1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};
/** A box side moved by keys since its first press (see keyedBox). */
let keyDrag: TKeyDrag | undefined;
/** Another handle, a pointer or leaving: the next press starts afresh. */
function forgetKeys() {
  keyDrag = undefined;
}
function key(event: KeyboardEvent, handle: THandle) {
  const arrow = ARROWS[event.key];
  if (!arrow) {
    return;
  }
  event.preventDefault();
  const step = event.shiftKey ? 0.1 : 0.5;
  const g = geometry.value;
  const id = plot.value?.id;
  if (id && g?.kind === GEOMETRY_KINDS.BOX && handle.sides?.length) {
    const next = keyedBox(keyDrag, g, handle, arrow[0] * step, arrow[1] * step);
    keyDrag = next.drag;
    analysis.updateDraft(id, { geometry: next.box });
    return;
  }
  move(handle, nudged(handle, arrow[0] * step, arrow[1] * step));
}

// Escape closes a point's menu, then leaves the shape as it was (as
// Cancel); Delete or Backspace deletes the selected point, wherever focus
// is (not while typing in a field).
function escape(event: KeyboardEvent) {
  const typing = (event.target as HTMLElement | null)?.closest?.(
    "input, textarea, select, [contenteditable]"
  );
  if (event.key === "Escape") {
    if (menuFor.value) {
      menuFor.value = undefined;
      return;
    }
    analysis.endShapeEdit(false);
  } else if (
    (event.key === "Delete" || event.key === "Backspace") &&
    !typing &&
    chosen.value !== undefined
  ) {
    event.preventDefault();
    analysis.deleteEditPoint();
  }
}
onBeforeUnmount(() => clearTimeout(pressTimer));
onMounted(() => window.addEventListener("keydown", escape));
onBeforeUnmount(() => window.removeEventListener("keydown", escape));

/** Whether the chosen point can go (an area keeps 3, a path 2). */
const removable = computed(
  () =>
    chosen.value !== undefined &&
    geometry.value !== undefined &&
    removeVertex(geometry.value, chosen.value) !== undefined
);
</script>

<template>
  <div ref="box" class="shape-editor">
    <template v-for="item in placed" :key="item.handle.key">
      <button
        type="button"
        class="shape-handle"
        :class="[
          item.handle.role,
          {
            chosen:
              item.handle.role === 'vertex' && item.handle.index === chosen,
          },
        ]"
        :style="{ left: `${item.x}px`, top: `${item.y}px` }"
        :aria-label="`${item.handle.label}, ${place(item.handle)}`"
        :title="`${item.handle.label}: ${place(item.handle)}${item.handle.role === 'insert' ? '' : ' (drag, or arrow keys)'}`"
        :data-handle="item.handle.key"
        @pointerdown="down($event, item.handle)"
        @contextmenu="contextMenu($event, item.handle)"
        @pointermove="drag"
        @pointerup="up"
        @pointercancel="up"
        @focus="
          chosen = item.handle.role === 'vertex' ? item.handle.index : chosen
        "
        @keydown="key($event, item.handle)"
        @blur="forgetKeys"
      >
        <i
          v-if="item.handle.role === 'insert'"
          class="fa-solid fa-plus"
          aria-hidden="true"
        ></i>
      </button>
      <!-- The selected point's number: which one a deletion removes. -->
      <span
        v-if="item.handle.role === 'vertex' && item.handle.index === chosen"
        class="shape-chosen-label"
        :style="{ left: `${item.x}px`, top: `${item.y - 20}px` }"
        aria-hidden="true"
        >{{ item.handle.label }}</span
      >
    </template>
    <div
      v-if="menuFor"
      class="shape-menu"
      role="menu"
      :style="{ left: `${menuFor.x + 14}px`, top: `${menuFor.y - 14}px` }"
      @pointerdown.stop
    >
      <button
        type="button"
        role="menuitem"
        data-delete-point
        :disabled="!removable"
        :title="
          removable
            ? `Delete ${menuFor.label} (Delete key)`
            : 'An area keeps at least 3 points, a path 2'
        "
        @click="remove(menuFor.index)"
      >
        <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
        Delete {{ menuFor.label.toLowerCase() }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.shape-editor {
  position: absolute;
  inset: 0;
  z-index: 6;
  pointer-events: none;
}
.shape-handle {
  position: absolute;
  transform: translate(-50%, -50%);
  pointer-events: auto;
  touch-action: none;
  padding: 0;
  cursor: grab;
}
.shape-handle {
  width: 14px;
  height: 14px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: #2563eb;
  box-shadow:
    0 0 0 1px rgba(15, 23, 42, 0.6),
    0 1px 4px rgba(0, 0, 0, 0.4);
}
.shape-handle.corner {
  border-radius: 3px;
}
.shape-handle.edge {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background: #fff;
  border-color: #2563eb;
}
.shape-handle.insert {
  width: 16px;
  height: 16px;
  border: 1px dashed #fff;
  background: rgba(37, 99, 235, 0.55);
  color: #fff;
  font-size: 9px;
  opacity: 0.8;
  cursor: copy;
}
.shape-handle.insert:hover {
  opacity: 1;
}
/* The selected point: larger, ringed, numbered above. */
.shape-handle.chosen {
  width: 18px;
  height: 18px;
  background: #f59e0b;
  box-shadow:
    0 0 0 3px rgba(245, 158, 11, 0.45),
    0 1px 4px rgba(0, 0, 0, 0.4);
}
.shape-chosen-label {
  position: absolute;
  transform: translate(-50%, -100%);
  padding: 0 6px;
  border-radius: 4px;
  background: #f59e0b;
  color: #111827;
  font-size: 0.68rem;
  font-weight: 700;
  white-space: nowrap;
  pointer-events: none;
}
.shape-menu {
  position: absolute;
  pointer-events: auto;
  padding: 3px;
  border: 1px solid var(--plot-border);
  border-radius: 6px;
  background: var(--plot-bg);
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.35);
}
.shape-menu button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--plot-danger);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  white-space: nowrap;
}
.shape-menu button:hover:not(:disabled) {
  background: var(--plot-hover);
}
.shape-menu button:disabled {
  color: var(--plot-muted);
  cursor: not-allowed;
}
.shape-handle:focus-visible {
  outline: 3px solid #f59e0b;
  outline-offset: 2px;
}
.shape-handle:active {
  cursor: grabbing;
}
/* A finger needs a larger target; the dot stays the same size inside. */
@media (pointer: coarse) {
  .shape-handle {
    width: 22px;
    height: 22px;
  }
  .shape-handle.insert {
    width: 24px;
    height: 24px;
  }
  .shape-handle::after {
    content: "";
    position: absolute;
    inset: -11px;
  }
  .shape-handle.chosen {
    width: 24px;
    height: 24px;
  }
  .shape-menu button {
    min-height: 32px;
  }
}
</style>
