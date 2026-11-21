import { describe, expect, it } from "vitest";

import { pdfPageToSvg, tokenize } from "@/lib/analysis/svgWriter.ts";

const page = (
  content: string,
  extra: Partial<Parameters<typeof pdfPageToSvg>[0]> = {}
) => ({
  width: 100,
  height: 50,
  content,
  images: [{ width: 1, height: 1, rgb: new Uint8Array([0, 0, 0]) }],
  patterns: [],
  alphas: [0.5],
  ...extra,
});

// eslint-disable-next-line max-lines-per-function
describe("SVG from the recorded figure", () => {
  it("reads names, numbers, arrays and escaped strings", () => {
    expect(tokenize("/G0 gs [1.5 2] 0 d (a\\(b\\)\\226) Tj")).toEqual([
      { name: "G0" },
      "gs",
      [1.5, 2],
      0,
      "d",
      { text: "a(b)–" },
      "Tj",
    ]);
  });

  it("draws strokes, fills, text and images, flipped once to page space", () => {
    const svg = pdfPageToSvg(
      page(
        [
          "q 1 0 0 1 10 20 cm 2 w 1 J [3 1] 0 d 0 0 1 RG 0 0 m 10 0 l S Q",
          "/G0 gs 1 0 0 rg 0 0 5 5 re f",
          "BT /F2 12 Tf 0 Tr 1 0 0 1 3 4 Tm (A&B) Tj ET",
          "q 2 0 0 3 5 6 cm /Im0 Do Q",
        ].join("\n")
      ),
      () => "data:image/png;base64,AAA",
      "Figure <1>"
    );
    expect(svg).toMatch(
      /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="100pt" height="50pt" viewBox="0 0 100 50">/
    );
    expect(svg).toContain("<title>Figure &lt;1&gt;</title>");
    expect(svg).toContain('<g transform="matrix(1 0 0 -1 0 50)">');
    expect(svg).toContain(
      '<path d="M0 0 L10 0" fill="none" stroke="rgb(0,0,255)" stroke-width="2" stroke-linecap="round" stroke-linejoin="miter" stroke-dasharray="3 1" transform="matrix(1 0 0 1 10 20)"/>'
    );
    expect(svg).toContain(
      '<path d="M0 0 h5 v5 h-5 Z" fill="rgb(255,0,0)" fill-opacity="0.5"/>'
    );
    // Text upright (y flipped back), bold, escaped.
    expect(svg).toContain(
      '<text transform="matrix(1 0 0 -1 3 4)" font-family="Helvetica, Arial, sans-serif" font-size="12" font-weight="bold" fill="rgb(255,0,0)" fill-opacity="0.5" xml:space="preserve">A&amp;B</text>'
    );
    expect(svg).toContain(
      '<image href="data:image/png;base64,AAA" width="1" height="1" preserveAspectRatio="none" transform="matrix(2 0 0 -3 5 9)" opacity="0.5"/>'
    );
  });

  it("clips until the state is restored, and fills with a pattern", () => {
    const svg = pdfPageToSvg(
      page(
        "q 0 0 10 10 re W n /Pattern cs /P0 scn 0 0 4 4 re f Q 0 0 1 1 re f",
        {
          patterns: [
            { image: 0, width: 4, height: 4, matrix: [1, 0, 0, 1, 0, 0] },
          ],
        }
      ),
      () => "data:x"
    );
    expect(svg).toContain(
      '<clipPath id="c0"><path d="M0 0 h10 v10 h-10 Z"/></clipPath>'
    );
    expect(svg).toMatch(
      /<g clip-path="url\(#c0\)">\n<path d="M0 0 h4 v4 h-4 Z" fill="url\(#p0\)"\/>\n<\/g>\n<path d="M0 0 h1/
    );
    expect(svg).toContain(
      '<pattern id="p0" patternUnits="userSpaceOnUse" width="4" height="4"'
    );
  });
});
