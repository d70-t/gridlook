/**
 * The values a chart shows, as CSV: what a time view, a cycle, a running
 * mean, boxes, a spectrum or return levels draw, which the computed-values
 * CSV (the data as read) does not hold.
 */
import type { TSeriesSpec } from "./plotFigure.ts";
import type { TScatter } from "./scatterFigure.ts";
import { knotsPer, windFrom } from "./windBarbs.ts";
import type { TRose } from "./windFigures.ts";

const cell = (value: unknown) => {
  const text =
    typeof value === "number" && !Number.isFinite(value)
      ? ""
      : String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** One row per value on the chart's x axis; extra points listed after. */
// eslint-disable-next-line max-lines-per-function
export function chartValuesCsv(spec: TSeriesSpec) {
  const header = ["label", spec.xTitle, spec.yTitle];
  const columns: { name: string; values: (index: number) => unknown }[] = [];
  if (spec.overlay) {
    columns.push({
      name: spec.overlay.label,
      values: (i) => spec.overlay!.values[i],
    });
  }
  if (spec.fit) {
    columns.push({
      name: `fit ${spec.fit.label}`,
      values: (i) => spec.fit!.values[i],
    });
  }
  if (spec.band) {
    columns.push(
      {
        name: `${spec.band.label} (lower)`,
        values: (i) => spec.band!.lower[i],
      },
      { name: `${spec.band.label} (upper)`, values: (i) => spec.band!.upper[i] }
    );
  }
  if (spec.boxes) {
    for (const key of ["low", "q1", "median", "q3", "high"] as const) {
      columns.push({ name: key, values: (i) => spec.boxes![i]?.[key] });
    }
  }
  // Ensemble members as drawn: the fan's percentiles, and the chance above
  // a threshold with the members it counts.
  const members = spec.members;
  // Every member line the chart draws (plume, plume and fan, the faint
  // plume under a chance), then the fan's percentiles.
  if (members && members.view !== "fan") {
    members.series.forEach((series, m) =>
      columns.push({ name: `member ${m}`, values: (i) => series[i] })
    );
  }
  if (members && members.view !== "plume" && members.view !== "chance") {
    columns.push(
      { name: "members P10", values: (i) => members.p10[i] },
      { name: "members median", values: (i) => members.p50[i] },
      { name: "members P90", values: (i) => members.p90[i] }
    );
  }
  if (members?.chance) {
    const above = `above ${members.threshold}`;
    columns.push(
      { name: `members ${above} (%)`, values: (i) => members.chance!.share[i] },
      { name: `members ${above}`, values: (i) => members.chance!.above[i] },
      { name: "members with a value", values: (i) => members.chance!.valid[i] }
    );
  }
  // The wind beside the series or profile (barbs): its components as
  // drawn, with speed and direction.
  const wind = spec.wind;
  if (wind) {
    const u = wind.units ?? "m s-1";
    const knots = knotsPer(wind.units).factor;
    columns.push(
      { name: `eastward wind (${u})`, values: (i) => wind.u[i] },
      { name: `northward wind (${u})`, values: (i) => wind.v[i] },
      {
        name: "speed (kn)",
        values: (i) => Math.hypot(wind.u[i], wind.v[i]) * knots,
      },
      {
        name: wind.current ? "towards (degrees)" : "from (degrees)",
        // Calm (0, 0) has no direction: left empty, not 180°.
        values: (i) =>
          Number.isFinite(wind.u[i]) &&
          Number.isFinite(wind.v[i]) &&
          (wind.u[i] !== 0 || wind.v[i] !== 0)
            ? (windFrom(wind.u[i], wind.v[i]) + (wind.current ? 180 : 0)) % 360
            : Number.NaN,
      }
    );
  }
  const lines = [
    [...header, ...columns.map((c) => c.name)].map(cell).join(","),
  ];
  spec.x.forEach((x, i) => {
    lines.push(
      [
        spec.readout(i)[0] ?? "",
        x,
        spec.y[i],
        ...columns.map((c) => c.values(i)),
      ]
        .map(cell)
        .join(",")
    );
  });
  if (spec.points) {
    lines.push(
      "",
      [spec.points.label, spec.xTitle, spec.yTitle].map(cell).join(",")
    );
    spec.points.x.forEach((x, i) => {
      lines.push(["", x, spec.points!.y[i]].map(cell).join(","));
    });
  }
  // A distribution's curves, each at its own values.
  for (const curve of spec.distribution?.curves ?? []) {
    lines.push(
      "",
      [curve.label, spec.xTitle, "share per bin (%)"].map(cell).join(",")
    );
    curve.x.forEach((x, i) =>
      lines.push(["", x, curve.y[i]].map(cell).join(","))
    );
  }
  return `${lines.join("\n")}\n`;
}

/** A rose as drawn: per sector, the share of samples in each speed class. */
export function roseCsv(rose: TRose) {
  const sectors = rose.sectors.length;
  const way = rose.convention === "from" ? "from" : "towards";
  const lines = [
    [
      `sector (${way}, degrees)`,
      ...rose.classes.map((c) => `speed ${c} m s-1 (%)`),
      "all (%)",
    ]
      .map(cell)
      .join(","),
  ];
  rose.sectors.forEach((shares, k) =>
    lines.push(
      [(k * 360) / sectors, ...shares, shares.reduce((a, b) => a + b, 0)]
        .map(cell)
        .join(",")
    )
  );
  lines.push(
    [`calm, below ${rose.calmBelow} m s-1 (%)`, rose.calm].map(cell).join(","),
    ["samples", rose.n].map(cell).join(",")
  );
  return `${lines.join("\n")}\n`;
}

/**
 * A hodograph as drawn: the wind vector at each level, the level as its
 * index and its full value with units (1000.1 and 1000.2 hPa stay apart).
 */
export function hodographCsv(wind: {
  u: number[];
  v: number[];
  units?: string;
  levels: number[];
  levelUnits?: string;
}) {
  const u = wind.units ?? "m s-1";
  const lines = [
    [
      "level index",
      `level${wind.levelUnits ? ` (${wind.levelUnits})` : ""}`,
      `eastward (${u})`,
      `northward (${u})`,
    ]
      .map(cell)
      .join(","),
  ];
  wind.u.forEach((east, at) =>
    lines.push([at, wind.levels[at], east, wind.v[at]].map(cell).join(","))
  );
  return `${lines.join("\n")}\n`;
}

/** A scatter as drawn: its points, and where a profile's line breaks. */
export function scatterCsv(s: TScatter) {
  const breaks = new Set(s.breaks);
  // Both area means' valid shares, so a reader sees what each point pairs.
  const shares = s.coverage;
  const lines = [
    [
      s.xTitle,
      s.yTitle,
      ...(s.joined ? ["starts a line"] : []),
      ...(shares
        ? [`valid area of ${s.xTitle} (%)`, `valid area of ${s.yTitle} (%)`]
        : []),
    ]
      .map(cell)
      .join(","),
  ];
  s.x.forEach((x, at) =>
    lines.push(
      [
        x,
        s.y[at],
        ...(s.joined ? [at === 0 || breaks.has(at) ? 1 : 0] : []),
        ...(shares ? [shares.x[at] * 100, shares.y[at] * 100] : []),
      ]
        .map(cell)
        .join(",")
    )
  );
  return `${lines.join("\n")}\n`;
}
