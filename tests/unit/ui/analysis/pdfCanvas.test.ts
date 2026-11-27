import { describe, expect, it } from "vitest";

import { parseColour, PdfPageRecorder } from "@/ui/analysis/pdfCanvas.ts";

/** A canvas stand-in: the recorder only reads its pixel width. */
const canvasOf = (width: number) =>
  ({ width, height: 0 }) as unknown as HTMLCanvasElement;

// eslint-disable-next-line max-lines-per-function
describe("recording canvas drawing as PDF", () => {
  it("maps device pixels through the figure's place to page points", () => {
    // A 100 × 50 px page; the figure at (10, 5), 40 px wide, drawn at 2×.
    const recorder = new PdfPageRecorder(100, 50);
    const context = recorder.attach(canvasOf(80), 10, 5, 40);
    context.setTransform(2, 0, 0, 2, 0, 0);
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 10, 10);
    const ops = recorder.ops.join("\n");
    // (0, 0) → css (10, 5) → pt (7.5, 33.75); (10, 10) → css (20, 15).
    expect(ops).toContain("7.5 33.75 m 15 33.75 l 15 26.25 l 7.5 26.25 l h\nf");
    expect(ops).toContain("1 0 0 rg");
    expect(recorder.page()).toMatchObject({ width: 75, height: 37.5 });
  });

  it("follows a transform changed between points (the cached page matrix)", () => {
    const recorder = new PdfPageRecorder(100, 100);
    const context = recorder.attach(canvasOf(100), 0, 0, 100);
    context.beginPath();
    context.moveTo(10, 10);
    context.scale(2, 2);
    context.lineTo(10, 10);
    context.save();
    context.translate(5, 0);
    context.lineTo(10, 10);
    context.restore();
    context.lineTo(10, 10);
    context.stroke();
    const path = recorder.ops.join(" ");
    // (10, 10) at 0.75 pt/px: 7.5; scaled 2×: 15; then moved 5 px: 22.5.
    expect(path).toContain("7.5 67.5 m 15 60 l 22.5 60 l 15 60 l");
  });

  it("scales line widths and dashes with the transform", () => {
    const recorder = new PdfPageRecorder(100, 50);
    const context = recorder.attach(canvasOf(200), 0, 0, 100);
    context.scale(2, 2);
    context.lineWidth = 2;
    context.setLineDash([4, 2]);
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(10, 0);
    context.stroke();
    // 2 px × 2 (scale) × 0.5 (device to css) × 0.75 (css to points).
    expect(recorder.ops).toContain("1.5 w 0 J 0 j 10 M");
    expect(recorder.ops).toContain("[3 1.5] 0 d");
    expect(recorder.ops.at(-1)).toBe("S");
    // Chart.js assigns undefined offsets: ignored, as by a canvas, so no
    // NaN reaches the page (a viewer stops drawing at one).
    context.lineDashOffset = undefined as unknown as number;
    context.miterLimit = Number.NaN;
    context.stroke();
    expect(recorder.ops.join(" ")).not.toMatch(/NaN|Infinity/);
  });

  it("draws arcs as curves, quadratic curves as cubic ones", () => {
    const recorder = new PdfPageRecorder(100, 100);
    const context = recorder.attach(canvasOf(100), 0, 0, 100);
    context.beginPath();
    context.arc(50, 50, 10, 0, 2 * Math.PI);
    context.fill();
    const path = recorder.ops.at(-2)!;
    expect(path.match(/ c/g)).toHaveLength(4);
    expect(path.startsWith("45 37.5 m")).toBe(true);
    context.beginPath();
    context.moveTo(0, 0);
    context.quadraticCurveTo(30, 0, 30, 30);
    context.stroke();
    expect(recorder.ops.at(-2)).toBe("0 75 m 15 75 22.5 67.5 22.5 52.5 c");
  });

  it("replays a recorded Path2D under the current transform", () => {
    const recorder = new PdfPageRecorder(100, 100);
    const context = recorder.attach(canvasOf(100), 0, 0, 100);
    context.beginPath();
    context.rect(0, 0, 100, 100);
    context.translate(10, 0);
    // What Chart.js caches for a line: commands kept by the recorded path.
    const line = {
      commands: [
        ["moveTo", [0, 0]],
        ["lineTo", [20, 0]],
      ],
    } as unknown as Path2D;
    context.stroke(line);
    expect(recorder.ops.slice(-2)).toEqual(["7.5 75 m 22.5 75 l", "S"]);
    // The current path (the rectangle) is untouched.
    context.fill();
    expect(recorder.ops.at(-2)).toBe("0 75 m 75 75 l 75 0 l 0 0 l h");
  });

  it("multiplies opacities and keeps saved state in q/Q", () => {
    const recorder = new PdfPageRecorder(10, 10);
    const context = recorder.attach(canvasOf(10), 0, 0, 10);
    context.save();
    context.globalAlpha = 0.5;
    context.fillStyle = "rgba(0, 0, 255, 0.5)";
    context.fillRect(0, 0, 1, 1);
    context.save();
    context.beginPath();
    context.rect(0, 0, 5, 5);
    context.clip();
    context.settle();
    expect(recorder.alphas).toEqual([0.25]);
    expect(recorder.ops.filter((op) => op === "q")).toHaveLength(2);
    expect(recorder.ops.filter((op) => op === "Q")).toHaveLength(2);
    expect(recorder.ops).toContain("W n");
    // Restored: full opacity again.
    expect(context.globalAlpha).toBe(1);
  });

  it("writes text in Helvetica where the canvas would put it", () => {
    const recorder = new PdfPageRecorder(100, 50);
    const context = recorder.attach(canvasOf(100), 0, 0, 100);
    context.font = "600 10px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillStyle = "#000";
    expect(context.measureText("Ab").width).toBeCloseTo(13.33, 2);
    context.fillText("Ab", 50, 0);
    // Left edge 50 − 13.33/2; baseline 0.905 em below the top.
    expect(recorder.ops.at(-1)).toBe(
      "BT /F2 10 Tf 0 Tr 0.75 0 0 0.75 32.501 30.713 Tm (Ab) Tj ET"
    );
  });

  it("reads the colours canvas code uses", () => {
    expect(parseColour("#0af")).toEqual({ r: 0, g: 170, b: 255, a: 1 });
    expect(parseColour("rgba(10, 20, 30, 0.4)")).toEqual({
      r: 10,
      g: 20,
      b: 30,
      a: 0.4,
    });
    expect(parseColour("rgb(10 20 30 / 50%)")).toMatchObject({ a: 0.5 });
    expect(parseColour("transparent").a).toBe(0);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("vector figures paint each frame once (v20 review)", () => {
  it("keeps the last frame a canvas drew, not the clear of its destruction", () => {
    const canvas = { width: 200, height: 100 } as unknown as HTMLCanvasElement;
    const recorder = new PdfPageRecorder(100, 50);
    recorder.ops.push("q % the page's own state");
    const context = recorder.attach(canvas, 0, 0, 100);
    const frame = () => {
      context.save();
      context.resetTransform();
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.restore();
      context.save();
      context.fillStyle = "rgba(0, 0, 0, 0.1)";
      context.fillRect(0, 50, 200, 1);
      context.fillText("label", 10, 10);
      context.restore();
    };
    frame(); // Chart.js paints once when built …
    frame(); // … and again after a resize …
    // … and clears the canvas once more when the chart is destroyed.
    context.save();
    context.resetTransform();
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.restore();
    context.settle();
    const ops = recorder.ops.join("\n");
    expect(ops.match(/\(label\) Tj/g)).toHaveLength(1);
    expect(ops.match(/\nf\b/g)).toHaveLength(1);
    expect(ops.startsWith("q % the page's own state")).toBe(true);
    // Saves and restores still balance.
    expect(ops.match(/^q/gm)!.length).toBe(ops.match(/^Q/gm)!.length + 1);
    // A partial clear erases nothing on the page.
    context.clearRect(0, 0, 10, 10);
    context.settle();
    expect(recorder.ops.join("\n").match(/\(label\) Tj/g)).toHaveLength(1);
  });

  it("restores the page's own Path2D after overlapping recordings, in any order", async () => {
    const { withRecordedPaths } = await import("@/ui/analysis/pdfCanvas.ts");
    const native = class FakePath2D {} as unknown as typeof Path2D;
    const original = globalThis.Path2D;
    globalThis.Path2D = native;
    try {
      const gate = () => {
        let open!: () => void;
        const promise = new Promise<void>((resolve) => (open = resolve));
        return { promise, open };
      };
      const [a, b] = [gate(), gate()];
      const first = withRecordedPaths(() => a.promise);
      const second = withRecordedPaths(() => b.promise);
      // The first ends first, then the second: the page's own comes back.
      a.open();
      await first;
      b.open();
      await second;
      expect(globalThis.Path2D).toBe(native);
      // Opposite order, and one failing.
      const [c, d] = [gate(), gate()];
      const third = withRecordedPaths(() => c.promise);
      const fourth = withRecordedPaths(async () => {
        await d.promise;
        throw new Error("drawing failed");
      });
      d.open();
      await expect(fourth).rejects.toThrow("drawing failed");
      c.open();
      await third;
      expect(globalThis.Path2D).toBe(native);
    } finally {
      globalThis.Path2D = original;
    }
  });
});

describe("v24 review: a long profile records as vector", () => {
  it("settles 600,000 operations without overflowing a call (the browser failed at 200,000)", () => {
    const recorder = new PdfPageRecorder(400, 300);
    const canvas = canvasOf(800);
    const context = recorder.attach(canvas, 0, 0, 400);
    const frame = () => {
      context.clearRect(0, 0, canvas.width, 300);
      // Alternating finite and missing levels: a short line each, with
      // its own style (as Chart.js draws segments).
      for (let k = 0; k < 300_000; k += 2) {
        context.strokeStyle = k % 4 ? "#000" : "#00f";
        context.beginPath();
        context.moveTo(k / 100, k % 300);
        context.lineTo((k + 1) / 100, (k + 1) % 300);
        context.stroke();
      }
    };
    frame();
    frame();
    expect(recorder.ops.length).toBeGreaterThan(600_000);
    expect(() => context.settle()).not.toThrow();
    // One frame kept.
    expect(recorder.ops.filter((op) => op === "S")).toHaveLength(150_000);
  });
});

it("review of interim43: an image drawn without smoothing stays pixelated in the SVG", async () => {
  const { pdfPageToSvg } = await import("@/lib/analysis/svgWriter.ts");
  class FakeImageData {
    constructor(
      public data: Uint8ClampedArray,
      public width: number,
      public height: number
    ) {}
  }
  const previous = (globalThis as { ImageData?: unknown }).ImageData;
  (globalThis as { ImageData?: unknown }).ImageData = FakeImageData;
  try {
    // Red beside blue, as a heatmap's two cells.
    const cells = new FakeImageData(
      Uint8ClampedArray.of(255, 0, 0, 255, 0, 0, 255, 255),
      2,
      1
    ) as unknown as CanvasImageSource;
    const svg = (smooth: boolean) => {
      const recorder = new PdfPageRecorder(100, 100);
      const context = recorder.attach(canvasOf(100), 0, 0, 100);
      context.imageSmoothingEnabled = smooth;
      context.drawImage(cells, 0, 0, 80, 40);
      return pdfPageToSvg(recorder.page(), () => "data:,");
    };
    expect(svg(false)).toContain('style="image-rendering:pixelated"');
    expect(svg(true)).not.toContain("image-rendering");
  } finally {
    (globalThis as { ImageData?: unknown }).ImageData = previous;
  }
});
