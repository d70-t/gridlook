import { afterEach, expect, it, vi } from "vitest";

import { projectGridToLonLat } from "@/lib/data/crsInverse.ts";
import { CurvilinearWorkerRequestType } from "@/lib/grids/curvilinearWorkerProtocol.ts";
import { GridGeometryWorkerMessageType } from "@/lib/grids/gridGeometryWorkerProtocol.ts";

type TPosted = {
  message: { type: string; hoverIndexData?: unknown };
  transfer: Transferable[];
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("answers a project request with transferred lon/lat", async () => {
  const posted: TPosted[] = [];
  const scope = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (message: TPosted["message"], transfer: Transferable[] = []) =>
      posted.push({ message, transfer }),
  };
  vi.stubGlobal("self", scope);
  await import("@/lib/grids/curvilinear.worker.ts");

  const x = new Float32Array([0, 1000]);
  const y = new Float32Array([0, -1000, 2000]);
  const crs =
    "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +ellps=WGS84 +units=m +no_defs";
  scope.onmessage!({
    data: {
      requestId: 7,
      type: CurvilinearWorkerRequestType.PROJECT,
      x,
      y,
      crs,
    },
  });

  expect(posted.map(({ message }) => message.type)).toEqual([
    GridGeometryWorkerMessageType.METADATA,
    GridGeometryWorkerMessageType.HOVER_INDEX,
    GridGeometryWorkerMessageType.DONE,
  ]);
  const result = posted[1].message.hoverIndexData as {
    latitudes: Float32Array;
    longitudes: Float32Array;
  };
  expect(result).toEqual(projectGridToLonLat(x, y, crs));
  expect(posted[1].transfer).toEqual([
    result.latitudes.buffer,
    result.longitudes.buffer,
  ]);
});
