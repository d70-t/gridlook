import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { resultTable, resultToCsv } from "@/lib/analysis/analysisExport.ts";
import { pythonScript } from "@/lib/analysis/pythonExport.ts";
import { ANALYSIS_KINDS, type TAnalysisResult } from "@/lib/analysis/types.ts";

const TAMPA = JSON.parse(
  readFileSync(path.join(__dirname, "gefsFixtures", "gefs-tampa.json"), "utf8")
) as TAnalysisResult;

const HAS_PLOTTING = (() => {
  try {
    execFileSync("python3", ["-c", "import pandas, matplotlib"]);
    return true;
  } catch {
    return false;
  }
})();

it("the forecast series script plots the field column", ({ skip }) => {
  const script = pythonScript(TAMPA, "Tampa", "Tampa");
  expect(script).toContain('ax.set_ylabel("temperature_2m');
  if (!HAS_PLOTTING) {
    skip();
  }
  // Runs the script headless; prints the plotted y values.
  const run = String.raw`
import sys, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.figure import Figure
plt.show = lambda *a, **k: None
plt.savefig = lambda *a, **k: None
Figure.savefig = lambda *a, **k: None
code = sys.stdin.read()
env = {"__name__": "__main__"}
exec(code, env)
line = plt.gcf().axes[0].lines[0]
print(",".join(str(v) for v in line.get_ydata()))
`;
  const out = execFileSync("python3", ["-I", "-c", run], {
    input: script,
    encoding: "utf8",
    cwd: mkdtempSync(path.join(tmpdir(), "figure-")),
  });
  expect(out.trim().split(",").map(Number)).toEqual(TAMPA.values);
});

it("a longitude × time forecast CSV names its valid times and lead", () => {
  const lead = TAMPA.selections!.find(
    (s) => s.standardName === "forecast_period"
  )!;
  const grid = {
    ...TAMPA,
    kind: ANALYSIS_KINDS.HOVMOLLER_LON,
    shape: [12, 1],
    axis: { dimension: "longitude", values: [-82.5], units: "degrees_east" },
    query: { ...TAMPA.query, kind: ANALYSIS_KINDS.HOVMOLLER_LON },
  } as unknown as TAnalysisResult;
  const table = resultTable(grid);
  expect(table.header[1]).toMatch(/^forecast_reference_time/);
  const valid = table.header.findIndex((h) => h.startsWith("valid_time"));
  expect(valid).toBeGreaterThan(0);
  const series = resultTable(TAMPA);
  const seriesValid = series.header.findIndex((h) =>
    h.startsWith("valid_time")
  );
  for (let t = 0; t < 12; t++) {
    expect(table.row(t)[valid]).toBe(series.row(t)[seriesValid]);
    expect(table.row(t)[valid + 1]).toBe(lead.value);
  }
  // The raw time stays the last column, the scripts' anchor.
  expect(table.header.at(-1)).toMatch(/^init_time/);
  expect(resultToCsv(grid)).toContain("valid_time");
});

it("a preview of 500 rows formats valid times for those rows only", () => {
  const n = 200_000;
  let reads = 0;
  const raw = Array.from({ length: n }, (_, i) => 1727740800 + i * 3600);
  const counted = new Proxy(raw, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        reads++;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const big = {
    ...TAMPA,
    time: { ...TAMPA.time!, raw: counted },
    values: new Array(n).fill(26.5),
    shape: [n],
    query: { ...TAMPA.query, time: { start: 0, stop: n } },
  } as unknown as TAnalysisResult;
  const table = resultTable(big);
  for (let at = 0; at < 500; at++) {
    table.row(at);
  }
  // Raw, reference label and valid label: three per row, no whole axis.
  expect(reads).toBeLessThanOrEqual(1500);
});
