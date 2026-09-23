import { expect, it } from "vitest";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import type { TVariableTableRow } from "@/ui/overlays/infoPanel/types.ts";
import VariableTableSection from "@/ui/overlays/infoPanel/VariableTableSection.vue";

const rows: TVariableTableRow[] = [
  {
    name: "atmosphere/tas",
    hidden: false,
    attrs: {},
    dimensions: ["time"],
    dtype: "float32",
    error: null,
  },
  {
    name: "atmosphere/time",
    hidden: true,
    attrs: {},
    dimensions: ["time"],
    dtype: "float64",
    error: null,
  },
  {
    name: "ocean/tas",
    hidden: false,
    attrs: {},
    dimensions: ["time"],
    dtype: "float32",
    error: null,
  },
];

function render(searchQuery = "", selectedVariable = "atmosphere/tas") {
  return renderToString(
    createSSRApp(VariableTableSection, {
      rows,
      emptyLabel: "Empty",
      selectedAttributesVariable: null,
      selectedVariable,
      showVisualize: true,
      searchQuery,
    })
  );
}

it("uses one expandable per group with separate data and coordinate tables", async () => {
  const html = await render();
  expect(html.match(/variable-group-toggle/g)).toHaveLength(2);
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/g)].map(
    (match) => match[0]
  );
  expect(tables).toHaveLength(2);
  expect(tables[0]).toContain('aria-label="atmosphere Data Variables"');
  expect(tables[0]).toContain('aria-label="Visualize atmosphere/tas"');
  expect(tables[0]).not.toContain('title="atmosphere/time"');
  expect(tables[1]).toContain('aria-label="atmosphere Coordinates"');
  expect(tables[1]).toContain('title="atmosphere/time"');
  expect(tables[1]).not.toContain('aria-label="Visualize');
  expect(html).not.toContain('title="ocean/tas"');
});

it("puts the current variable's group first and expands it", async () => {
  const html = await render("", "ocean/tas");
  const groups = [...html.matchAll(/class="group-name"[^>]*>([^<]+)</g)].map(
    (match) => match[1]
  );
  expect(groups).toEqual(["ocean", "atmosphere"]);
  expect(html).toContain('aria-label="ocean Data Variables"');
  expect(html).toContain('title="ocean/tas"');
  expect(html).not.toContain('title="atmosphere/tas"');
});

it("searches collapsed groups and retains full paths in the results", async () => {
  const html = await render("TAS");
  expect(html).not.toContain("variable-group-toggle");
  expect(html).toContain('title="atmosphere/tas"');
  expect(html).toContain('title="ocean/tas"');
  expect(html).not.toContain('title="atmosphere/time"');
  expect(html).toContain("No coordinates");
});

it("shows a clear empty state for searches without matches", async () => {
  const html = await render("missing");
  expect(html).toContain("No matches");
  expect(html).not.toContain("<table");
});

it("links a dimension only when a matching coordinate variable exists", async () => {
  // atmosphere/tas has dimension "time", and atmosphere/time exists as a coordinate.
  const atmosphereHtml = await render("", "atmosphere/tas");
  expect(atmosphereHtml).toMatch(/atmosphere\/tas[\s\S]*?<a[^>]*>time<\/a>/);

  // ocean/tas also has dimension "time", but no ocean/time coordinate exists.
  const oceanHtml = await render("", "ocean/tas");
  expect(oceanHtml).toContain('title="ocean/tas"');
  expect(oceanHtml).not.toMatch(/ocean\/tas[\s\S]*?<a[^>]*>time<\/a>/);
});

it("links a coordinate's own dimension to itself instead of showing it as plain text", async () => {
  // atmosphere/time is a coordinate whose only dimension is itself ("time").
  const html = await render();
  expect(html).toMatch(/title="atmosphere\/time"[\s\S]*?<a[^>]*>time<\/a>/);
});
