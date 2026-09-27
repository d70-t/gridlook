import { drawText as canvasTxtDrawText, splitText } from "canvas-txt";
import type { Dayjs } from "dayjs";
import * as THREE from "three";
import type { Ref } from "vue";

import { GLOBE_AUTO_ROTATE_SPEED } from "@/lib/camera/OrbitControlsAddOn.ts";
import {
  formatTimeCoordinate,
  isTimeCoordinate,
  isTimeUnits,
} from "@/lib/data/timeHandling.ts";
import type { TColorMap } from "@/lib/shaders/colormapShaders.ts";
import { makeCompressedColormapLutMaterial } from "@/lib/shaders/gridShaders.ts";
import {
  DEFAULT_SNAPSHOT_OPTIONS,
  SnapshotBackgrounds,
  SnapshotOverlayPositions,
  type TSnapshotBackground,
  type TSnapshotOptions,
} from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";

type TUseGridSnapshotOptions = {
  canvas: Ref<HTMLCanvasElement | undefined>;
  getRenderer: () => THREE.WebGLRenderer | undefined;
  getScene: () => THREE.Scene | undefined;
  getCamera: () => THREE.PerspectiveCamera | undefined;
  getBaseSurface: () => THREE.Mesh | undefined;
  render: () => boolean;
};

type TSnapshotRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const FLAT_BACKGROUND_SCALE = 1.05;
const GLOBE_SNAPSHOT_RADIUS = 1;

function getFullSnapshotRect(w: number, h: number): TSnapshotRect {
  return { x: 0, y: 0, width: w, height: h };
}

function clampSnapshotRect(
  rect: TSnapshotRect,
  w: number,
  h: number
): TSnapshotRect {
  const x1 = Math.max(0, Math.min(w, Math.floor(rect.x)));
  const y1 = Math.max(0, Math.min(h, Math.floor(rect.y)));
  const x2 = Math.max(0, Math.min(w, Math.ceil(rect.x + rect.width)));
  const y2 = Math.max(0, Math.min(h, Math.ceil(rect.y + rect.height)));

  if (x2 <= x1 || y2 <= y1) {
    return getFullSnapshotRect(w, h);
  }

  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function getProjectedPointsRect(
  points: THREE.Vector3[],
  camera: THREE.PerspectiveCamera,
  w: number,
  h: number
) {
  const projectedPoints = points.map((point) => point.clone().project(camera));
  const xs = projectedPoints.map((point) => ((point.x + 1) / 2) * w);
  const ys = projectedPoints.map((point) => ((1 - point.y) / 2) * h);

  return clampSnapshotRect(
    {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    },
    w,
    h
  );
}

function getSnapshotContentRect(
  camera: THREE.PerspectiveCamera,
  baseSurface: THREE.Mesh | undefined,
  w: number,
  h: number
): TSnapshotRect {
  if (!baseSurface) {
    return getFullSnapshotRect(w, h);
  }

  camera.updateMatrixWorld(true);
  baseSurface.updateWorldMatrix(true, false);

  const plane = baseSurface.geometry as THREE.PlaneGeometry;
  if (plane.parameters?.width && plane.parameters?.height) {
    const halfWidth = plane.parameters.width / (2 * FLAT_BACKGROUND_SCALE);
    const halfHeight = plane.parameters.height / (2 * FLAT_BACKGROUND_SCALE);
    const points = [
      new THREE.Vector3(-halfWidth, -halfHeight, 0),
      new THREE.Vector3(halfWidth, -halfHeight, 0),
      new THREE.Vector3(halfWidth, halfHeight, 0),
      new THREE.Vector3(-halfWidth, halfHeight, 0),
    ].map((point) => point.applyMatrix4(baseSurface.matrixWorld));

    return getProjectedPointsRect(points, camera, w, h);
  }

  const center = new THREE.Vector3().setFromMatrixPosition(
    baseSurface.matrixWorld
  );
  const distance = camera.position.distanceTo(center);
  if (distance <= GLOBE_SNAPSHOT_RADIUS) {
    return getFullSnapshotRect(w, h);
  }

  const centerProjected = center.clone().project(camera);
  const angularRadius = Math.asin(GLOBE_SNAPSHOT_RADIUS / distance);
  const vHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const hHalfFov = Math.atan(Math.tan(vHalfFov) * camera.aspect);
  const halfWidth = (Math.tan(angularRadius) / Math.tan(hHalfFov)) * (w / 2);
  const halfHeight = (Math.tan(angularRadius) / Math.tan(vHalfFov)) * (h / 2);
  const centerX = ((centerProjected.x + 1) / 2) * w;
  const centerY = ((1 - centerProjected.y) / 2) * h;

  return clampSnapshotRect(
    {
      x: centerX - halfWidth,
      y: centerY - halfHeight,
      width: halfWidth * 2,
      height: halfHeight * 2,
    },
    w,
    h
  );
}

/* eslint-disable-next-line max-lines-per-function */
export function useGridSnapshot(deps: TUseGridSnapshotOptions) {
  const { canvas, getRenderer, getScene, getCamera, getBaseSurface, render } =
    deps;
  const { logError } = useLog();
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
      try {
        cmRenderer.setSize(offCanvas.width, offCanvas.height, false);
        cmRenderer.render(cmScene, cmCamera);
        // Keep a 2D copy: WebGL's drawing buffer can be discarded between frames.
        const gradient = document.createElement("canvas");
        gradient.width = offCanvas.width;
        gradient.height = offCanvas.height;
        gradient.getContext("2d")!.drawImage(offCanvas, 0, 0);
        return gradient;
      } finally {
        geometry.dispose();
        material.dispose();
        cmRenderer.dispose();
        cmRenderer.forceContextLoss();
      }
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

  // Reuse the render target and readback storage for a whole video sequence.
  // eslint-disable-next-line max-lines-per-function
  function createGlobeRenderer(
    width: number,
    height: number,
    background: TSnapshotBackground
  ) {
    const renderer = getRenderer()!;
    const scene = getScene()!;
    const camera = getCamera()!.clone();
    const position = camera.position.clone();
    const orientation = camera.quaternion.clone();
    const rotation = new THREE.Quaternion();
    const baseSurface = getBaseSurface();
    // Grid shaders already output display colors; avoid encoding them twice.
    const target = new THREE.WebGLRenderTarget(width, height);
    const pixels = new Uint8Array(4 * width * height);
    let image: ImageData | undefined;
    let disposed = false;
    return {
      dispose() {
        disposed = true;
        target.dispose();
        image = undefined;
      },
      render(ctx: CanvasRenderingContext2D, rotationSeconds = 0) {
        if (disposed) {
          throw new Error("The frame renderer has been released.");
        }
        // Evaluate from the initial pose, never from the previous encoded frame.
        rotation.setFromAxisAngle(
          camera.up,
          (-rotationSeconds * GLOBE_AUTO_ROTATE_SPEED * 2 * Math.PI) / 60
        );
        camera.position.copy(position).applyQuaternion(rotation);
        camera.quaternion.copy(orientation).premultiply(rotation);
        const clearColor = renderer.getClearColor(new THREE.Color());
        const clearAlpha = renderer.getClearAlpha();
        const previousTarget = renderer.getRenderTarget();
        const visible = baseSurface?.visible;
        const material = baseSurface?.material as
          THREE.MeshBasicMaterial | undefined;
        const color = material?.color.getHex();
        try {
          if (background === SnapshotBackgrounds.TRANSPARENT && baseSurface) {
            baseSurface.visible = false;
          } else if (background === SnapshotBackgrounds.WHITE && material) {
            material.color.set(0xffffff);
          }
          renderer.setClearColor(
            background === SnapshotBackgrounds.WHITE ? 0xffffff : 0,
            background === SnapshotBackgrounds.TRANSPARENT ? 0 : 1
          );
          renderer.setRenderTarget(target);
          renderer.render(scene, camera);
          renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
        } finally {
          renderer.setRenderTarget(previousTarget);
          renderer.setClearColor(clearColor, clearAlpha);
          if (baseSurface && visible !== undefined) {
            baseSurface.visible = visible;
          }
          if (material && color !== undefined) {
            material.color.setHex(color);
          }
        }
        image ??= ctx.createImageData(width, height);
        for (let row = 0; row < height; row++) {
          const source = (height - 1 - row) * width * 4;
          image.data.set(
            pixels.subarray(source, source + width * 4),
            row * width * 4
          );
        }
        ctx.putImageData(image, 0, 0);
      },
    };
  }

  function getSnapshotDimensions(
    glCanvas: HTMLCanvasElement,
    requestedScale: TSnapshotOptions["resolutionScale"]
  ) {
    const renderer = getRenderer();
    const maxTextureSize = renderer?.capabilities.maxTextureSize ?? Infinity;
    const maxScale = Math.max(
      1,
      Math.min(
        maxTextureSize / glCanvas.width,
        maxTextureSize / glCanvas.height
      )
    );
    const safeScale = Math.max(1, Math.min(requestedScale, maxScale));

    return {
      width: Math.max(1, Math.floor(glCanvas.width * safeScale)),
      height: Math.max(1, Math.floor(glCanvas.height * safeScale)),
    };
  }

  /** Collect dimension value strings for the info overlay. */
  // eslint-disable-next-line max-lines-per-function
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
      if (store.scalarAnimationTime?.index === i) {
        lines.push(`${range.name}: ${store.scalarAnimationTime.label}`);
        continue;
      }
      if (
        isTimeCoordinate(range.name, dimInfo.attrs) &&
        isTimeUnits(dimInfo.attrs.units)
      ) {
        const index = store.dimSlidersDisplay[i] ?? range.startPos;
        const coordinate = dimInfo.values?.[index];
        const value = coordinate ?? dimInfo.current;
        if (typeof value !== "object") {
          lines.push(
            `${range.name}: ${formatTimeCoordinate(value, dimInfo.attrs)}`
          );
          continue;
        }
      }
      const val = dimInfo.current;
      const isObj = val && typeof val === "object";
      const hasFormat = isObj && typeof (val as Dayjs).format === "function";
      const valStr = hasFormat
        ? (val as Dayjs).format("DD MMM YYYY • HH:mm:ss")
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
    x: number,
    width: number,
    y: number,
    barHeight: number,
    labelFontSize: number,
    textColor: string,
    cmCanvas: HTMLCanvasElement | null
  ) {
    if (cmCanvas) {
      ctx.drawImage(cmCanvas, x, y, width, barHeight);
    }
    ctx.fillStyle = textColor;
    ctx.font = `${labelFontSize}px sans-serif`;
    ctx.textBaseline = "top";
    const sel = store.selection as { low?: number; high?: number };
    if (sel.low !== undefined && sel.high !== undefined) {
      ctx.textAlign = "left";
      ctx.fillText(formatSnapValue(sel.low), x, y + barHeight + 3);
      ctx.textAlign = "right";
      ctx.fillText(formatSnapValue(sel.high), x + width, y + barHeight + 3);
    }
  }

  function downloadSnapshot(composite: HTMLCanvasElement) {
    composite.toBlob((blob) => {
      if (!blob) {
        logError("Failed to create snapshot blob");
        return;
      }
      const link = document.createElement("a");
      link.download = "gridlook.png";
      link.href = URL.createObjectURL(blob!);
      link.click();
      URL.revokeObjectURL(link.href);
    }, "image/png");
  }

  /** Draw colormap and metadata overlays onto a composed frame. */
  /* eslint-disable-next-line max-lines-per-function */
  function drawSnapshotOverlays(
    ctx: CanvasRenderingContext2D,
    imageHeight: number,
    overlayRect: TSnapshotRect,
    showColormap: boolean,
    datasetTitle: string | null,
    infoLines: string[],
    margin: number,
    cmBarH: number,
    cmLabelH: number,
    infoLineH: number,
    fontSize: number,
    textColor: string,
    gradient: HTMLCanvasElement | null
  ) {
    let currentY = imageHeight + margin;
    if (showColormap) {
      drawColormapSection(
        ctx,
        overlayRect.x,
        overlayRect.width,
        currentY,
        cmBarH,
        Math.round(fontSize * 0.85),
        textColor,
        gradient
      );
      currentY += cmBarH + cmLabelH;
    }
    if (datasetTitle !== null) {
      const { height: titleHeight } = canvasTxtDrawText(ctx, datasetTitle, {
        x: overlayRect.x,
        y: currentY,
        width: overlayRect.width,
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
        ctx.fillText(line, overlayRect.x, currentY);
        currentY += infoLineH;
      }
    }
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

  // Sidebar dimensions stay fixed while time labels change during video export.
  // eslint-disable-next-line max-lines-per-function
  function createSidebar(
    options: TSnapshotOptions,
    imageHeight: number,
    viewHeight: number
  ) {
    const fontSize = Math.round(Math.max(13, viewHeight * 0.02));
    const margin = fontSize;
    const width = fontSize * 22;
    const textWidth = width - 2 * margin;
    const lineHeight = Math.round(fontSize * 1.5);
    const barHeight = fontSize;
    const measure = document.createElement("canvas").getContext("2d")!;
    measure.font = `${fontSize}px sans-serif`;
    const lines = () => {
      const info = buildSnapshotInfoLines(options.showDatasetInfo);
      const text = [info.datasetTitle, ...info.lines]
        .filter(Boolean)
        .join("\n\n");
      return text
        ? splitText({ ctx: measure, text, width: textWidth, justify: false })
        : [];
    };
    const legendHeight = options.showColormap ? barHeight + 3 * lineHeight : 0;
    // Reserve two extra lines for changing dates, without resizing encoded frames.
    const height = Math.max(
      imageHeight,
      (lines().length + 2) * lineHeight + legendHeight + 2 * margin
    );
    const gradient = options.showColormap
      ? renderColormapGradient(
          store.colormap,
          store.invertColormap ? 1 : 0,
          store.invertColormap ? -1 : 1,
          store.posterizeLevels,
          textWidth,
          barHeight
        )
      : null;
    const textColor =
      options.background === SnapshotBackgrounds.WHITE ? "#000000" : "#ffffff";
    return {
      width,
      height,
      draw(ctx: CanvasRenderingContext2D) {
        ctx.fillStyle = textColor;
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        lines().forEach((line, index) =>
          ctx.fillText(line.trim(), margin, margin + index * lineHeight)
        );
        if (options.showColormap) {
          drawColormapSection(
            ctx,
            margin,
            textWidth,
            height - legendHeight,
            barHeight,
            fontSize,
            textColor,
            gradient
          );
        }
      },
    };
  }

  /* eslint-disable-next-line max-lines-per-function */
  function createSnapshotRenderer(
    options: TSnapshotOptions = DEFAULT_SNAPSHOT_OPTIONS
  ) {
    const glCanvas = canvas.value;
    if (!glCanvas || !getRenderer() || !getScene() || !getCamera()) {
      return;
    }
    const { width: w, height: h } = getSnapshotDimensions(
      glCanvas,
      options.resolutionScale
    );
    const { background, showDatasetInfo, showColormap } = options;
    // Video keeps the user's viewport framing, including regional close-ups.
    const contentRect =
      options.overlayPosition === SnapshotOverlayPositions.LEFT
        ? getFullSnapshotRect(w, h)
        : getSnapshotContentRect(getCamera()!, getBaseSurface(), w, h);
    const noOverlays = !showColormap && !showDatasetInfo;

    if (
      noOverlays ||
      options.overlayPosition === SnapshotOverlayPositions.LEFT
    ) {
      const sidebar = noOverlays
        ? undefined
        : createSidebar(options, contentRect.height, h);
      const composite = document.createElement("canvas");
      composite.width = contentRect.width + (sidebar?.width ?? 0);
      composite.height = sidebar?.height ?? contentRect.height;
      const ctx = composite.getContext("2d")!;
      const imageCanvas = document.createElement("canvas");
      imageCanvas.width = w;
      imageCanvas.height = h;
      const imageCtx = imageCanvas.getContext("2d")!;
      const globeRenderer = createGlobeRenderer(w, h, background);

      return {
        width: composite.width,
        height: composite.height,
        dispose: globeRenderer.dispose,
        render(rotationSeconds = 0) {
          ctx.clearRect(0, 0, composite.width, composite.height);
          fillBackground(ctx, composite.width, composite.height, background);
          globeRenderer.render(imageCtx, rotationSeconds);
          ctx.drawImage(
            imageCanvas,
            contentRect.x,
            contentRect.y,
            contentRect.width,
            contentRect.height,
            sidebar?.width ?? 0,
            (composite.height - contentRect.height) / 2,
            contentRect.width,
            contentRect.height
          );
          sidebar?.draw(ctx);
          return composite;
        },
      };
    }

    const fontSize = Math.round(Math.max(13, h * 0.022));
    const MARGIN = Math.round(Math.max(10, h * 0.018));
    const CM_BAR_HEIGHT = Math.round(Math.max(18, h * 0.032));
    const CM_LABEL_HEIGHT = Math.round(fontSize * 1.8);
    const INFO_LINE_HEIGHT = Math.round(fontSize * 1.5);
    const textColor = background === "white" ? "#000000" : "#ffffff";

    const { datasetTitle, lines: infoLines } =
      buildSnapshotInfoLines(showDatasetInfo);

    // Estimate wrapped title height to size the composite canvas correctly.
    const maxTextWidth = contentRect.width;
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

    const gradient = showColormap
      ? renderColormapGradient(
          store.colormap,
          store.invertColormap ? 1 : 0,
          store.invertColormap ? -1 : 1,
          store.posterizeLevels,
          contentRect.width,
          CM_BAR_HEIGHT
        )
      : null;
    const globeRenderer = createGlobeRenderer(w, h, background);
    // Fix the layout and camera for a sequence; only data and labels change.
    return {
      width: composite.width,
      height: composite.height,
      dispose: globeRenderer.dispose,
      render(rotationSeconds = 0) {
        ctx.clearRect(0, 0, composite.width, composite.height);
        fillBackground(ctx, w, h + extraHeight, background);
        globeRenderer.render(ctx, rotationSeconds);
        const currentInfo = buildSnapshotInfoLines(showDatasetInfo);
        drawSnapshotOverlays(
          ctx,
          h,
          contentRect,
          showColormap,
          currentInfo.datasetTitle,
          currentInfo.lines,
          MARGIN,
          CM_BAR_HEIGHT,
          CM_LABEL_HEIGHT,
          INFO_LINE_HEIGHT,
          fontSize,
          textColor,
          gradient
        );
        return composite;
      },
    };
  }

  function makeSnapshot(options: TSnapshotOptions = DEFAULT_SNAPSHOT_OPTIONS) {
    const frames = createSnapshotRenderer(options);
    if (!frames) {
      return;
    }
    try {
      downloadSnapshot(frames.render());
    } finally {
      frames.dispose();
      render();
    }
  }

  return { makeSnapshot, createSnapshotRenderer };
}
