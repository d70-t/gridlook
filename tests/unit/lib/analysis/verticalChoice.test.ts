/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;
const indexCache = new ByteLru<BigInt64Array>(8 * 2 ** 20);

async function write(
  store: TStore,
  path: string,
  dims: string[],
  shape: number[],
  values: number[],
  attrs: Record<string, unknown> = {}
) {
  const node = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: shape,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
  });
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((p, n) => p * n, 1)
  );
  await zarr.set(node as never, null, {
    data: Float64Array.from(values),
    shape,
    stride,
  } as never);
}

/** A 2 × 2 grid with three levels along `dim`, `levelAttrs` on its coordinate. */
async function dataset(
  dim: string,
  fieldAttrs: Record<string, unknown>,
  extra: (store: TStore) => Promise<void> = async () => {},
  levelAttrs?: Record<string, unknown>,
  levels = [0, 1, 2]
) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", ["lat"], [2], [0, 1], { units: "degrees_north" });
  await write(store, "lon", ["lon"], [2], [0, 1], { units: "degrees_east" });
  if (levelAttrs) {
    await write(store, dim, [dim], [3], levels, levelAttrs);
  }
  await write(store, "f", [dim, "lat", "lon"], [3, 2, 2], Array(12).fill(1), {
    units: "1",
    ...fieldAttrs,
  });
  await extra(store);
  return zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `v-${Math.random()}`
  );
}

const auxiliaries = async (store: TStore) => {
  await write(store, "depth", ["z"], [3], [0, 10, 25], {
    standard_name: "depth",
    units: "m",
    positive: "down",
  });
  await write(store, "pres", ["z"], [3], [0, 10.1, 25.3], {
    standard_name: "sea_water_pressure",
    units: "dbar",
  });
};

// eslint-disable-next-line max-lines-per-function
describe("review of interim10: the vertical coordinate plotted", () => {
  it("is the same whatever the order of `coordinates`", async () => {
    for (const coordinates of ["depth pres", "pres depth"]) {
      const context = await resolveVariableContext(
        await dataset("z", { coordinates }, auxiliaries),
        "f",
        indexCache
      );
      expect(context.vertical?.values).toEqual([0, 10, 25]);
      expect(context.vertical?.units).toBe("m");
    }
  });

  it("keeps pressure in pascals and potential temperature levels", async () => {
    const pascals = await resolveVariableContext(
      await dataset(
        "p",
        {},
        undefined,
        { axis: "Z", units: "pascals" },
        [100000, 70000, 40000]
      ),
      "f",
      indexCache
    );
    expect(pascals.vertical?.kind).toBe("physical");
    expect(pascals.vertical?.values).toEqual([100000, 70000, 40000]);
    const theta = await resolveVariableContext(
      await dataset(
        "theta",
        {},
        undefined,
        {
          axis: "Z",
          units: "K",
          standard_name: "air_potential_temperature",
          positive: "up",
        },
        [280, 300, 330]
      ),
      "f",
      indexCache
    );
    expect(theta.vertical?.kind).toBe("physical");
    expect(theta.vertical?.values).toEqual([280, 300, 330]);
  });

  it("offers no vertical profile along particle energies named like levels", async () => {
    const context = await resolveVariableContext(
      await dataset(
        "energy_level",
        {},
        undefined,
        {
          units: "keV",
          long_name: "particle energy",
        },
        [1, 10, 100]
      ),
      "f",
      indexCache
    );
    expect(context.vertical).toBeUndefined();
    expect(context.capabilities[ANALYSIS_KINDS.PROFILE].available).toBe(false);
  });
});
/* eslint-enable camelcase */
