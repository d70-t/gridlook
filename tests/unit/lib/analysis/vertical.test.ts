/* eslint-disable camelcase -- CF attribute names are snake_case. */
import { describe, expect, it } from "vitest";

import {
  formulaUnitProblem,
  resolveVerticalAxis,
} from "@/lib/analysis/vertical.ts";

describe("pressure orientation without a positive attribute", () => {
  it("infers down from pressure units in either file order", () => {
    for (const units of ["hPa", "Pa", "mbar", "dbar"]) {
      const axis = resolveVerticalAxis(1, "plev", { units }, () => true);
      expect(axis.positive).toBe("down");
    }
    const height = resolveVerticalAxis(
      1,
      "z",
      { units: "m", standard_name: "height" },
      () => true
    );
    expect(height.positive).toBe("up");
  });

  it("rejects formula terms in units it cannot convert", () => {
    expect(formulaUnitProblem("ps", "furlongs")).toMatch(/ps/);
    expect(formulaUnitProblem("ps", "atm")).toBeUndefined();
    expect(formulaUnitProblem("sigma", "1")).toBeUndefined();
    // The right quantity for each term.
    expect(formulaUnitProblem("eta", "1")).toMatch(/length/);
    expect(formulaUnitProblem("ps", "m")).toMatch(/pressure/);
    expect(formulaUnitProblem("b", "hPa")).toMatch(/dimensionless/);
    expect(formulaUnitProblem("b", "%")).toBeUndefined();
    expect(formulaUnitProblem("depth", "mm")).toBeUndefined();
  });
});
