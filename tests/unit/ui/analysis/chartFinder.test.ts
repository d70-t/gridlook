import { describe, expect, it } from "vitest";

import { ANALYSIS_KINDS, type TAnalysisKind } from "@/lib/analysis/types.ts";
import { findCharts, suggestCharts } from "@/ui/analysis/chartFinder.ts";

const none = Object.fromEntries(
  Object.values(ANALYSIS_KINDS).map((kind) => [kind, ""])
) as Record<TAnalysisKind, string>;

describe("find a chart", () => {
  it("finds a plot by its name, accents and case ignored", () => {
    const found = findCharts("hovmoller");
    expect(found.map((e) => e.where)).toEqual([
      "Path — Distance × time (Hovmöller)",
      "Box — Longitude × time (Hovmöller)",
      "Box — Latitude × time (Hovmöller)",
    ]);
  });

  it("finds a plot by the name scientists use for it", () => {
    expect(findCharts("histogram")[0]).toMatchObject({
      kind: ANALYSIS_KINDS.DISTRIBUTION,
      where: "Box — Value distribution",
    });
    expect(findCharts("transect")[0].kind).toBe(ANALYSIS_KINDS.SECTION);
    expect(findCharts("sounding")[0].kind).toBe(ANALYSIS_KINDS.PROFILE);
  });

  it("finds a switch inside a plot, and turns it on (no note to follow)", () => {
    const [rose] = findCharts("rose");
    expect(rose).toMatchObject({
      title: "Wind or current rose",
      where: "Point — Time series",
      turnOn: { wind: true, figure: "rose" },
    });
    expect(findCharts("taylor")[0].compare).toBe("taylor");
    expect(findCharts("anomaly")[0].turnOn).toEqual({ timeView: "anomaly" });
    expect(findCharts("t-s")[0].turnOn).toEqual({ pair: "salinity" });
    expect(findCharts("").some((entry) => "then" in entry)).toBe(false);
  });

  it("needs every word, puts names starting with the query first", () => {
    const found = findCharts("area mean");
    // The three places an area mean is offered, then the switch on it.
    expect(found.map((e) => e.where)).toEqual([
      "Box — Area-mean time series",
      "Polygon — Area-mean time series",
      "Country — Area-mean time series",
      "Box — Area-mean time series",
    ]);
    expect(found[3].title).toBe("Spread over an area");
    expect(findCharts("time")[0].title).toMatch(/^Time/);
    expect(findCharts("rose taylor")).toEqual([]);
    expect(findCharts("   ")).toEqual([]);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("suggested for this data", () => {
  it("suggests barbs and a rose for a wind pair, a plume for members", () => {
    expect(
      suggestCharts({ wind: true, ensemble: true, reasons: none }).map(
        (e) => e.title
      )
    ).toEqual(["Ensemble plume", "Wind barbs", "Wind or current rose"]);
  });

  it("suggests a profile for levels, a hodograph with wind", () => {
    expect(
      suggestCharts({ vertical: true, reasons: none }).map((e) => e.title)
    ).toEqual(["Vertical profile"]);
    expect(
      suggestCharts({ vertical: true, wind: true, reasons: none }).map(
        (e) => e.title
      )
    ).toEqual(["Wind barbs", "Wind or current rose", "Vertical profile"]);
  });

  it("suggests the total and the distribution's range for precipitation", () => {
    expect(
      suggestCharts({
        standardName: "precipitation_flux",
        reasons: none,
      }).map((e) => e.title)
    ).toEqual(["Cumulative total", "Middle 95 % of an area"]);
  });

  it("suggests a T–S diagram for ocean temperature with salinity on levels", () => {
    expect(
      suggestCharts({
        vertical: true,
        temperatureSalinity: true,
        reasons: none,
      }).map((e) => e.title)
    ).toEqual(["Vertical profile", "Temperature–salinity diagram"]);
  });

  it("finds the new charts by the names scientists use", () => {
    expect(findCharts("periodogram")[0].title).toBe("Spectrum");
    expect(findCharts("100-year")[0].title).toBe("Return levels");
    expect(findCharts("moving average")[0].title).toBe("Running mean");
    expect(findCharts("ecdf")[0].title).toBe("Cumulative distribution (CDF)");
    expect(findCharts("qq")[0].title).toBe("Q–Q plot");
    expect(findCharts("water mass")[0].title).toBe(
      "Temperature–salinity diagram"
    );
    expect(findCharts("thermocline")[0].where).toBe(
      "Box — Longitude–vertical section"
    );
  });

  it("leaves out what the variable cannot make, and suggests nothing blind", () => {
    const noProfile = { ...none, [ANALYSIS_KINDS.PROFILE]: "No levels." };
    expect(suggestCharts({ vertical: true, reasons: noProfile })).toEqual([]);
    expect(suggestCharts({ reasons: none })).toEqual([]);
  });
});

describe("a smarter search (23 Nov list)", () => {
  it("forgives typos, short forms and plurals, and ignores filler words", () => {
    expect(findCharts("hovmoeller")[0].where).toMatch(/Hovmöller/);
    expect(findCharts("crossection")[0].kind).toBe(ANALYSIS_KINDS.SECTION);
    expect(findCharts("xsection")[0].kind).toBe(ANALYSIS_KINDS.SECTION);
    expect(findCharts("timeseries")[0].kind).toBe(ANALYSIS_KINDS.POINT_SERIES);
    expect(findCharts("anomlay")[0].title).toBe("Anomaly");
    expect(findCharts("show me a histogram")[0].kind).toBe(
      ANALYSIS_KINDS.DISTRIBUTION
    );
    expect(findCharts("boxplots")[0].title).toBe("Boxes by month");
  });

  it("knows what scientists look for", () => {
    expect(findCharts("mjo")[0].kind).toBe(ANALYSIS_KINDS.HOVMOLLER_LON);
    expect(findCharts("itcz")[0].kind).toBe(ANALYSIS_KINDS.HOVMOLLER_LAT);
    expect(findCharts("jet stream")[0].kind).toBe(ANALYSIS_KINDS.LAT_VERTICAL);
    expect(findCharts("radiosonde")[0].kind).toBe(ANALYSIS_KINDS.PROFILE);
    expect(findCharts("enso")[0].kind).toBe(ANALYSIS_KINDS.REGION_SERIES);
    expect(findCharts("rainfall total")[0].title).toBe("Cumulative total");
    expect(findCharts("heatwave")[0].title).toBe("Days above a value");
    expect(findCharts("model validation")[0].compare).toBeDefined();
  });
});

describe("suggestions fill up with what is looked at over time", () => {
  it("puts a temperature's trend first, then its anomaly", () => {
    expect(
      suggestCharts({
        timed: true,
        standardName: "air_temperature",
        reasons: none,
      }).map((e) => e.title)
    ).toEqual(["Trend", "Anomaly", "Annual cycle"]);
  });

  it("keeps the data's own suggestions first", () => {
    expect(
      suggestCharts({ timed: true, vertical: true, reasons: none }).map(
        (e) => e.title
      )
    ).toEqual(["Vertical profile", "Anomaly", "Annual cycle"]);
  });
});

describe("Compare's charts open Compare", () => {
  it("finds the Taylor diagram as a view of Compare, not a time series", () => {
    const [taylor] = findCharts("taylor");
    expect(taylor.compare).toBe("taylor");
    expect(taylor.turnOn).toBeUndefined();
    expect(taylor.where).toMatch(/^Compare plots/);
    expect(findCharts("q-q")[0].compare).toBe("qq");
  });
});

describe("search as you type", () => {
  it("finds from the first letters, not only from the third", () => {
    // "ti" found nothing while "tim" found Time series (23 Nov).
    for (const typed of ["t", "ti", "tim", "time"]) {
      expect(findCharts(typed).map((e) => e.title)).toContain("Time series");
    }
    // "an" is a stop word, but while typed it is the start of "anomaly".
    expect(findCharts("an").map((e) => e.title)).toContain("Anomaly");
    expect(findCharts("ru").map((e) => e.title)).toContain("Running mean");
    // Inside a word from three letters.
    expect(findCharts("sity").length).toBeGreaterThan(0);
  });
});
