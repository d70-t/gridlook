/* eslint-disable camelcase -- the fixture uses published Zarr v2 and CF fields. */
import { expect, it } from "vitest";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { partnerQuery } from "@/lib/analysis/companionAlign.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ALGORITHM_VERSION, ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

// eslint-disable-next-line max-lines-per-function -- constructs a complete on-disk-layout dataset and checks the derived member selection.
it("preserves fixed-width Zarr v2 member labels for metadata and selection", async () => {
  const files = new Map<string, Uint8Array>();
  const json = (name: string, value: unknown) =>
    files.set(name, new TextEncoder().encode(JSON.stringify(value)));
  json("/.zgroup", { zarr_format: 2 });
  function add(
    name: string,
    dtype: string,
    shape: number[],
    dims: string[],
    attrs: object,
    data: Uint8Array
  ) {
    json(`/${name}/.zarray`, {
      zarr_format: 2,
      dtype,
      shape,
      chunks: shape,
      order: "C",
      filters: null,
      compressor: null,
      fill_value: null,
    });
    json(`/${name}/.zattrs`, { ...attrs, _ARRAY_DIMENSIONS: dims });
    files.set(`/${name}/${shape.map(() => 0).join(".")}`, data);
  }
  const f8 = (values: number[]) =>
    new Uint8Array(Float64Array.from(values).buffer);
  add(
    "time",
    "<f8",
    [2],
    ["time"],
    { units: "days since 2000-01-01" },
    f8([0, 1])
  );
  add("lat", "<f8", [2], ["lat"], { units: "degrees_north" }, f8([-5, 5]));
  add("lon", "<f8", [2], ["lon"], { units: "degrees_east" }, f8([0, 10]));
  const labels = ["ctl", "p01"];
  const unicode = Uint32Array.from([...labels.join("")], (c) =>
    c.codePointAt(0)!
  );
  add(
    "member",
    "<U3",
    [2],
    ["member"],
    { standard_name: "realization" },
    new Uint8Array(unicode.buffer)
  );
  add(
    "tas",
    "<f8",
    [2, 2, 2, 2],
    ["time", "member", "lat", "lon"],
    { units: "K" },
    f8(Array(16).fill(273))
  );
  const ds = zarrAnalysisDatasetFromStore(
    files as never,
    "",
    ZARR_FORMAT.V2,
    "v2-members"
  );
  const block = await (await ds.openArray("member")).readChunk([0]);
  expect(Array.from(block.data)).toEqual(labels);
  const ctx = await resolveVariableContext(
    ds,
    "tas",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  const axes = { others: ctx.others };
  const matched = partnerQuery(
    {
      version: ALGORITHM_VERSION,
      kind: ANALYSIS_KINDS.POINT_SERIES,
      variable: "tas",
      geometry: { kind: "point", lat: 5, lon: 0 },
      source: {
        ref: "https://example.org/model.zarr",
        versionStatus: "best-effort",
      },
      fixed: { member: 1 },
    },
    axes,
    axes,
    "partner"
  );
  expect
    .soft("fixed" in matched ? matched.fixed.member : matched.reason)
    .toBe(1);
  expect(ctx.others.find((other) => other.dimension === "member")?.ids).toEqual(
    labels
  );
});
