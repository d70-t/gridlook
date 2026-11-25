/**
 * Signed shorts marked _Unsigned with no fill are 40000 where netCDF4-Python
 * and native uint16 say so.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { NetCDF4 } from "@earthyscience/netcdf4-wasm";
import { expect, it, vi } from "vitest";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { loadNetCDFModule } from "@/lib/analysis/netcdfWriter.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { openNetCDFAnalysisDataset } from "@/lib/analysis/sourceAdapter.ts";
import { ALGORITHM_VERSION, ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import * as netCDF from "@/lib/data/netCDF.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";

const here = dirname(fileURLToPath(import.meta.url));

it.each([
  ["implicit-fill.nc", 10, 0.25],
  ["signed.nc", 10, 0.25],
  ["unsigned.nc", 10, 0.25],
  ["unsigned-flag.nc", 10, 0.25],
  ["f32-default-range.nc", 10, 0.25],
  ["i16-default-range.nc", 10, 0.25],
  ["i64-explicit-range.nc", 10, 0.25],
  ["i16-unsigned-explicit.nc", 10, 0.25],
  ["u16-explicit.nc", 10, 0.25],
  // Four observed values, 10 and three of 40000, in either encoding.
  ["i16-unsigned-legitimate.nc", 30002.5, 1],
  ["u16-legitimate.nc", 30002.5, 1],
])("%s: mean %d at coverage %d", async (name, mean, coverage) => {
  const dist = realpathSync("node_modules/@earthyscience/netcdf4-wasm/dist");
  const raw = await loadNetCDFModule({
    wasmBinary: readFileSync(`${dist}/netcdf4-wasm.wasm`),
  });
  const { WasmModuleLoader } = await import(
    pathToFileURL(`${dist}/wasm-module.js`).href
  );
  vi.spyOn(WasmModuleLoader, "loadModule").mockResolvedValue(
    WasmModuleLoader.wrapModule(raw)
  );
  vi.spyOn(NetCDF4, "fromBlobLazy").mockImplementation((blob) =>
    NetCDF4.fromBlob(blob)
  );
  ZarrDataManager.registerNetCDFBackend({
    getArray: netCDF.getNetCDFArray,
    invalidateCache: netCDF.invalidateNetCDFCache,
    openArray: netCDF.openNetCDFArray,
    openGroup: netCDF.openNetCDFGroup,
    resolveGroup: netCDF.resolveNetCDFGroup,
  } as never);
  const file = new File(
    [readFileSync(join(here, "netcdfFixtures", name))],
    name
  );
  const dataset = openNetCDFAnalysisDataset({
    store: name,
    dataset: "",
    file,
  } as never);
  const context = await resolveVariableContext(dataset, "v", new ByteLru(1024));
  const plan = await planAnalysis(
    context,
    {
      version: ALGORITHM_VERSION,
      kind: ANALYSIS_KINDS.REGION_SERIES,
      source: { ref: "local", versionStatus: "session" },
      variable: "v",
      geometry: { kind: "box", west: -1, east: 11, south: -6, north: 6 },
      fixed: {},
    },
    new ReadContext()
  );
  const result = await plan.execute();
  expect(result.values[0]).toBeCloseTo(mean, 6);
  expect(result.region!.coverage![0]).toBeCloseTo(coverage, 6);
});
