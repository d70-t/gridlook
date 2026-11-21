import { describe, expect, it } from "vitest";

import {
  composeDatasets,
  isMissing,
  openReferenced,
  type TAnalysisDataset,
} from "@/lib/analysis/sourceAdapter.ts";

/** A store that serves some arrays, fails others, and counts its opens. */
function store(key: string, has: string[], fails: Record<string, string> = {}) {
  const opened: string[] = [];
  const dataset = {
    key,
    format: 3,
    stats: { requests: 0 },
    async openArray(path: string) {
      opened.push(path);
      if (fails[path]) {
        throw new Error(fails[path]);
      }
      if (!has.includes(path)) {
        throw Object.assign(new Error(`Not found: ${path}`), {
          name: "NotFoundError",
        });
      }
      return { key: `${key}|${path}` };
    },
    async groupAttrs() {
      return null;
    },
  } as unknown as TAnalysisDataset;
  return { dataset, opened };
}

describe("a route serves an array only when the owner has none (v20 review)", () => {
  it("a 503 on the grid store's bounds is an error, not a fallback", async () => {
    const data = store("src|data|", ["temp", "lat_bnds"]);
    const grid = store("src|grid|", ["lat"], {
      lat_bnds: "Unexpected response status 503", // eslint-disable-line camelcase
    });
    const level = composeDatasets(data.dataset, [grid.dataset]);
    const lat = await level.openArray("lat");
    await expect(
      openReferenced(level, lat as never, "lat_bnds")
    ).rejects.toThrow(/lat_bnds in grid: Unexpected response status 503/);
    // The data store's same-named array was never opened instead.
    expect(data.opened).not.toContain("lat_bnds");
  });

  it("a missing array is looked up in the other stores", async () => {
    const data = store("src|data|", ["temp"]);
    const grid = store("src|grid|", ["clat"]);
    const level = composeDatasets(data.dataset, [grid.dataset]);
    expect(((await level.openArray("clat")) as { key: string }).key).toBe(
      "src|grid||clat"
    );
    const failing = composeDatasets(
      store("src|data|", [], { clat: "403 Forbidden" }).dataset,
      [grid.dataset]
    );
    await expect(failing.openArray("clat")).rejects.toThrow(
      /clat in data: 403 Forbidden/
    );
  });

  it("tells missing from failed", () => {
    expect(
      isMissing(Object.assign(new Error("x"), { name: "NotFoundError" }))
    ).toBe(true);
    expect(isMissing(new Error("Request failed with status 404"))).toBe(true);
    expect(isMissing(new Error("Unexpected response status 503"))).toBe(false);
  });
});
