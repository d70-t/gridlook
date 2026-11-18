import { describe, expect, it } from "vitest";

import {
  editable,
  editableForm,
  editHandles,
  moveHandle,
  removeVertex,
} from "@/lib/analysis/shapeEdit.ts";
import { GEOMETRY_KINDS, type TGeometry } from "@/lib/analysis/types.ts";

const box: TGeometry = {
  kind: GEOMETRY_KINDS.BOX,
  west: 0,
  east: 10,
  south: 40,
  north: 50,
};
const area: TGeometry = {
  kind: GEOMETRY_KINDS.POLYGON,
  vertices: [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 10 },
    { lat: 10, lon: 10 },
  ],
};
const handle = (g: TGeometry, key: string) =>
  editHandles(g).find((h) => h.key === key)!;

describe("editing a shape on the map", () => {
  it("gives a box four corners and four edges", () => {
    const keys = editHandles(box).map((h) => h.key);
    expect(keys).toEqual(["nw", "ne", "se", "sw", "n", "e", "s", "w"]);
    expect(handle(box, "n")).toMatchObject({ lat: 50, lon: 5 });
  });

  it("moves a corner's two sides and an edge's one", () => {
    expect(moveHandle(box, handle(box, "ne"), { lat: 55, lon: 20 })).toEqual({
      ...box,
      north: 55,
      east: 20,
    });
    expect(moveHandle(box, handle(box, "w"), { lat: 0, lon: -5 })).toEqual({
      ...box,
      west: -5,
    });
  });

  it("keeps a box when an edge is dragged past the opposite one", () => {
    const moved = moveHandle(box, handle(box, "n"), { lat: 30, lon: 5 });
    expect(moved).toMatchObject({ south: 30, north: 40 });
  });
});

describe("editing and naming, continued", () => {
  it("moves a point, adds one between two, removes one down to three", () => {
    const moved = moveHandle(area, handle(area, "v2"), { lat: 12, lon: 8 });
    expect((moved as { vertices: unknown[] }).vertices[2]).toEqual({
      lat: 12,
      lon: 8,
    });
    const added = moveHandle(area, handle(area, "i0"), { lat: -2, lon: 5 });
    expect((added as { vertices: unknown[] }).vertices).toHaveLength(4);
    expect((added as { vertices: unknown[] }).vertices[1]).toEqual({
      lat: -2,
      lon: 5,
    });
    expect(removeVertex(added, 1)).toEqual(area);
    expect(removeVertex(area, 0)).toBeUndefined();
  });

  it("puts an add handle between every two points (a path's ends not joined)", () => {
    const path: TGeometry = {
      kind: GEOMETRY_KINDS.POLYLINE,
      vertices: area.vertices,
    };
    expect(editHandles(area).filter((h) => h.role === "insert")).toHaveLength(
      3
    );
    expect(editHandles(path).filter((h) => h.role === "insert")).toHaveLength(
      2
    );
  });

  it("does not edit a band or a whole-globe box by handles", () => {
    expect(editable(box)).toBe(true);
    expect(editable({ ...box, west: -180, east: 180 })).toBe(false);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("a drawn box is edited by its corners", () => {
  // eslint-disable-next-line max-lines-per-function
  it("reduces the traced rectangle to its four corners", () => {
    const edge = (a: number[], b: number[]) =>
      Array.from({ length: 5 }, (_, k) => [
        a[0] + ((b[0] - a[0]) * k) / 5,
        a[1] + ((b[1] - a[1]) * k) / 5,
      ]);
    const ring = [
      ...edge([-30, 23], [-11, 23]),
      ...edge([-11, 23], [-11, 13]),
      ...edge([-11, 13], [-30, 13]),
      ...edge([-30, 13], [-30, 23]),
      [-30, 23],
    ];
    const drawn: TGeometry = {
      kind: GEOMETRY_KINDS.SHAPE,
      name: "as drawn",
      polygons: [[ring]],
      digest: "x",
      drawn: true,
      poles: { north: false, south: false },
    };
    expect(editableForm(drawn)).toBe(drawn);
    const handles = editHandles(drawn);
    expect(handles.map((h) => [h.role, h.lat, h.lon])).toEqual([
      ["corner", 23, -30],
      ["corner", 23, -11],
      ["corner", 13, -11],
      ["corner", 13, -30],
    ]);
    // One corner moves: its two sides follow, the other two stay as traced.
    const moved = moveHandle(drawn, handles[0], { lat: 24, lon: -31 }) as {
      kind: string;
      polygons: number[][][][];
      digest: string;
    };
    expect(moved.kind).toBe(GEOMETRY_KINDS.SHAPE);
    const after = moved.polygons[0][0];
    // East side (ring 5..10) and south side (10..15) unchanged, exactly.
    expect(after.slice(5, 16)).toEqual(ring.slice(5, 16));
    expect(after[0]).toEqual([-31, 24]);
    expect(after[after.length - 1]).toEqual([-31, 24]);
    // Two fifths along the north side from the moved corner: three fifths
    // of its move.
    expect(after[2][0]).toBeCloseTo(-30 + (19 * 2) / 5 - 0.6, 9);
    expect(after[2][1]).toBeCloseTo(23 + 0.6, 9);
    expect(moved.digest).not.toBe("x");
    const framed = { ...drawn, frame: { band: 1e-6 } } as TGeometry;
    const edited = moveHandle(framed, editHandles(framed)[0], {
      lat: 24,
      lon: -31,
    }) as { frame?: object };
    expect(edited.frame).toBeUndefined();
    // A drawn box keeps its corners: none can be deleted.
    expect(removeVertex(drawn, 0)).toBeUndefined();
    expect(editableForm({ ...drawn, drawn: undefined })).toBeUndefined();
    expect(editableForm(box)).toBe(box);
  });
});

it("independent review of interim41: arrow keys move a box side across the other as a pointer does", async () => {
  const { editHandles, keyedBox } = await import("@/lib/analysis/shapeEdit.ts");
  const box = {
    kind: "box" as const,
    west: 2.3,
    east: 2.7,
    south: -10,
    north: 10,
  };
  const east = editHandles(box).find(
    (h) => h.sides?.length === 1 && h.sides[0] === "east"
  )!;
  // Left once: 2.2° E beside 2.3° E, a 0.1° strip, not 359.9°.
  let step = keyedBox(undefined, box, east, 0, -0.5);
  expect(step.box.west).toBeCloseTo(2.2, 9);
  expect(step.box.east).toBeCloseTo(2.3, 9);
  // Left again: the moving side goes on west, the box widens.
  step = keyedBox(step.drag, step.box, east, 0, -0.5);
  expect(step.box.west).toBeCloseTo(1.7, 9);
  expect(step.box.east).toBeCloseTo(2.3, 9);
  // And back right: the strip, then the original box.
  step = keyedBox(step.drag, step.box, east, 0, 1);
  expect(step.box.west).toBeCloseTo(2.3, 9);
  expect(step.box.east).toBeCloseTo(2.7, 9);
});
