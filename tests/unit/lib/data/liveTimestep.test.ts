import axios, { AxiosError, AxiosHeaders } from "axios";
import { afterEach, expect, it, vi } from "vitest";

import {
  LiveTimestepController,
  fetchCurrentTimestep,
  fetchNextTimestep,
  liveStoreBaseUrl,
  timestepEndpointUrl,
} from "@/lib/data/liveTimestep.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

function makeSources(store: string): TSources {
  return {
    zarr_format: ZARR_FORMAT.V2, // eslint-disable-line camelcase
    levels: [
      {
        time: { store, dataset: "" },
        grid: { store, dataset: "" },
        datasources: {},
      },
    ],
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const signal = new AbortController().signal;

afterEach(() => {
  vi.restoreAllMocks();
});

it("joins the base URL and endpoint, normalizing trailing slashes", () => {
  expect(timestepEndpointUrl("https://h/d.zarr", "current-timestep")).toBe(
    "https://h/d.zarr/current-timestep"
  );
  expect(timestepEndpointUrl("https://h/d.zarr/", "next-timestep")).toBe(
    "https://h/d.zarr/next-timestep"
  );
});

it("resolves the normalized HTTP store URL for a fetch-backed dataset", () => {
  expect(liveStoreBaseUrl(makeSources("https://h/d.zarr/"))).toBe(
    "https://h/d.zarr"
  );
});

it("returns undefined for an icechunk store (live mode is HTTP-only)", () => {
  expect(
    liveStoreBaseUrl(makeSources("icechunk+https://h/repo"))
  ).toBeUndefined();
});

it("parses the timestep from the current-timestep endpoint", async () => {
  const getMock = vi
    .spyOn(axios, "get")
    .mockResolvedValue({ data: { timestep: 7 } });

  await expect(fetchCurrentTimestep("https://h/d.zarr", signal)).resolves.toBe(
    7
  );
  expect(getMock).toHaveBeenCalledWith(
    "https://h/d.zarr/current-timestep",
    expect.objectContaining({ signal })
  );
});

it("accepts a numeric string in the timestep field", async () => {
  vi.spyOn(axios, "get").mockResolvedValue({ data: { timestep: "42" } });
  await expect(fetchCurrentTimestep("https://h/d.zarr", signal)).resolves.toBe(
    42
  );
});

it("long-polls the next-timestep endpoint", async () => {
  const getMock = vi
    .spyOn(axios, "get")
    .mockResolvedValue({ data: { timestep: 8 } });

  await expect(fetchNextTimestep("https://h/d.zarr", signal)).resolves.toBe(8);
  expect(getMock).toHaveBeenCalledWith(
    "https://h/d.zarr/next-timestep",
    expect.objectContaining({ signal })
  );
});

it("throws on a non-OK response", async () => {
  vi.spyOn(axios, "get").mockRejectedValue(
    new AxiosError("Request failed", undefined, undefined, undefined, {
      status: 503,
      data: {},
      statusText: "Service Unavailable",
      headers: {},
      config: { headers: new AxiosHeaders() },
    })
  );
  await expect(
    fetchCurrentTimestep("https://h/d.zarr", signal)
  ).rejects.toThrow(/HTTP 503/);
});

it("throws on an invalid payload", async () => {
  vi.spyOn(axios, "get").mockResolvedValue({ data: { timestep: "nope" } });
  await expect(
    fetchCurrentTimestep("https://h/d.zarr", signal)
  ).rejects.toThrow(/invalid payload/);
});

it("rejects negative or non-integer timesteps", async () => {
  vi.spyOn(axios, "get").mockResolvedValue({ data: { timestep: -1 } });
  await expect(
    fetchCurrentTimestep("https://h/d.zarr", signal)
  ).rejects.toThrow(/invalid payload/);
});

it("emits the current timestep first, then follows subsequent ones", async () => {
  // current-timestep -> 5, next-timestep -> 6, then park (never resolves).
  let call = 0;
  const getMock = vi.spyOn(axios, "get").mockImplementation(() => {
    call += 1;
    if (call === 1) {
      return Promise.resolve({ data: { timestep: 5 } });
    }
    if (call === 2) {
      return Promise.resolve({ data: { timestep: 6 } });
    }
    return new Promise(() => {}); // pending long-poll
  });

  const seen: number[] = [];
  const connected: boolean[] = [];
  const controller = new LiveTimestepController({
    baseUrl: "https://h/d.zarr",
    onTimestep: (t) => seen.push(t),
    onConnectedChange: (c) => connected.push(c),
  });
  controller.start();
  await flush();
  await flush();
  await flush();
  controller.stop();

  expect(seen).toEqual([5, 6]);
  expect(getMock).toHaveBeenNthCalledWith(
    1,
    "https://h/d.zarr/current-timestep",
    expect.anything()
  );
  expect(getMock).toHaveBeenNthCalledWith(
    2,
    "https://h/d.zarr/next-timestep",
    expect.anything()
  );
  expect(connected).toContain(true);
  expect(connected[connected.length - 1]).toBe(false); // stop() disconnects
});

it("does not emit after stop() is called before start()", async () => {
  vi.spyOn(axios, "get").mockResolvedValue({ data: { timestep: 1 } });

  const seen: number[] = [];
  const controller = new LiveTimestepController({
    baseUrl: "https://h/d.zarr",
    onTimestep: (t) => seen.push(t),
  });
  controller.stop();
  controller.start();
  await flush();

  expect(seen).toEqual([]);
});
