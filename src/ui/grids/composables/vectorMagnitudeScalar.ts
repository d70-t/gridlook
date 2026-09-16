import type * as zarr from "zarrita";

import type { TVectorVariablePair } from "@/lib/data/vectorField.ts";
import type { TVectorMagnitudeData } from "@/lib/data/vectorMagnitude.ts";
import type { TVarInfo } from "@/lib/types/GlobeTypes.ts";
import type { useGlobeControlStore } from "@/store/store.ts";

type TStore = ReturnType<typeof useGlobeControlStore>;

/** Mark the transient scalar rendering without changing the selected variable. */
export function showVectorMagnitudeScalarInfo(
  store: TStore,
  scalar: TVectorMagnitudeData
) {
  store.varnameDisplay = scalar.standardName ?? "vector_magnitude";
  store.varinfo = createVectorMagnitudeVarInfo(
    store.varinfo,
    scalar,
    store.streamlinePair
  );
}

export function createVectorMagnitudeVarInfo(
  info: TVarInfo | undefined,
  scalar: TVectorMagnitudeData,
  pair?: TVectorVariablePair
) {
  if (!info) {
    return undefined;
  }
  const attrs: zarr.Attributes = {
    ...info.attrs,
    ["long_name"]: scalar.longName,
  };
  delete attrs.standard_name;
  if (scalar.standardName) {
    attrs["standard_name"] = scalar.standardName;
  }
  delete attrs.units;
  attrs.units = scalar.units;
  return {
    ...info,
    attrs,
    derivedFrom: pair ? { u: pair.u, v: pair.v } : undefined,
    bounds: { low: scalar.min, high: scalar.max },
  };
}
