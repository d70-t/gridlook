import { strFromU8, unzlibSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  helveticaWidth,
  pdfLiteral,
  toWinAnsi,
  writePdf,
} from "@/lib/analysis/pdfWriter.ts";

const latin1 = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => String.fromCharCode(b)).join("");

/** The bytes of each object's stream, by object number. */
function streams(file: string, bytes: Uint8Array) {
  const found = new Map<number, Uint8Array>();
  const pattern = /(\d+) 0 obj\n<<[^\n]*?\/Length (\d+) >>\nstream\n/g;
  for (let match = pattern.exec(file); match; match = pattern.exec(file)) {
    const start = match.index + match[0].length;
    found.set(Number(match[1]), bytes.slice(start, start + Number(match[2])));
  }
  return found;
}

// eslint-disable-next-line max-lines-per-function
describe("PDF writer", () => {
  const page = {
    width: 100,
    height: 50,
    content: "1 0 0 rg 0 0 10 10 re f",
    images: [
      {
        width: 1,
        height: 1,
        rgb: new Uint8Array([1, 2, 3]),
        alpha: new Uint8Array([128]),
      },
    ],
    patterns: [{ image: 0, width: 1, height: 1, matrix: [1, 0, 0, 1, 0, 0] }],
    alphas: [0.5],
  };
  const bytes = writePdf(page, {
    title: "Hovmöller | sfcWind",
    subject: "box 0° to 10° E",
    date: new Date(Date.UTC(2026, 10, 20, 21, 5, 9)),
    attachments: [
      {
        name: "plot.json",
        mime: "application/json",
        description: "Query and provenance",
        bytes: new TextEncoder().encode('{"a":1}'),
      },
    ],
  });
  const file = latin1(bytes);

  it("writes a cross-reference table that points at every object", () => {
    expect(file.startsWith("%PDF-1.7\n")).toBe(true);
    const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(file)![1]);
    expect(file.slice(xref, xref + 4)).toBe("xref");
    const table =
      /xref\n0 (\d+)\n0000000000 65535 f \n((?:\d{10} 00000 n \n)+)/.exec(
        file.slice(xref)
      )!;
    const offsets = table[2]
      .trim()
      .split("\n")
      .map((row) => Number(row.slice(0, 10)));
    expect(offsets).toHaveLength(Number(table[1]) - 1);
    offsets.forEach((offset, at) =>
      expect(file.slice(offset).startsWith(`${at + 1} 0 obj`)).toBe(true)
    );
    expect(file).toMatch(
      /trailer\n<< \/Size \d+ \/Root 1 0 R \/Info \d+ 0 R >>/
    );
  });

  it("compresses the content, keeps image alpha as a soft mask", () => {
    const found = streams(file, bytes);
    const content = found.get(4)!;
    expect(strFromU8(unzlibSync(content))).toBe(page.content);
    expect(file).toMatch(/\/Subtype \/Image .*\/SMask \d+ 0 R/);
    expect(file).toMatch(/\/G0 << \/Type \/ExtGState \/ca 0.5 \/CA 0.5 >>/);
    expect(file).toMatch(/\/Pattern << \/P0 \d+ 0 R >>/);
    expect(file).toMatch(
      /\/BaseFont \/Helvetica-Bold \/Encoding \/WinAnsiEncoding/
    );
  });

  it("titles the document in UTF-16 and attaches the provenance", () => {
    // "Hovmöller" is not ASCII: a UTF-16BE string with a byte order mark.
    expect(file).toMatch(/\/Title <FEFF0048006F0076006D00F6/);
    expect(file).toContain("/CreationDate (D:20261120210509Z)");
    expect(file).toMatch(
      /\/EmbeddedFiles << \/Names \[\(plot\.json\) \d+ 0 R\] >>/
    );
    expect(file).toContain("/Subtype /application#2Fjson");
    expect(file).toContain("/AFRelationship /Supplement");
  });
});

describe("PDF text", () => {
  it("encodes WinAnsi, substituting what it can and refusing the rest", () => {
    expect(toWinAnsi("10 °C – 5 × ö")).toBe("10 \xb0C \x96 5 \xd7 \xf6");
    expect(toWinAnsi("−5")).toBe("-5");
    expect(toWinAnsi("σ")).toBeUndefined();
    expect(pdfLiteral("a(b)\\c")).toBe("(a\\(b\\)\\\\c)");
  });

  it("measures Helvetica, accented letters as their base", () => {
    const width = (text: string, bold = false) =>
      [...text].reduce((sum, c) => sum + helveticaWidth(c, bold)!, 0);
    expect(width("Hello")).toBe(722 + 556 + 222 + 222 + 556);
    expect(width("Ab", true)).toBe(722 + 611);
    expect(helveticaWidth("ä", false)).toBe(helveticaWidth("a", false));
    expect(helveticaWidth("í", false)).toBe(278);
    expect(helveticaWidth("σ", false)).toBeUndefined();
  });
});
