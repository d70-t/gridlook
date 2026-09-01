import { describe, expect, it } from "vitest";

import {
  decodeVolumeUrlState,
  encodeVolumeUrlState,
} from "@/lib/volume/volumeUrlState.ts";

describe("volume URL state", () => {
  it("round-trips multiple selections and Unicode variable names", () => {
    const selections = [
      { variable: "multiscales/zoom_9/clw", color: "#FFFFFF", opacity: 0.75 },
      { variable: "Wolken/éís", color: "#72b7ff", opacity: 0.4 },
    ];

    expect(decodeVolumeUrlState(encodeVolumeUrlState(selections))).toEqual([
      { ...selections[0], color: "#ffffff" },
      selections[1],
    ]);
  });

  it("rejects malformed state without preventing page initialization", () => {
    expect(decodeVolumeUrlState("not-base64")).toEqual([]);
    expect(decodeVolumeUrlState()).toEqual([]);
  });

  it("omits empty selections", () => {
    expect(encodeVolumeUrlState([])).toBe("");
  });
});
