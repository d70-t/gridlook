/**
 * A kept region mask holds its centres and weights, not the grid's geometry:
 * once the source and its context are gone, a collection frees the geometry,
 * for a drawn shape as for a box.
 */
import v8 from "node:v8";
import vm from "node:vm";

import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { forgetGeometries } from "@/lib/analysis/nativeGrid.ts";
import { queryRegionSelection } from "@/lib/analysis/operations.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

async function write(
  store: Map<string, Uint8Array>,
  path: string,
  data: number[],
  dims: string[],
  attrs: Record<string, unknown>
) {
  const shape = dims.length === 2 ? [1, data.length] : [data.length];
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: shape,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
  });
  await zarr.set(array as never, null, {
    data: Float64Array.from(data),
    shape,
    stride: shape.length === 2 ? [data.length, 1] : [1],
  } as never);
}

async function keptSelection(region: unknown) {
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "time", [0], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(store, "lat", [1, 2, 3], ["site"], { units: "degrees_north" });
  await write(store, "lon", [3, 4, 5], ["site"], { units: "degrees_east" });
  await write(store, "tas", [5, 6, 7], ["time", "site"], {
    coordinates: "lat lon",
  });
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `kept-${Math.random()}`
  );
  const ctx = await resolveVariableContext(
    dataset,
    "tas",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  const grid = ctx.grid as { geometry: () => Promise<object> };
  const geometry = new WeakRef(await grid.geometry());
  const selection = await queryRegionSelection(
    ctx,
    region as never,
    ctx.dims.map(() => []),
    { geometryMs: 0 } as never
  );
  // The source is released, as when its dataset is closed.
  forgetGeometries(dataset.key);
  return { selection, geometry };
}

async function collected(ref: WeakRef<object>) {
  for (let k = 0; k < 7; k++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  }
  return ref.deref() === undefined;
}

it("frees the grid's geometry behind a kept box or shape mask", async () => {
  const box = await keptSelection({
    kind: "box",
    south: 0,
    north: 5,
    west: 0,
    east: 6,
  });
  // An imported shape: its mask is kept for the next plot on this grid.
  const shape = await keptSelection({
    kind: "shape",
    name: "imported",
    polygons: [
      [
        [
          [0, 0],
          [6, 0],
          [6, 5],
          [0, 5],
          [0, 0],
        ],
      ],
    ],
    digest: `imported-${Math.random()}`,
  });
  expect(box.selection.storedCells).toBe(3);
  expect(shape.selection.storedCells).toBe(3);
  expect(await collected(box.geometry)).toBe(true);
  expect(await collected(shape.geometry)).toBe(true);
  // The masks still answer.
  expect(shape.selection.positionOf!(new Float64Array(), 2)).toEqual([3, 5]);
  expect(box.selection.positionOf!(new Float64Array(), 2)).toEqual([3, 5]);
});
