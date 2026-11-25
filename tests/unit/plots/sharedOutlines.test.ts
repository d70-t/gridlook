import { expect, it, vi } from "vitest";

import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  type TGeometry,
} from "@/lib/analysis/types.ts";

const digests = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/analysis/shapeImport.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/analysis/shapeImport.ts")>();
  return {
    ...actual,
    shapeIdentity: (...args: Parameters<typeof actual.shapeIdentity>) => {
      digests.count++;
      return actual.shapeIdentity(...args);
    },
  };
});

const { decodeSession, encodeSession } =
  await import("@/lib/analysis/sessionLink.ts");
const { shapeDigest } = await import("@/lib/analysis/shapeImport.ts");

it("eight plots of one shared outline hash it once", () => {
  const ring = Array.from({ length: 6001 }, (_, k) => {
    const a = (2 * Math.PI * k) / 6000;
    return [10 * Math.cos(a), 10 * Math.sin(a)];
  });
  const polygons = [[ring]];
  const shape = {
    kind: "shape",
    name: "Study area",
    polygons,
    digest: shapeDigest(polygons),
  } as TGeometry;
  const plots = Array.from({ length: 8 }, (_, k) => ({
    query: {
      version: ALGORITHM_VERSION,
      kind: ANALYSIS_KINDS.REGION_SERIES,
      variable: `v${k}`,
      geometry: shape,
      fixed: {},
    },
  }));
  const link = encodeSession({ plots } as never);
  digests.count = 0;
  const restored = decodeSession(link);
  expect(restored.plots).toHaveLength(8);
  expect(digests.count).toBe(1);
  // Each with the identity of its outline.
  for (const plot of restored.plots) {
    expect((plot.query.geometry as { digest: string }).digest).toBe(
      shapeDigest(polygons)
    );
  }
});

it("review of interim44: eight plots of one shared outline check its vertices once", () => {
  const ring = Array.from({ length: 6001 }, (_, k) => {
    const a = (2 * Math.PI * k) / 6000;
    return [10 * Math.cos(a), 10 * Math.sin(a)];
  });
  const polygons = [[ring]];
  const shape = {
    kind: "shape",
    name: "Study area",
    polygons,
    digest: shapeDigest(polygons),
  } as TGeometry;
  const plots = Array.from({ length: 8 }, (_, k) => ({
    query: {
      version: ALGORITHM_VERSION,
      kind: ANALYSIS_KINDS.REGION_SERIES,
      variable: `v${k}`,
      geometry: shape,
      fixed: {},
    },
  }));
  const link = encodeSession({ plots } as never);
  // Each vertex check tests both coordinates for finiteness.
  const finite = vi.spyOn(Number, "isFinite");
  const restored = decodeSession(link);
  const checks = finite.mock.calls.length;
  finite.mockRestore();
  expect(restored.plots).toHaveLength(8);
  expect(checks).toBeGreaterThanOrEqual(2 * 6001);
  expect(checks).toBeLessThan(2 * 2 * 6001);
});
