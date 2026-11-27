/* eslint-disable max-lines-per-function, camelcase -- fixture-heavy grid cases with CF metadata. */
import proj4 from "proj4";
import * as THREE from "three";
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import {
  countryContains,
  prepareCountry,
} from "@/lib/analysis/countryRegion.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { crsUnitMetres } from "@/lib/analysis/projectedGrid.ts";
import {
  frameProject,
  frameRule,
  type TScreenFrame,
} from "@/lib/analysis/screenFrame.ts";
import { editHandles, moveHandle } from "@/lib/analysis/shapeEdit.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import type { TShapeGeometry } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";
import { rectangleSelection } from "@/ui/analysis/boxFootprint.ts";

type TStore = Map<string, Uint8Array>;

/** The globe seen from `height` radii over (lat, 3°E), 1152 × 850 px. */
function globeView(lat: number, height: number) {
  const helper = new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
    lat: 0,
    lon: 0,
  });
  const camera = new THREE.PerspectiveCamera(30, 1152 / 850, 1e-6, 10);
  const [x, y, z] = helper.project(lat, 3);
  camera.position.set(x * height, y * height, z * height);
  camera.up.set(0, 0, 1);
  camera.lookAt(x, y, z);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const viewport = { left: 384, top: 0, width: 1152, height: 850 };
  const view: Omit<TScreenFrame, "rect" | "band"> = {
    projection: { type: helper.type, center: { lat: 0, lon: 0 } },
    view: [...camera.matrixWorldInverse.elements],
    lens: [...camera.projectionMatrix.elements],
    eye: camera.position.toArray() as [number, number, number],
    viewport,
  };
  const raycaster = new THREE.Raycaster();
  const sphere = new THREE.Sphere(new THREE.Vector3(), 1);
  const hit = new THREE.Vector3();
  const pick = (cx: number, cy: number) => {
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((cx - viewport.left) / viewport.width) * 2 - 1,
        -((cy - viewport.top) / viewport.height) * 2 + 1
      ),
      camera
    );
    return raycaster.ray.intersectSphere(sphere, hit)
      ? ProjectionHelper.cartesianToLatLon(hit.x, hit.y, hit.z)
      : null;
  };
  const project = (la: number, lo: number) =>
    frameProject(view, helper, la, lo) ?? null;
  return { pick, project, view };
}

it("an edited Box's mask is its drawn quadrilateral, far from the old trace too", () => {
  for (const [lat, w, t, dx, dy] of [
    [47, 200, 120, -100, 120],
    [70, 190, 95, -130, 85],
    [35, 185, 115, 110, 80],
  ]) {
    const { pick, project, view } = globeView(lat, 1.25);
    const centre = project(lat, 3)!;
    const from = { x: centre.x - w, y: centre.y - t };
    const to = { x: centre.x + w, y: centre.y + t };
    const drawn = rectangleSelection(pick, project, from, to, false, true, view)
      ?.geometry as TShapeGeometry;
    expect(drawn?.frame, `${lat}`).toBeDefined();
    const handles = editHandles(drawn);
    const near = handles.reduce((best, h, at) => {
      const [a, b] = [
        project(h.lat, h.lon)!,
        project(handles[best].lat, handles[best].lon)!,
      ];
      return Math.hypot(a.x - from.x, a.y - from.y) <
        Math.hypot(b.x - from.x, b.y - from.y)
        ? at
        : best;
    }, 0);
    const edited = moveHandle(
      drawn,
      handles[near],
      pick(from.x + dx, from.y + dy)!
    ) as TShapeGeometry;
    const rule = frameRule(edited.frame!);
    const region = prepareCountry(edited.polygons, edited.poles);
    region.frame = rule;
    const quad = edited.frame!.quad!;
    let probes = 0;
    for (let side = 0; side < 4; side++) {
      const [[ax, ay], [bx, by]] = [quad[side], quad[(side + 1) % 4]];
      const norm = Math.hypot(bx - ax, by - ay);
      for (let j = 1; j <= 20; j++) {
        const u = j / 21;
        for (const offset of [-30, -10, -3, -1, 1, 3, 10, 30]) {
          const p = pick(
            ax * (1 - u) + bx * u - (offset * (by - ay)) / norm,
            ay * (1 - u) + by * u + (offset * (bx - ax)) / norm
          );
          if (p) {
            probes++;
            expect(
              countryContains(region, p.lat, p.lon),
              `${lat} ${side} ${offset}`
            ).toBe(rule.inside(p.lat, p.lon));
          }
        }
      }
    }
    expect(probes).toBeGreaterThan(500);
  }
});

async function put(
  s: TStore,
  name: string,
  shape: number[],
  dims: string[],
  values: number[],
  attrs: Record<string, unknown> = {}
) {
  const a = await zarr.create(zarr.root(s).resolve(name), {
    shape,
    chunkShape: shape.length ? shape : [],
    dimensionNames: dims,
    dtype: "float64",
    fillValue: Number.NaN,
    attributes: attrs,
  });
  if (shape.length) {
    await zarr.set(a as never, null, {
      shape,
      stride: shape.map((_, i) =>
        shape.slice(i + 1).reduce((p, n) => p * n, 1)
      ),
      data: Float64Array.from(values),
    } as never);
  }
}

let unique = 0;
async function context(s: TStore) {
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      s as never,
      "",
      ZARR_FORMAT.V3,
      `g50-${unique++}`
    ),
    "v",
    new ByteLru(2 ** 22)
  );
}

async function store() {
  const s: TStore = new Map();
  await zarr.create(zarr.root(s), { attributes: {} });
  await put(s, "time", [1], ["time"], [0], { units: "days since 2001-01-01" });
  return s;
}

async function value(
  c: Awaited<ReturnType<typeof context>>,
  geometry: Record<string, unknown>
) {
  const kind = geometry.kind === "point" ? "point-series" : "region-series";
  const q = {
    kind,
    version: 1,
    variable: "v",
    fixed: {},
    time: { start: 0, stop: 1 },
    geometry,
    source: { ref: "local", versionStatus: "best-effort" },
  };
  const out = await (
    await planAnalysis(c, q as never, new ReadContext())
  ).execute();
  return out;
}

it("a missing halo ghost keeps the other copies out of the mean", async () => {
  const [N, ny, halo] = [12, 8, 5];
  const nx = N + 2 * halo;
  const s = await store();
  const [lats, lons, temps]: number[][] = [[], [], []];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const col = (N + i - halo) % N;
      const missing = i === 1 && j === 3;
      lats.push(
        missing
          ? Number.NaN
          : -35 + 10 * j + 0.2 * Math.sin((2 * Math.PI * col) / N)
      );
      lons.push(missing ? Number.NaN : -165 + 30 * col + 0.2 * j);
      temps.push(col === 0 ? 120 : 0);
    }
  }
  await put(s, "lat", [ny, nx], ["y", "x"], lats, {
    standard_name: "latitude",
    units: "degrees_north",
  });
  await put(s, "lon", [ny, nx], ["y", "x"], lons, {
    standard_name: "longitude",
    units: "degrees_east",
  });
  await put(
    s,
    "area",
    [ny, nx],
    ["y", "x"],
    lats.map(() => 1),
    { standard_name: "cell_area", units: "m2" }
  );
  await put(s, "v", [1, ny, nx], ["time", "y", "x"], temps, {
    units: "K",
    coordinates: "lat lon",
    cell_measures: "area: area",
  });
  const out = await value(await context(s), {
    kind: "box",
    west: -180,
    east: 180,
    south: -85,
    north: 85,
  });
  expect(out.region!.validCells[0]).toBe(96);
  expect(out.values[0]).toBeCloseTo(10, 12);
});

it("a CRS's horizontal unit is its own, and an unknown one is refused", () => {
  const geo =
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
  const feet = `PROJCS["Mercator ft",${geo},PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["foot",0.3048]]`;
  const compound = `COMPD_CS["with heights",${feet},VERT_CS["EGM96 height",VERT_DATUM["EGM96 geoid",2005],UNIT["metre",1],AXIS["Up",UP]]]`;
  expect(crsUnitMetres(feet)).toBe(0.3048);
  expect(crsUnitMetres(compound)).toBe(0.3048);
  expect(crsUnitMetres("+proj=merc +units=kmi")).toBe(1852);
  expect(crsUnitMetres("+proj=merc +units=km")).toBe(1000);
  expect(crsUnitMetres("+proj=merc")).toBe(1);
});

async function utm(bounds: number[], crs: string, unit = "m") {
  const s = await store();
  const factor = unit === "ft" ? 1 / 0.3048 : 1;
  const xs = [500000, 501000, 502000];
  await put(
    s,
    "x",
    [3],
    ["x"],
    xs.map((v) => v * factor),
    {
      standard_name: "projection_x_coordinate",
      units: unit,
      bounds: "xb",
    }
  );
  await put(
    s,
    "xb",
    [3, 2],
    ["x", "nv"],
    bounds.map((v) => v * factor)
  );
  await put(s, "y", [2], ["y"], [0, 1000 * factor], {
    standard_name: "projection_y_coordinate",
    units: unit,
  });
  await put(s, "crs", [], [], [], {
    grid_mapping_name: "transverse_mercator",
    proj4: crs,
  });
  await put(s, "v", [1, 2, 3], ["time", "y", "x"], [0, 100, 80, 0, 100, 80], {
    grid_mapping: "crs",
    units: "K",
  });
  return context(s);
}

it("a damaged far side keeps a cell's published near side; foot axes are read", async () => {
  const crs = "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs";
  const [lon, lat] = proj4(crs, "EPSG:4326", [500300, 100]);
  const c = await utm(
    [499500, 500100, 500100, Number.NaN, 501500, 502500],
    crs
  );
  expect((await value(c, { kind: "point", lon, lat })).values[0]).toBe(100);
  const ft = await utm(
    [499500, 500100, 500100, 501500, 501500, 502500],
    "+proj=utm +zone=31 +datum=WGS84 +units=ft +no_defs",
    "ft"
  );
  expect((await value(ft, { kind: "point", lon, lat })).values[0]).toBe(100);
});

it("points are located in a polar grid's own x/y, and large cells weighed along their sides", async () => {
  const crs =
    "+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +datum=WGS84 +units=m +no_defs";
  const s = await store();
  for (const [name, values, edges] of [
    ["x", [500000, 1500000, 2500000], [0, 1e6, 1e6, 2e6, 2e6, 3e6]],
    ["y", [-1500000, -500000], [-2e6, -1e6, -1e6, 0]],
  ] as const) {
    await put(s, name, [values.length], [name], [...values], {
      standard_name: `projection_${name}_coordinate`,
      units: "m",
      bounds: `${name}b`,
    });
    await put(s, `${name}b`, [values.length, 2], [name, "nv"], [...edges]);
  }
  await put(s, "crs", [], [], [], {
    grid_mapping_name: "polar_stereographic",
    proj4: crs,
  });
  const temps = [0, 100, 80, 0, 100, 80];
  await put(s, "v", [1, 2, 3], ["time", "y", "x"], temps, {
    units: "K",
    grid_mapping: "crs",
  });
  const c = await context(s);
  for (const dx of [-300, -100, 100, 300, 1000]) {
    const [lon, lat] = proj4(crs, "EPSG:4326", [1e6 + dx, -500000]);
    expect(
      (await value(c, { kind: "point", lon, lat })).values[0],
      `${dx}`
    ).toBe(dx < 0 ? 0 : 100);
  }
  // Against the cells integrated along their straight sides (1,024 steps).
  const forward = proj4(crs, "EPSG:4326");
  const DEG = Math.PI / 180;
  const areas: number[] = [];
  for (const Y of [-2e6, -1e6]) {
    for (const X of [0, 1e6, 2e6]) {
      const corners = [
        [X, Y],
        [X + 1e6, Y],
        [X + 1e6, Y + 1e6],
        [X, Y + 1e6],
      ];
      let total = 0;
      for (let e = 0; e < 4; e++) {
        const [[ax, ay], [bx, by]] = [corners[e], corners[(e + 1) % 4]];
        for (let k = 0; k < 1024; k++) {
          const p = forward.forward([
            ax + ((bx - ax) * k) / 1024,
            ay + ((by - ay) * k) / 1024,
          ]);
          const q = forward.forward([
            ax + ((bx - ax) * (k + 1)) / 1024,
            ay + ((by - ay) * (k + 1)) / 1024,
          ]);
          let dl = q[0] - p[0];
          dl -= 360 * Math.round(dl / 360);
          total += dl * DEG * (2 + Math.sin(p[1] * DEG) + Math.sin(q[1] * DEG));
        }
      }
      areas.push(Math.abs(total) / 2);
    }
  }
  const expected =
    areas.reduce((t, a, i) => t + a * temps[i], 0) /
    areas.reduce((t, a) => t + a);
  const mean = (
    await value(c, {
      kind: "box",
      west: -180,
      east: 180,
      south: -90,
      north: 90,
    })
  ).values[0];
  expect(Math.abs(mean - expected)).toBeLessThan(1e-4);
});

it("a rotated grid's published edges place a point", async () => {
  const s = await store();
  await put(s, "rlat", [2], ["rlat"], [0, 1], {
    standard_name: "grid_latitude",
    units: "degrees",
    bounds: "yb",
  });
  await put(s, "yb", [2, 2], ["rlat", "nv"], [-0.5, 0.5, 0.5, 1.5]);
  await put(s, "rlon", [3], ["rlon"], [0, 1, 2], {
    standard_name: "grid_longitude",
    units: "degrees",
    bounds: "xb",
  });
  await put(s, "xb", [3, 2], ["rlon", "nv"], [-0.5, 0.1, 0.1, 1.5, 1.5, 2.5]);
  await put(s, "pole", [], [], [], {
    grid_mapping_name: "rotated_latitude_longitude",
    grid_north_pole_latitude: 90,
    grid_north_pole_longitude: 180,
    north_pole_grid_longitude: 0,
  });
  await put(
    s,
    "v",
    [1, 2, 3],
    ["time", "rlat", "rlon"],
    [0, 100, 80, 0, 100, 80],
    {
      units: "K",
      grid_mapping: "pole",
    }
  );
  const out = await value(await context(s), {
    kind: "point",
    lat: 0,
    lon: 0.3,
  });
  expect(out.values[0]).toBe(100);
});

it("a projected grid's centres are made without its corners", async () => {
  const { projectedCoordinateArrays } =
    await import("@/lib/analysis/projectedGrid.ts");
  const n = 19;
  const axis = (dim: string) => ({
    dim,
    key: dim,
    length: n,
    metres: 1,
    values: async () => Array.from({ length: n }, (_, i) => 500000 + i * 1000),
  });
  const arrays = projectedCoordinateArrays(
    { x: axis("x"), y: axis("y") },
    "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs",
    "k"
  );
  const made: number[] = [];
  const F = Float64Array;
  globalThis.Float64Array = new Proxy(F, {
    construct(target, args, newTarget) {
      made.push(Number(args[0]));
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    await arrays.lat.readChunk([0, 0]);
    await arrays.lon.readChunk([0, 0]);
  } finally {
    globalThis.Float64Array = F;
  }
  // Centres only: nothing per corner (4 n²) and no edge lattice.
  expect(made.some((size) => size === 4 * n * n)).toBe(false);
  expect(made.some((size) => size === (n + 1) * (n + 1))).toBe(false);
  // The corners when asked for.
  const corners = await arrays.bounds.lat.readChunk([0, 0, 0]);
  expect(corners.data.length).toBe(4 * n * n);
});

it("a cold 1:10m atlas is asked about before it is parsed", async () => {
  const s = await store();
  await put(s, "lat", [2], ["lat"], [46, 47], { units: "degrees_north" });
  await put(s, "lon", [2], ["lon"], [2, 3], { units: "degrees_east" });
  await put(s, "v", [1, 2, 2], ["time", "lat", "lon"], [271, 271, 271, 271], {
    units: "K",
  });
  const c = await context(s);
  const q = {
    kind: "region-series",
    version: 1,
    variable: "v",
    fixed: {},
    time: { start: 0, stop: 1 },
    geometry: { kind: "country", id: "250", resolution: "10m" },
    source: { ref: "local", versionStatus: "best-effort" },
  };
  const cold = await planAnalysis(c, q as never, new ReadContext());
  expect(cold.estimate.needsConfirmation).toBe(true);
  expect(cold.estimate.notes.join(" ")).toMatch(/country boundaries/);
  const out = await cold.execute();
  expect(out.values[0]).toBe(271);
  // Prepared now: planned as any.
  const warm = await planAnalysis(c, q as never, new ReadContext());
  expect(warm.estimate.needsConfirmation).toBeFalsy();
});
