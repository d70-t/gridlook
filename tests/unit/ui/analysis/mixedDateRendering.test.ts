import { expect, it } from "vitest";

import {
  axisRows,
  seriesDateLayout,
  unreadDateSpans,
} from "@/ui/analysis/seriesDates.ts";

// Small exhaustive reference: each distinct time owns its midpoint-to-midpoint
// cell and is visible as soon as any source row at that time has been read.
function referenceSpans(dates: number[], read: number, minimumWidth: number) {
  const sorted = [...new Set(dates.filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
  const edges = sorted.map((time, index) =>
    index ? (sorted[index - 1] + time) / 2 : time
  );
  edges.push(sorted[sorted.length - 1]);
  const seen = new Set(dates.slice(0, read));
  const spans: number[][] = [];
  for (let group = 0; group < sorted.length;) {
    if (seen.has(sorted[group])) {
      group++;
      continue;
    }
    const start = group;
    while (group < sorted.length && !seen.has(sorted[group])) {
      group++;
    }
    if (edges[group] - edges[start] >= minimumWidth) {
      spans.push([edges[start], edges[group]]);
    }
  }
  return spans;
}

it("keeps chronological source rows and unread gaps through forward and backward progress", () => {
  for (let variant = 0; variant < 4; variant++) {
    const dates = Array.from({ length: 67 }, (_, row) =>
      (row + variant) % 9 === 0 ? NaN : ((row * 47 + variant) % 29) ** 2
    );
    const layout = seriesDateLayout(dates);
    const rows = dates
      .map((date, row) => ({ date, row }))
      .filter(({ date }) => Number.isFinite(date))
      .sort((a, b) => a.date - b.date);
    for (let step = 0; step <= dates.length; step++) {
      // Alternate almost-complete and sparse prefixes, like a shared view
      // reopening or switching its selected date range.
      const read = step % 2 ? dates.length - (step - 1) / 2 : step / 2;
      expect(axisRows(dates, read)).toEqual(
        rows.filter(({ row }) => row < read).map(({ row }) => row)
      );
      for (const width of [0, 7, 80]) {
        expect(unreadDateSpans(dates, layout, read, width)).toEqual(
          referenceSpans(dates, read, width)
        );
      }
    }
  }
});
