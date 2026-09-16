import { expect, it } from "vitest";

import { hideFormulaTermVariablesWithoutStandardName } from "@/lib/data/sourceIndexing.ts";
import type { TDataSource } from "@/lib/types/GlobeTypes.ts";

const CFAttribute = {
  FORMULA_TERMS: "formula_terms",
  STANDARD_NAME: "standard_name",
} as const;

function datasource(attrs: Record<string, unknown> = {}): TDataSource {
  return {
    store: "store",
    dataset: "",
    attrs,
  };
}

it("hides formula-term variables that have no standard name", () => {
  const datasources = {
    atmosphere: datasource({
      [CFAttribute.FORMULA_TERMS]: "ap: ap b: b ps: ps",
    }),
    ap: datasource(),
    b: datasource({
      [CFAttribute.STANDARD_NAME]:
        "atmosphere_hybrid_sigma_pressure_coordinate",
    }),
    ps: datasource(),
    unrelated: datasource(),
  };

  hideFormulaTermVariablesWithoutStandardName(datasources);

  expect(datasources.ap.hidden).toBe(true);
  expect(datasources.b.hidden).toBeUndefined();
  expect(datasources.ps.hidden).toBe(true);
  expect(datasources.unrelated.hidden).toBeUndefined();
});

it("keeps valid formula terms while ignoring malformed tokens", () => {
  const datasources = {
    atmosphere: datasource({
      [CFAttribute.FORMULA_TERMS]: "ap: ap malformed",
    }),
    ap: datasource(),
    malformed: datasource(),
  };

  hideFormulaTermVariablesWithoutStandardName(datasources);

  expect(datasources.ap.hidden).toBe(true);
  expect(datasources.malformed.hidden).toBeUndefined();
});

it.each([undefined, 42, "", "ap", "ap:", ":ap", "ap:ap:extra"])(
  "ignores formula_terms without valid pairs: %s",
  (formulaTerms) => {
    const datasources = {
      atmosphere: datasource({
        [CFAttribute.FORMULA_TERMS]: formulaTerms,
      }),
      ap: datasource(),
    };

    hideFormulaTermVariablesWithoutStandardName(datasources);

    expect(datasources.ap.hidden).toBeUndefined();
  }
);
