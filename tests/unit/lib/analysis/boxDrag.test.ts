import { describe, expect, it } from "vitest";

import {
  dragBox,
  dragStartLon,
  editHandles,
  followLon,
  followPointer,
} from "@/lib/analysis/shapeEdit.ts";
import { GEOMETRY_KINDS } from "@/lib/analysis/types.ts";

const box = (west: number, east: number, south: number, north: number) => ({
  kind: GEOMETRY_KINDS.BOX,
  west,
  east,
  south,
  north,
});

/** The box after dragging `side`'s handle along `path` (pointer samples). */
function drag(
  start: ReturnType<typeof box>,
  side: "north" | "south" | "east" | "west",
  path: { lat: number; lon: number }[]
) {
  const handle = editHandles(start as never).find(
    (h) => h.sides?.length === 1 && h.sides[0] === side
  )!;
  let lon = dragStartLon(start as never, handle);
  let shown = start as never;
  for (const at of path) {
    lon = followLon(lon, at.lon);
    shown = dragBox(start as never, handle.sides!, at.lat, lon) as never;
  }
  return shown;
}

const steps = (
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  n: number
) =>
  Array.from({ length: n }, (_, k) => ({
    lat: from.lat + ((to.lat - from.lat) * (k + 1)) / n,
    lon: from.lon + ((to.lon - from.lon) * (k + 1)) / n,
  }));

describe("box sides dragged past the fixed side (review of interim37)", () => {
  const start = box(-20, 20, -10, 10);

  it("gives the same box for one pointer move or many", () => {
    for (const n of [1, 10, 100]) {
      expect(
        drag(
          start,
          "north",
          steps({ lat: 10, lon: 0 }, { lat: -30, lon: 0 }, n)
        )
      ).toMatchObject({ south: -30, north: -10, west: -20, east: 20 });
      expect(
        drag(start, "east", steps({ lat: 0, lon: 20 }, { lat: 0, lon: -30 }, n))
      ).toMatchObject({ west: -30, east: -20 });
    }
  });

  it("keeps a box across the date line and grows it eastward", () => {
    const across = box(170, -170, 0, 10);
    expect(
      drag(
        across,
        "east",
        steps({ lat: 5, lon: -170 }, { lat: 5, lon: -160 }, 5)
      )
    ).toMatchObject({ west: 170, east: -160 });
  });

  it("stops at a whole turn", () => {
    expect(
      drag(start, "east", steps({ lat: 0, lon: 20 }, { lat: 0, lon: 380 }, 36))
    ).toMatchObject({ west: -180, east: 180 });
  });
});

describe("review of interim43: a wide drag between two pointer events", () => {
  // An equirectangular map at 0°, 0°: 1536 px for 360°, centred at 768.
  const pick = (x: number) => ({ lat: 0, lon: ((x - 768) * 360) / 1536 });
  /** The east side dragged from x0 to x1 in `events` pointer moves. */
  const dragged = (x0: number, x1: number, events: number) => {
    const start = box(-130, -100, -10, 10);
    const handle = editHandles(start as never).find(
      (h) => h.sides?.length === 1 && h.sides[0] === "east"
    )!;
    let lon = dragStartLon(start as never, handle);
    let from = { x: x0, y: 425 };
    for (let k = 1; k <= events; k++) {
      const to = { x: x0 + ((x1 - x0) * k) / events, y: 425 };
      lon = followPointer(lon, from, to, (x) => pick(x));
      from = to;
    }
    return dragBox(start as never, ["east"], 0, lon);
  };

  it("gives the same box for one pointer event or ten", () => {
    // From 100°W to about 120°E, straight right: eastward, 220°.
    const once = dragged(341.33, 1280, 1);
    const ten = dragged(341.33, 1280, 10);
    expect(once).toEqual(ten);
    expect(once).toMatchObject({ west: -130 });
    expect(once.east).toBeCloseTo(120, 6);
  });

  it("follows a leftward drag the same way", () => {
    expect(dragged(1280, 341.33, 1)).toEqual(dragged(1280, 341.33, 10));
  });
});
