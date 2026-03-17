import { drawText as canvasTxtDrawText } from "canvas-txt";
import type { Dayjs } from "dayjs";
import * as THREE from "three";
import type { Ref } from "vue";

import type { TColorMap } from "@/lib/shaders/colormapShaders.ts";
import { makeCompressedColormapLutMaterial } from "@/lib/shaders/gridShaders.ts";
import {
  DEFAULT_SNAPSHOT_OPTIONS,
  type TSnapshotBackground,
  type TSnapshotOptions,
} from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
type UseGridSnapshotOptions = {
  canvas: Ref<HTMLCanvasElement | undefined>;
  getRenderer: () => THREE.WebGLRenderer | undefined;
  getScene: () => THREE.Scene | undefined;
  getCamera: () => THREE.PerspectiveCamera | undefined;
  getBaseSurface: () => THREE.Mesh | undefined;
  render: () => boolean;
};

/* eslint-disable-next-line max-lines-per-function */
export function useGridSnapshot(deps: UseGridSnapshotOptions) {
  const { canvas, getRenderer, getScene, getCamera, getBaseSurface, render } =
    deps;
  const store = useGlobeControlStore();

  /** Render a horizontal colormap gradient to an off-screen canvas. */
  function renderColormapGradient(
    colormapName: TColorMap,
    addOffset: 0 | 1,
    scaleFactor: 1 | -1,
    posterizeLevels: number,
    w: number,
    h: number
  ): HTMLCanvasElement | null {
    try {
      const offCanvas = document.createElement("canvas");
      offCanvas.width = Math.max(1, Math.round(w));
      offCanvas.height = Math.max(1, Math.round(h));
      const geometry = new THREE.PlaneGeometry(2, 2);
      geometry.setAttribute(
        "data_value",
        new THREE.BufferAttribute(Float32Array.from([0, 1, 0, 1]), 1)
      );
      const material = makeCompressedColormapLutMaterial(
        colormapName,
        addOffset,
        scaleFactor
      );
      material.uniforms.posterizeLevels.value = posterizeLevels;
      material.uniforms.selLow.value = 0.0;
      material.uniforms.selHigh.value = 1.0;
      const cmScene = new THREE.Scene();
      const cmCamera = new THREE.PerspectiveCamera(7.5, w / h, 0.1, 1000);
      cmScene.add(new THREE.Mesh(geometry, material));
      cmScene.add(cmCamera);
      const cmRenderer = new THREE.WebGLRenderer({ canvas: offCanvas });
      cmRenderer.setSize(offCanvas.width, offCanvas.height, false);
      cmRenderer.render(cmScene, cmCamera);
      geometry.dispose();
      material.dispose();
      cmRenderer.dispose();
      return offCanvas;
    } catch {
      return null;
    }
  }

  /** Simple numeric formatter for snapshot value labels. */
  function formatSnapValue(v: number): string {
    if (!Number.isFinite(v)) {
      return String(v);
    }
    if (Math.abs(v) >= 1e6 || (Math.abs(v) !== 0 && Math.abs(v) < 1e-3)) {
      return v.toExponential(2);
    }
    return parseFloat(v.toPrecision(4)).toString();
  }

  /**
   * Read pixels from a WebGL render target, flip Y (WebGL bottom-left →
   * canvas top-left), write into ctx at (0,0), and dispose the target.
   */
  function blitRtToCtx(
    ctx: CanvasRenderingContext2D,
    rt: THREE.WebGLRenderTarget,
    w: number,
    h: number
  ) {
    const renderer = getRenderer()!;
    const pixelData = new Uint8Array(4 * w * h);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, pixelData);
    rt.dispose();
    const flipped = new Uint8ClampedArray(4 * w * h);
    for (let row = 0; row < h; row++) {
      const srcRow = h - 1 - row;
      flipped.set(
        pixelData.subarray(srcRow * w * 4, (srcRow + 1) * w * 4),
        row * w * 4
      );
    }
    const imgData = ctx.createImageData(w, h);
    imgData.data.set(flipped);
    ctx.putImageData(imgData, 0, 0);
  }

  function renderGlobeToCtx(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    background: TSnapshotBackground
  ) {
    const renderer = getRenderer();
    const scene = getScene();
    const camera = getCamera();
    const baseSurface = getBaseSurface();
    if (!renderer || !scene || !camera) {
      return;
    }
    if (background === "black") {
      render();
      ctx.drawImage(canvas.value!, 0, 0);
      return;
    }
    const rt = new THREE.WebGLRenderTarget(w, h);
    if (background === "transparent") {
      const origVisible = baseSurface ? baseSurface.visible : true;
      if (baseSurface) {
        baseSurface.visible = false;
      }
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x000000, 1);
      if (baseSurface) {
        baseSurface.visible = origVisible;
      }
    } else {
      const mat = baseSurface?.material as THREE.MeshBasicMaterial | undefined;
      const origColor = mat ? mat.color.getHex() : null;
      renderer.setClearColor(0xffffff, 1);
      if (mat) {
        mat.color.set(0xffffff);
      }
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x000000, 1);
      if (mat && origColor !== null) {
        mat.color.setHex(origColor);
      }
    }
    blitRtToCtx(ctx, rt, w, h);
    render(); // restore live canvas
  }

  /** Collect dimension value strings for the info overlay. */
  function buildSnapshotInfoLines(showDatasetInfo: boolean): {
    datasetTitle: string | null;
    lines: string[];
  } {
    if (!showDatasetInfo) {
      return { datasetTitle: null, lines: [] };
    }
    const lines: string[] = [];
    const datasetTitle = store.datasetTitle
      ? `Dataset: ${store.datasetTitle}`
      : null;
    const varname =
      store.varinfo?.attrs?.long_name ??
      store.varinfo?.attrs?.standard_name ??
      store.varnameDisplay;
    let units = store.varinfo?.attrs?.units ? store.varinfo.attrs.units : "";

    if (units === "1") {
      units = "";
    }

    lines.push(`Variable: ${varname}` + (units ? ` (${units})` : ""));
    const vi = store.varinfo;
    if (!vi) {
      return { datasetTitle, lines };
    }
    for (let i = 0; i < vi.dimRanges.length; i++) {
      const range = vi.dimRanges[i];
      const dimInfo = vi.dimInfo[i];
      if (!range || !dimInfo || !("current" in dimInfo)) {
        continue;
      }
      if (!range.maxBound) {
        continue;
      }
      const val = dimInfo.current;
      const isObj = val && typeof val === "object";
      const hasFormat = isObj && typeof (val as Dayjs).format === "function";
      const valStr = hasFormat
        ? (val as Dayjs).format("YYYY-MM-DD HH:mm")
        : String(val);
      const units =
        "units" in dimInfo && dimInfo.units ? ` ${dimInfo.units}` : "";
      lines.push(`${range.name}: ${valStr}${units}`);
    }
    return { datasetTitle, lines };
  }

  /** Draw colormap gradient bar + value labels onto the composite canvas. */
  function drawColormapSection(
    ctx: CanvasRenderingContext2D,
    w: number,
    y: number,
    margin: number,
    barHeight: number,
    labelFontSize: number,
    textColor: string
  ) {
    const cmWidth = w - 2 * margin;
    const cmCanvas = renderColormapGradient(
      store.colormap,
      store.invertColormap ? 1 : 0,
      store.invertColormap ? -1 : 1,
      store.posterizeLevels,
      cmWidth,
      barHeight
    );
    if (cmCanvas) {
      ctx.drawImage(cmCanvas, margin, y, cmWidth, barHeight);
    }
    ctx.fillStyle = textColor;
    ctx.font = `${labelFontSize}px sans-serif`;
    ctx.textBaseline = "top";
    const sel = store.selection as { low?: number; high?: number };
    if (sel.low !== undefined && sel.high !== undefined) {
      ctx.textAlign = "left";
      ctx.fillText(formatSnapValue(sel.low), margin, y + barHeight + 3);
      ctx.textAlign = "right";
      ctx.fillText(formatSnapValue(sel.high), w - margin, y + barHeight + 3);
    }
  }

  /** Draw overlays (colormap bar + info text) onto the composite canvas, then trigger download. */
  /* eslint-disable-next-line max-lines-per-function */
  function drawOverlaysAndDownload(
    composite: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    showColormap: boolean,
    datasetTitle: string | null,
    infoLines: string[],
    margin: number,
    cmBarH: number,
    cmLabelH: number,
    infoLineH: number,
    fontSize: number,
    textColor: string
  ) {
    let currentY = h + margin;
    if (showColormap) {
      drawColormapSection(
        ctx,
        w,
        currentY,
        margin,
        cmBarH,
        Math.round(fontSize * 0.85),
        textColor
      );
      currentY += cmBarH + cmLabelH;
    }
    if (datasetTitle !== null) {
      const maxWidth = w - 2 * margin;
      const { height: titleHeight } = canvasTxtDrawText(ctx, datasetTitle, {
        x: margin,
        y: currentY,
        width: maxWidth,
        height: infoLineH * 10,
        fontSize,
        align: "left",
        vAlign: "top",
        lineHeight: infoLineH,
      });
      currentY += titleHeight + Math.round(infoLineH * 0.2);
    }
    if (infoLines.length > 0) {
      ctx.fillStyle = textColor;
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      for (const line of infoLines) {
        ctx.fillText(line, margin, currentY);
        currentY += infoLineH;
      }
    }
    composite.toBlob((blob) => {
      const link = document.createElement("a");
      link.download = "gridlook.png";
      link.href = URL.createObjectURL(blob!);
      link.click();
      URL.revokeObjectURL(link.href);
    }, "image/png");
  }

  function fillBackground(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    backgroundColor: TSnapshotBackground
  ) {
    if (backgroundColor === "white") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
    } else if (backgroundColor === "black") {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);
    }
  }

  /* eslint-disable-next-line max-lines-per-function */
  function makeSnapshot(options: TSnapshotOptions = DEFAULT_SNAPSHOT_OPTIONS) {
    const glCanvas = canvas.value;
    if (!glCanvas || !getRenderer() || !getScene() || !getCamera()) {
      return;
    }
    const w = glCanvas.width;
    const h = glCanvas.height;
    const { background, showDatasetInfo, showColormap } = options;

    const fontSize = Math.round(Math.max(13, h * 0.022));
    const MARGIN = Math.round(Math.max(10, h * 0.018));
    const CM_BAR_HEIGHT = Math.round(Math.max(18, h * 0.032));
    const CM_LABEL_HEIGHT = Math.round(fontSize * 1.8);
    const INFO_LINE_HEIGHT = Math.round(fontSize * 1.5);
    const textColor = background === "white" ? "#000000" : "#ffffff";

    const { datasetTitle, lines: infoLines } =
      buildSnapshotInfoLines(showDatasetInfo);

    // Estimate wrapped title height to size the composite canvas correctly.
    const maxTextWidth = w - 2 * MARGIN;
    let titleLines = 1;
    if (datasetTitle) {
      const measCanvas = document.createElement("canvas");
      const measCtx = measCanvas.getContext("2d")!;
      measCtx.font = `${fontSize}px sans-serif`;
      const titleWidth = measCtx.measureText(datasetTitle).width;
      titleLines = Math.max(1, Math.ceil(titleWidth / maxTextWidth));
    }
    const titleHeight = datasetTitle
      ? titleLines * INFO_LINE_HEIGHT + Math.round(INFO_LINE_HEIGHT * 0.2)
      : 0;

    const extraHeight =
      (showColormap ? CM_BAR_HEIGHT + CM_LABEL_HEIGHT + MARGIN : 0) +
      (datasetTitle !== null || infoLines.length > 0 ? MARGIN : 0) +
      (datasetTitle !== null ? titleHeight : 0) +
      (infoLines.length > 0 ? infoLines.length * INFO_LINE_HEIGHT : 0) +
      (datasetTitle !== null || infoLines.length > 0 ? MARGIN : 0);

    const composite = document.createElement("canvas");
    composite.width = w;
    composite.height = h + extraHeight;
    const ctx = composite.getContext("2d")!;

    fillBackground(ctx, w, h + extraHeight, background);
    renderGlobeToCtx(ctx, w, h, background);
    drawOverlaysAndDownload(
      composite,
      ctx,
      w,
      h,
      showColormap,
      datasetTitle,
      infoLines,
      MARGIN,
      CM_BAR_HEIGHT,
      CM_LABEL_HEIGHT,
      INFO_LINE_HEIGHT,
      fontSize,
      textColor
    );
  }

  return { makeSnapshot };
}
