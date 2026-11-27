import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";

import { encodeQueriesForUrl } from "@/lib/analysis/analysisExport.ts";
import {
  cleanView,
  decodeSession,
  encodeSession,
  inflateWithin,
  MAX_SESSION_TEXT_BYTES,
  type TSessionPlot,
} from "@/lib/analysis/sessionLink.ts";
import { shapeDigest, shapeIdentity } from "@/lib/analysis/shapeImport.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  type TGeometry,
} from "@/lib/analysis/types.ts";

const box: TGeometry = {
  kind: "box",
  west: 0,
  east: 30,
  south: -20,
  north: 20,
};

function plot(
  kind: TSessionPlot["query"]["kind"],
  geometry: TGeometry,
  extra: Partial<TSessionPlot> = {}
): TSessionPlot {
  return {
    query: {
      version: ALGORITHM_VERSION,
      kind,
      variable: "tas",
      geometry,
      fixed: {},
    } as TSessionPlot["query"],
    ...extra,
  };
}

const shape: TGeometry = {
  kind: "shape",
  name: "Lake",
  digest: "abc",
  polygons: [
    [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  ],
};
// Its identity, as the importer makes it (a link's digest is set anew).
(shape as { digest: string }).digest = shapeDigest(
  (shape as { polygons: number[][][][] }).polygons
);

// eslint-disable-next-line max-lines-per-function
describe("session link", () => {
  it("round-trips plots, their view, place, screen and Compare", () => {
    const session = {
      plots: [
        plot(ANALYSIS_KINDS.REGION_SERIES, box, {
          view: { timeView: "running", timeWindow: 12, minimized: true },
          rect: { x: 10, y: 20, w: 400, h: 300 },
        }),
        plot(ANALYSIS_KINDS.POINT_SERIES, { kind: "point", lat: 1, lon: 2 }),
      ],
      screen: { w: 1600, h: 900 },
      compare: { ids: [0, 1], reference: 1 },
    };
    const value = encodeSession(session);
    expect(value.startsWith("2.")).toBe(true);
    expect(value).toMatch(/^2\.[A-Za-z0-9_-]+$/);
    expect(decodeSession(value)).toEqual(session);
  });

  it("v30: carries several countries as their codes, and refuses bad ones", () => {
    const several: TGeometry = {
      kind: "country",
      id: "250",
      resolution: "50m",
      ids: ["250", "276", "616"],
    };
    const session = {
      plots: [plot(ANALYSIS_KINDS.REGION_SERIES, several)],
    };
    const value = encodeSession(session);
    expect(value.length).toBeLessThan(200);
    expect(decodeSession(value)).toEqual(session);
    // An id that is not among the codes, or an unknown code: dropped.
    for (const ids of [["276", "616"], ["250", "nowhere"], ["250"]]) {
      const bad = encodeSession({
        plots: [
          plot(ANALYSIS_KINDS.REGION_SERIES, { ...several, ids } as TGeometry),
        ],
      });
      expect(decodeSession(bad).plots).toEqual([]);
    }
  });

  it("is far shorter than the version-1 encoding of the same plots", () => {
    const plots = Array.from({ length: 12 }, (_, at) =>
      plot(ANALYSIS_KINDS.REGION_SERIES, { ...box, west: at } as TGeometry)
    );
    const legacy = encodeQueriesForUrl(
      plots.map((p) => ({ ...p.query, source: { ref: "x" } }) as never)
    );
    expect(encodeSession({ plots }).length * 3).toBeLessThan(
      legacy?.length ?? Infinity
    );
  });

  it("still opens version-1 links", () => {
    const query = plot(ANALYSIS_KINDS.REGION_SERIES, box).query;
    const legacy = encodeQueriesForUrl([
      { ...query, source: { ref: "x" } } as never,
    ])!;
    expect(legacy.startsWith("1.")).toBe(true);
    expect(decodeSession(legacy).plots.map((p) => p.query.kind)).toEqual([
      ANALYSIS_KINDS.REGION_SERIES,
    ]);
  });

  it("carries an imported shape whole", () => {
    const value = encodeSession({
      plots: [plot(ANALYSIS_KINDS.REGION_SERIES, shape)],
    });
    expect(decodeSession(value).plots[0].query.geometry).toEqual(shape);
  });

  it("review of interim30: a version-1 link's shape takes its identity anew", () => {
    const stale = { ...shape, digest: "0000000000000000" } as TGeometry;
    const v1 = encodeQueriesForUrl([
      {
        ...plot(ANALYSIS_KINDS.REGION_SERIES, stale).query,
        source: { ref: "x", versionStatus: "session" },
      } as never,
    ])!;
    expect(v1.startsWith("1.")).toBe(true);
    expect(
      (decodeSession(v1).plots[0].query.geometry as { digest: string }).digest
    ).toBe((shape as { digest: string }).digest);
  });

  it("review #33: a restored shape's identity comes from its coordinates", () => {
    // Another outline's digest on these coordinates (an edited link).
    const stale = { ...shape, digest: "0000000000000000" } as TGeometry;
    const value = encodeSession({
      plots: [plot(ANALYSIS_KINDS.REGION_SERIES, stale)],
    });
    expect(
      (decodeSession(value).plots[0].query.geometry as { digest: string })
        .digest
    ).toBe((shape as { digest: string }).digest);
    // A drawn box's pole flags are part of it.
    const drawn = {
      ...shape,
      drawn: true,
      poles: { north: true, south: false },
      digest: "x",
    } as TGeometry;
    expect(
      (
        decodeSession(
          encodeSession({ plots: [plot(ANALYSIS_KINDS.REGION_SERIES, drawn)] })
        ).plots[0].query.geometry as { digest: string }
      ).digest
    ).toBe(`${(shape as { digest: string }).digest}.p10`);
  });

  it("drops a malformed plot, keeps the rest, and remaps Compare", () => {
    const broken = plot(ANALYSIS_KINDS.REGION_SERIES, {
      kind: "point",
      lat: 99,
      lon: 0,
    } as TGeometry);
    const value = encodeSession({
      plots: [
        broken,
        plot(ANALYSIS_KINDS.REGION_SERIES, box),
        plot(ANALYSIS_KINDS.REGION_SERIES, box),
      ],
      compare: { ids: [0, 1, 2], reference: 2 },
    });
    const session = decodeSession(value);
    expect(session.plots).toHaveLength(2);
    expect(session.compare).toEqual({ ids: [0, 1], reference: 1 });
  });

  it("drops Compare when its reference was dropped", () => {
    const broken = plot(ANALYSIS_KINDS.REGION_SERIES, {
      kind: "point",
      lat: 99,
      lon: 0,
    } as TGeometry);
    const session = decodeSession(
      encodeSession({
        plots: [broken, plot(ANALYSIS_KINDS.REGION_SERIES, box)],
        compare: { ids: [0, 1], reference: 0 },
      })
    );
    expect(session.compare).toBeUndefined();
  });

  it("returns nothing for garbage, unknown versions and bad shapes", () => {
    expect(decodeSession("2.!!!").plots).toEqual([]);
    expect(decodeSession("2.").plots).toEqual([]);
    expect(decodeSession("9.abc").plots).toEqual([]);
    const badShape = {
      ...shape,
      polygons: [
        [
          [
            [0, 0],
            [1, 95],
          ],
        ],
      ],
    } as TGeometry;
    expect(
      decodeSession(
        encodeSession({ plots: [plot(ANALYSIS_KINDS.REGION_SERIES, badShape)] })
      ).plots
    ).toEqual([]);
  });

  it("keeps only known, well-formed view settings", () => {
    expect(
      cleanView({
        timeView: "running",
        curve: "sideways",
        timeWindow: Number.NaN,
        centralRange: 90,
        minimized: "yes",
        windChoice: { u: "ua", v: "va" },
        result: { values: [1] },
        label: "P1",
      })
    ).toEqual({
      timeView: "running",
      centralRange: 90,
      windChoice: { u: "ua", v: "va" },
    });
    expect(cleanView({ label: "P1" })).toBeUndefined();
    expect(cleanView(null)).toBeUndefined();
  });

  it("review #38: Follow map level travels with the link, as Follow map time does", () => {
    const shared = {
      ...plot(ANALYSIS_KINDS.REGION_SERIES, box),
      view: { followMapLevel: true, followMapTime: false },
    };
    expect(
      decodeSession(encodeSession({ plots: [shared] })).plots[0].view
    ).toEqual({ followMapLevel: true, followMapTime: false });
  });
});

// eslint-disable-next-line max-lines-per-function
describe("v24 review: sessions round-trip as written", () => {
  it("33 plots reopen 33, with a Compare reference among the last", () => {
    const plots = Array.from({ length: 33 }, () =>
      plot(ANALYSIS_KINDS.REGION_SERIES, box)
    );
    const decoded = decodeSession(
      encodeSession({ plots, compare: { ids: [0, 32], reference: 32 } })
    );
    expect(decoded.plots).toHaveLength(33);
    expect(decoded.compare).toEqual({ ids: [0, 32], reference: 32 });
  });

  it("past the limit, the link holds the first plots and says it by its length", async () => {
    const { MAX_SESSION_PLOTS } = await import("@/lib/analysis/sessionLink.ts");
    const plots = Array.from({ length: MAX_SESSION_PLOTS + 6 }, () =>
      plot(ANALYSIS_KINDS.REGION_SERIES, box)
    );
    const kept = decodeSession(
      encodeSession({ plots, compare: { ids: [1, 2], reference: 1 } })
    );
    expect(kept.plots).toHaveLength(MAX_SESSION_PLOTS);
    expect(kept.compare).toEqual({ ids: [1, 2], reference: 1 });
    // A reference past the limit: Compare is not written half.
    const lost = decodeSession(
      encodeSession({
        plots,
        compare: {
          ids: [1, MAX_SESSION_PLOTS + 2],
          reference: MAX_SESSION_PLOTS + 2,
        },
      })
    );
    expect(lost.compare).toBeUndefined();
  });

  it("twelve plots of one 4,001-point outline carry it once", () => {
    const ring = Array.from({ length: 4001 }, (_, k) => {
      const a = (2 * Math.PI * k) / 4000;
      return [10 + 5 * Math.cos(a), 50 + 3 * Math.sin(a)];
    });
    const shape: TGeometry = {
      kind: "shape",
      name: "Lake",
      polygons: [[ring]],
      digest: shapeDigest([[ring]]),
    };
    const plots = Array.from({ length: 12 }, () =>
      plot(ANALYSIS_KINDS.REGION_SERIES, shape)
    );
    const shared = encodeSession({ plots });
    expect(shared.startsWith("3.")).toBe(true);
    const single = encodeSession({ plots: plots.slice(0, 1) });
    expect(single.startsWith("2.")).toBe(true);
    // About one outline, not twelve.
    expect(shared.length).toBeLessThan(single.length * 1.5);
    const decoded = decodeSession(shared);
    expect(decoded.plots).toHaveLength(12);
    expect(decoded.plots[11].query.geometry).toEqual(shape);
    const renamed = encodeSession({
      plots: [
        plots[0],
        plot(ANALYSIS_KINDS.REGION_SERIES, { ...shape, name: "Survey B" }),
      ],
    });
    expect(renamed.startsWith("3.")).toBe(true);
    expect(
      decodeSession(renamed).plots.map(
        (p) => (p.query.geometry as { name: string }).name
      )
    ).toEqual(["Lake", "Survey B"]);
    // The same coordinates imported and drawn as a box: each keeps which.
    const both = decodeSession(
      encodeSession({
        plots: [
          plots[0],
          plot(ANALYSIS_KINDS.REGION_SERIES, { ...shape, drawn: true }),
          plots[0],
        ],
      })
    ).plots.map((p) => (p.query.geometry as { drawn?: boolean }).drawn);
    expect(both).toEqual([undefined, true, undefined]);
  });
  it("keeps a drawn outline drawn in links of interim4/5", () => {
    // The flag on the shared outline only, the references without it: both
    // plots stay drawn.
    const shape: TGeometry = {
      kind: "shape",
      name: "Box",
      polygons: [
        [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 0],
          ],
        ],
      ],
      digest: "d",
      drawn: true,
    };
    const older = {
      ...JSON.parse(
        strFromU8(
          inflateSync(
            Buffer.from(
              encodeSession({
                plots: [
                  plot(ANALYSIS_KINDS.REGION_SERIES, shape),
                  plot(ANALYSIS_KINDS.REGION_SERIES, shape),
                ],
              }).slice(2),
              "base64url"
            )
          )
        )
      ),
    };
    for (const p of older.plots) {
      delete p.query.geometry.drawn;
    }
    const reopened = decodeSession(
      `3.${Buffer.from(deflateSync(strToU8(JSON.stringify(older)))).toString("base64url")}`
    ).plots.map((p) => (p.query.geometry as { drawn?: boolean }).drawn);
    expect(reopened).toEqual([true, true]);
  });
  it("reads links of interim7: a plot without the flag was imported", () => {
    const shape: TGeometry = {
      kind: "shape",
      name: "Box",
      polygons: [
        [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 0],
          ],
        ],
      ],
      digest: "d",
    };
    for (const order of [
      [true, false],
      [false, true],
    ]) {
      const link = JSON.parse(
        strFromU8(
          inflateSync(
            Buffer.from(
              encodeSession({
                plots: order.map((drawn) =>
                  plot(ANALYSIS_KINDS.REGION_SERIES, {
                    ...shape,
                    ...(drawn ? { drawn: true as const } : {}),
                  })
                ),
              }).slice(2),
              "base64url"
            )
          )
        )
      );
      // As older links write it: the flag only where it is true.
      for (const p of link.plots) {
        if (p.query.geometry.drawn === false) {
          delete p.query.geometry.drawn;
        }
      }
      const reopened = decodeSession(
        `3.${Buffer.from(deflateSync(strToU8(JSON.stringify(link)))).toString("base64url")}`
      ).plots.map((p) => (p.query.geometry as { drawn?: boolean }).drawn);
      expect(reopened).toEqual(
        order.map((drawn) => (drawn ? true : undefined))
      );
    }
  });
});

describe("review #16: a link cannot inflate without bound", () => {
  it("stops past the budget, before holding it all; normal text is unchanged", () => {
    const text = strToU8(JSON.stringify({ plots: [], note: "x".repeat(5000) }));
    expect(strFromU8(inflateWithin(deflateSync(text), 1e6))).toBe(
      strFromU8(text)
    );
    // 200 MiB of zeros packs into a few hundred kilobytes.
    const bomb = deflateSync(new Uint8Array(200 * 2 ** 20), { level: 9 });
    expect(bomb.length).toBeLessThan(2 ** 20);
    expect(() => inflateWithin(bomb, MAX_SESSION_TEXT_BYTES)).toThrow(
      /larger than 64 MiB/
    );
    // As a link: no plots, no exhausted tab.
    let base64 = "";
    for (let at = 0; at < bomb.length; at += 0x8000) {
      base64 += String.fromCharCode(...bomb.subarray(at, at + 0x8000));
    }
    const payload = btoa(base64)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodeSession(`2.${payload}`).plots).toEqual([]);
  });
});

describe("review of interim30 N10: what is written can be read", () => {
  it("keeps the first plots that fit the reader's budget, and says how many", async () => {
    const { encodedSession } = await import("@/lib/analysis/sessionLink.ts");
    const outline = (k: number): TGeometry => {
      const ring = Array.from({ length: 2001 }, (_, i) => {
        const a = (2 * Math.PI * i) / 2000;
        return [10 * k + Math.cos(a), 50 + Math.sin(a)];
      });
      return {
        kind: "shape",
        name: `S${k}`,
        polygons: [[ring]],
        digest: shapeDigest([[ring]]),
      };
    };
    const plots = [0, 1, 2, 3].map((k) =>
      plot(ANALYSIS_KINDS.REGION_SERIES, outline(k))
    );
    const one = JSON.stringify(plots[0]).length;
    const { value, kept } = encodedSession({ plots }, Math.floor(2.5 * one));
    expect(kept).toBe(2);
    expect(decodeSession(value).plots).toHaveLength(2);
  });
});

it("budgets a shared session using the UTF-8 bytes read by the recipient", async () => {
  const { encodedSession } = await import("@/lib/analysis/sessionLink.ts");
  const geometry = { ...shape, name: "流域温度観測地点" };
  const session = { plots: [plot(ANALYSIS_KINDS.REGION_SERIES, geometry)] };
  const json = JSON.stringify(session);
  // Small test seam for the same byte limit used by the session reader.
  const budget = json.length + 1;
  expect(strToU8(json).length).toBeGreaterThan(budget);
  const written = encodedSession(session, budget);
  expect(written.kept).toBe(0);
});

it("interim48: a framed Box and an unframed outline of its rings stay two shapes when reopened", () => {
  const ring = [
    [0, 89],
    [10, 89],
    [10, 89.5],
    [0, 89],
  ];
  const frame = {
    projection: { type: "globe", center: { lat: 90, lon: 0 } },
    view: Array.from({ length: 16 }, (_, k) => (k % 5 ? 0 : 1)),
    lens: Array.from({ length: 16 }, (_, k) => (k % 5 ? 0 : 1)),
    eye: [0, 0, 4],
    viewport: { left: 0, top: 0, width: 100, height: 100 },
    rect: { x0: 1, y0: 1, x1: 2, y1: 2 },
    band: 1e-6,
  };
  const shape = (framed: boolean) =>
    ({
      kind: "shape",
      name: "Box",
      drawn: true,
      polygons: [[ring]],
      poles: { north: false, south: false },
      digest: shapeIdentity(
        [[ring]],
        { north: false, south: false },
        framed ? frame : undefined
      ),
      ...(framed ? { frame } : {}),
    }) as unknown as TGeometry;
  const session = {
    plots: [
      plot(ANALYSIS_KINDS.REGION_SERIES, shape(true)),
      plot(ANALYSIS_KINDS.REGION_SERIES, shape(false)),
    ],
  };
  // Saved and reopened twice: each keeps its own rule and identity.
  const twice = decodeSession(
    encodeSession(decodeSession(encodeSession(session)))
  );
  const [a, b] = twice.plots.map(
    (p) => p.query.geometry as { digest: string; frame?: object }
  );
  expect(a.digest).not.toBe(b.digest);
  expect([Boolean(a.frame), Boolean(b.frame)]).toEqual([true, false]);
});

it("interim50: a link keeps the dates a preview showed, well formed only", async () => {
  const { cleanView } = await import("@/lib/analysis/sessionLink.ts");
  expect(cleanView({ shownRange: { start: 10, stop: 74 } })).toEqual({
    shownRange: { start: 10, stop: 74 },
  });
  expect(cleanView({ shownRange: { start: 10, stop: 10 } })).toBeUndefined();
  expect(cleanView({ shownRange: { start: -1, stop: 4 } })).toBeUndefined();
  expect(cleanView({ shownRange: "0-4" })).toBeUndefined();
});
