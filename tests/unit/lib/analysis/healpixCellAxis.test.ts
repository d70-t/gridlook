/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { healpixCellAxis } from "@/lib/grids/analysisGrid.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

async function write(
  store: TStore,
  path: string,
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {}
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: shape,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN as never,
  });
  const size = shape.reduce((a, b) => a * b, 1);
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((product, n) => product * n, 1)
  );
  await zarr.set(array as never, null, {
    data: Float64Array.from({ length: size }, (_, at) => at),
    shape,
    stride,
  } as never);
}

describe("the HEALPix cell axis (pairing bug: 'the cell axis has 1')", () => {
  it("is the named dimension, else the one as long as the level", () => {
    // Named by the metadata (or the cell coordinate): that one.
    expect(
      healpixCellAxis(["time", "ncells"], [2, 192], {
        spatial_dimension: "ncells",
      })
    ).toBe(1);
    // Not named: not the trailing height of 1, but the level's cells.
    expect(
      healpixCellAxis(
        ["time", "cell", "height"],
        [2, 192, 1],
        null,
        undefined,
        192
      )
    ).toBe(1);
    // No level declared: any whole sphere (12 × 4^order cells).
    expect(healpixCellAxis(["time", "cell", "height"], [2, 768, 1])).toBe(1);
    // No cells at all (a global mean): none.
    expect(healpixCellAxis(["time"], [2], null, undefined, 192)).toBe(-1);
  });
});

describe("HEALPix variables in a store", () => {
  it("resolves a field with a trailing unit dimension; says why a global mean has no place", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    const order = 2;
    const n = 12 * 4 ** order;
    await write(store, "crs", [1], ["one"], {
      grid_mapping_name: "healpix",
      healpix_nside: 2 ** order,
      healpix_order: "nest",
    });
    await write(store, "time", [2], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(store, "tas", [2, n, 1], ["time", "cell", "height"], {
      grid_mapping: "crs",
    });
    await write(store, "gmean", [2], ["time"], { grid_mapping: "crs" });
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      "hp-axis"
    );
    const tas = await resolveVariableContext(
      dataset,
      "tas",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    expect(tas.grid.kind).toBe("healpix");
    expect(tas.grid.kind === "healpix" && tas.grid.cellAxis).toBe(1);
    const mean = await resolveVariableContext(
      dataset,
      "gmean",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    expect(mean.capabilities[ANALYSIS_KINDS.POINT_SERIES]).toEqual({
      available: false,
      reason: expect.stringMatching(
        /^gmean has no HEALPix cell dimension \(time 2\)/
      ),
    });
  });
});
