import type * as zarr from "zarrita";

import type { TVectorMagnitudeData } from "@/lib/data/vectorMagnitude.ts";
import type { useGlobeControlStore } from "@/store/store.ts";

type TStore = ReturnType<typeof useGlobeControlStore>;

/** Mark the transient scalar rendering without changing the selected variable. */
export function showVectorMagnitudeScalarInfo(
  store: TStore,
  scalar: TVectorMagnitudeData
) {
  store.varnameDisplay = scalar.standardName ?? "vector_magnitude";
  if (!store.varinfo) {
    return;
  }
  const attrs: zarr.Attributes = {
    ...store.varinfo.attrs,
    ["long_name"]: scalar.longName,
  };
  delete attrs.standard_name;
  if (scalar.standardName) {
    attrs["standard_name"] = scalar.standardName;
  }
  delete attrs.units;
  attrs.units = scalar.units;
  store.varinfo = {
    ...store.varinfo,
    attrs,
    bounds: { low: scalar.min, high: scalar.max },
  };
}
