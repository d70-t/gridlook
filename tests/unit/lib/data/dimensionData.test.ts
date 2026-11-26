import { expect, it, vi } from "vitest";
import type * as zarr from "zarrita";

import { fetchDimensionDetails } from "@/lib/data/dimensionData.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";

vi.mock("@/lib/data/ZarrDataManager.ts", () => ({
  ZarrDataManager: {
    getVariableData: vi.fn(),
    getVariableInfo: vi.fn(),
    resolveVariablePath: vi.fn((_variable: string, name: string) => name),
  },
}));

it("treats a time dimension without '<unit> since <date>' as a plain dimension", async () => {
  vi.mocked(ZarrDataManager.getVariableData).mockResolvedValue({
    data: new Int16Array([1, 2, 3]),
  } as unknown as zarr.Chunk<zarr.DataType>);
  vi.mocked(ZarrDataManager.getVariableInfo).mockResolvedValue({
    attrs: { units: "months" },
  } as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>);
  const source = { store: "", dataset: "" };
  const datasources = {
    levels: [{ time: source, datasources: { tem: source } }],
  } as unknown as TSources;

  const [time] = await fetchDimensionDetails(
    "tem",
    datasources,
    [{ name: "time", startPos: 0, minBound: 0, maxBound: 2 }],
    [1]
  );

  expect(time).toMatchObject({ current: 2, units: "months" });
});
