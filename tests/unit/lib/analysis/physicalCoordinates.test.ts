/* eslint-disable camelcase -- CF attribute names are snake_case. */
import { describe, expect, it } from "vitest";

import { resolveVerticalAxis } from "@/lib/analysis/vertical.ts";
import { verticalQuantity } from "@/ui/analysis/plotFigure.ts";

describe("potential density as the vertical coordinate", () => {
  const attrs = {
    standard_name: "sea_water_potential_density",
    axis: "Z",
    positive: "down",
    units: "kg m-3",
  };

  it("is physical, keeps its units and is named for what it is", () => {
    const axis = resolveVerticalAxis(1, "rho", attrs, () => true);
    expect(axis.kind).toBe("physical");
    expect(axis.units).toBe("kg m-3");
    expect(axis.note).toBeUndefined();
    expect(
      verticalQuantity({ physical: true, label: axis.label, units: axis.units })
    ).toBe("potential density");
  });

  it("leaves a parametric coordinate without its terms a model level", () => {
    const axis = resolveVerticalAxis(
      1,
      "lev",
      {
        standard_name: "atmosphere_hybrid_sigma_pressure_coordinate",
        axis: "Z",
        units: "1",
      },
      () => false
    );
    expect(axis.kind).toBe("model");
  });

  it("keeps a level index without units a model level", () => {
    const axis = resolveVerticalAxis(
      1,
      "lev",
      { axis: "Z", units: "1" },
      () => true
    );
    expect(axis.kind).toBe("model");
  });
});
