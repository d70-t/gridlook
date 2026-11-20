/**
 * A recorded figure page (PDF content operators, as the PDF export writes
 * them) as an SVG document: the same paths, text and images, so the PDF
 * and the SVG show the same figure. Only the operators the recorder emits
 * are read: q Q cm, m l c h re, f f* S, W n / W* n, w J j M d, rg RG, gs,
 * BT Tf Tr Tm Tj ET, Do, and /Pattern cs … scn. Text stays text (in
 * Helvetica), images become embedded PNG (`imageUrl` makes them).
 */
import type { TPdfImage, TPdfPage } from "./pdfWriter.ts";

type TMatrix = [number, number, number, number, number, number];
type TToken = number | string | { name: string } | { text: string } | TToken[];

const IDENTITY: TMatrix = [1, 0, 0, 1, 0, 0];

/** m1 then m2 (PDF order: a point is transformed by m1, then by m2). */
function concat(m1: TMatrix, m2: TMatrix): TMatrix {
  const [a, b, c, d, e, f] = m1;
  const [A, B, C, D, E, F] = m2;
  return [
    a * A + b * C,
    a * B + b * D,
    c * A + d * C,
    c * B + d * D,
    e * A + f * C + E,
    e * B + f * D + F,
  ];
}

function invert([a, b, c, d, e, f]: TMatrix): TMatrix {
  const det = a * d - b * c || 1;
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

const num = (v: number) => String(Math.round(v * 1000) / 1000);
const svgMatrix = (m: TMatrix) => `matrix(${m.map(num).join(" ")})`;
const escapeXml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Windows-1252 bytes 0x80–0x9F as characters (the rest is Latin-1).
const WIN_ANSI: Record<number, string> = {
  0x80: "€",
  0x82: "‚",
  0x83: "ƒ",
  0x84: "„",
  0x85: "…",
  0x86: "†",
  0x87: "‡",
  0x88: "ˆ",
  0x89: "‰",
  0x8a: "Š",
  0x8b: "‹",
  0x8c: "Œ",
  0x8e: "Ž",
  0x91: "‘",
  0x92: "’",
  0x93: "“",
  0x94: "”",
  0x95: "•",
  0x96: "–",
  0x97: "—",
  0x98: "˜",
  0x99: "™",
  0x9a: "š",
  0x9b: "›",
  0x9c: "œ",
  0x9e: "ž",
  0x9f: "Ÿ",
};

/** The content stream as numbers, names, strings, arrays and operators. */
// eslint-disable-next-line max-lines-per-function
export function tokenize(content: string): TToken[] {
  const out: TToken[] = [];
  const stack: TToken[][] = [out];
  let at = 0;
  const push = (token: TToken) => stack[stack.length - 1].push(token);
  while (at < content.length) {
    const ch = content[at];
    if (/\s/.test(ch)) {
      at++;
    } else if (ch === "[") {
      const list: TToken[] = [];
      push(list);
      stack.push(list);
      at++;
    } else if (ch === "]") {
      stack.pop();
      at++;
    } else if (ch === "/") {
      const match = /^\/[^\s/[\]()<>]*/.exec(content.slice(at))![0];
      push({ name: match.slice(1) });
      at += match.length;
    } else if (ch === "(") {
      let text = "";
      let depth = 1;
      at++;
      while (at < content.length && depth > 0) {
        const c = content[at];
        if (c === "\\") {
          const next = content[at + 1];
          const octal = /^[0-7]{1,3}/.exec(content.slice(at + 1));
          if (octal) {
            text += String.fromCharCode(parseInt(octal[0], 8));
            at += 1 + octal[0].length;
            continue;
          }
          text += { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[next] ?? next;
          at += 2;
          continue;
        }
        if (c === "(") {
          depth++;
        } else if (c === ")") {
          depth--;
          if (depth === 0) {
            at++;
            break;
          }
        }
        text += c;
        at++;
      }
      push({
        text: [...text].map((c) => WIN_ANSI[c.charCodeAt(0)] ?? c).join(""),
      });
    } else {
      const word = /^[^\s/[\]()<>]+/.exec(content.slice(at))![0];
      const value = Number(word);
      push(Number.isFinite(value) && /^[-+.\d]/.test(word) ? value : word);
      at += word.length;
    }
  }
  return out;
}

type TGraphics = {
  ctm: TMatrix;
  fill: string;
  stroke: string;
  fillAlpha: number;
  strokeAlpha: number;
  alpha: number;
  pattern?: number;
  width: number;
  cap: string;
  join: string;
  dash: number[];
  dashOffset: number;
  /** <g> elements opened (clips) in this state, closed by Q. */
  open: number;
};

const CAPS = ["butt", "round", "square"];
const JOINS = ["miter", "round", "bevel"];
const FONTS: Record<string, string> = {
  F1: "",
  F2: ' font-weight="bold"',
  F3: ' font-style="italic"',
  F4: ' font-weight="bold" font-style="italic"',
};

/**
 * The page as an SVG document, in points (the PDF's size); `imageUrl`
 * gives each image's data URL.
 */
// eslint-disable-next-line max-lines-per-function
export function pdfPageToSvg(
  page: TPdfPage,
  imageUrl: (image: TPdfImage) => string,
  title?: string
) {
  const defs: string[] = [];
  const body: string[] = [];
  const images = new Map<number, string>();
  const imageHref = (index: number) => {
    if (!images.has(index)) {
      images.set(index, imageUrl(page.images[index]));
    }
    return images.get(index)!;
  };
  let g: TGraphics = {
    ctm: IDENTITY,
    fill: "#000",
    stroke: "#000",
    fillAlpha: 1,
    strokeAlpha: 1,
    alpha: 1,
    width: 1,
    cap: "butt",
    join: "miter",
    dash: [],
    dashOffset: 0,
    open: 0,
  };
  const saved: TGraphics[] = [];
  let path = "";
  let clipId = 0;
  let patternId = 0;
  let text: { font: string; size: number; mode: number; tm: TMatrix } = {
    font: "F1",
    size: 12,
    mode: 0,
    tm: IDENTITY,
  };
  const operands: TToken[] = [];
  const nums = (count: number) =>
    operands.slice(-count).map((value) => Number(value));
  const rgb = () => {
    const [r, gg, b] = nums(3).map((v) => Math.round(v * 255));
    return `rgb(${r},${gg},${b})`;
  };
  const transformAttr = () =>
    g.ctm === IDENTITY ? "" : ` transform="${svgMatrix(g.ctm)}"`;
  const paintFill = (rule: string) => {
    let fill = g.fill;
    if (g.pattern !== undefined) {
      const pattern = page.patterns[g.pattern];
      const id = `p${patternId++}`;
      const m = concat(pattern.matrix as TMatrix, invert(g.ctm));
      defs.push(
        `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${pattern.width}" height="${pattern.height}" patternTransform="${svgMatrix(m)}"><image href="${imageHref(pattern.image)}" width="${pattern.width}" height="${pattern.height}" preserveAspectRatio="none"/></pattern>`
      );
      fill = `url(#${id})`;
    }
    const opacity =
      g.fillAlpha < 1 ? ` fill-opacity="${num(g.fillAlpha)}"` : "";
    body.push(
      `<path d="${path.trim()}" fill="${fill}"${opacity}${rule === "evenodd" ? ' fill-rule="evenodd"' : ""}${transformAttr()}/>`
    );
  };
  const paintStroke = () => {
    const opacity =
      g.strokeAlpha < 1 ? ` stroke-opacity="${num(g.strokeAlpha)}"` : "";
    const dash = g.dash.length
      ? ` stroke-dasharray="${g.dash.map(num).join(" ")}"${g.dashOffset ? ` stroke-dashoffset="${num(g.dashOffset)}"` : ""}`
      : "";
    body.push(
      `<path d="${path.trim()}" fill="none" stroke="${g.stroke}" stroke-width="${num(g.width)}" stroke-linecap="${g.cap}" stroke-linejoin="${g.join}"${opacity}${dash}${transformAttr()}/>`
    );
  };

  for (const token of tokenize(page.content)) {
    if (typeof token !== "string") {
      operands.push(token);
      continue;
    }
    switch (token) {
      case "q":
        saved.push(g);
        g = { ...g, open: 0 };
        break;
      case "Q":
        body.push("</g>".repeat(g.open));
        g = saved.pop() ?? g;
        break;
      case "cm":
        g = { ...g, ctm: concat(nums(6) as TMatrix, g.ctm) };
        break;
      case "m":
        path += `M${nums(2).map(num).join(" ")} `;
        break;
      case "l":
        path += `L${nums(2).map(num).join(" ")} `;
        break;
      case "c":
        path += `C${nums(6).map(num).join(" ")} `;
        break;
      case "h":
        path += "Z ";
        break;
      case "re": {
        const [x, y, w, h] = nums(4);
        path += `M${num(x)} ${num(y)} h${num(w)} v${num(h)} h${num(-w)} Z `;
        break;
      }
      case "f":
      case "f*":
        paintFill(token === "f*" ? "evenodd" : "nonzero");
        path = "";
        break;
      case "S":
        paintStroke();
        path = "";
        break;
      case "W":
      case "W*": {
        const id = `c${clipId++}`;
        defs.push(
          `<clipPath id="${id}"><path d="${path.trim()}"${token === "W*" ? ' clip-rule="evenodd"' : ""}${transformAttr()}/></clipPath>`
        );
        body.push(`<g clip-path="url(#${id})">`);
        g = { ...g, open: g.open + 1 };
        break;
      }
      case "n":
        path = "";
        break;
      case "w":
        g = { ...g, width: nums(1)[0] };
        break;
      case "J":
        g = { ...g, cap: CAPS[nums(1)[0]] ?? "butt" };
        break;
      case "j":
        g = { ...g, join: JOINS[nums(1)[0]] ?? "miter" };
        break;
      case "d": {
        const [list, offset] = operands.slice(-2);
        g = {
          ...g,
          dash: (list as number[]).map(Number),
          dashOffset: Number(offset),
        };
        break;
      }
      case "rg":
        g = { ...g, fill: rgb(), fillAlpha: g.alpha, pattern: undefined };
        break;
      case "RG":
        g = { ...g, stroke: rgb(), strokeAlpha: g.alpha };
        break;
      case "gs": {
        const name = (operands[operands.length - 1] as { name: string }).name;
        const alpha = page.alphas[Number(name.slice(1))] ?? 1;
        g = { ...g, alpha, fillAlpha: alpha, strokeAlpha: alpha };
        break;
      }
      case "scn":
      case "SCN": {
        const name = (operands[operands.length - 1] as { name: string }).name;
        if (token === "scn") {
          g = { ...g, pattern: Number(name.slice(1)), fillAlpha: g.alpha };
        }
        break;
      }
      case "Tf":
        text = {
          ...text,
          font: (operands[operands.length - 2] as { name: string }).name,
          size: nums(1)[0],
        };
        break;
      case "Tr":
        text = { ...text, mode: nums(1)[0] };
        break;
      case "Tm":
        text = { ...text, tm: nums(6) as TMatrix };
        break;
      case "Tj": {
        const value = (operands[operands.length - 1] as { text: string }).text;
        // Glyphs are drawn y-down in SVG, y-up in PDF text space.
        const m = concat([1, 0, 0, -1, 0, 0], concat(text.tm, g.ctm));
        const paint =
          text.mode === 1
            ? `fill="none" stroke="${g.stroke}" stroke-width="${num(g.width)}"`
            : `fill="${g.fill}"${g.fillAlpha < 1 ? ` fill-opacity="${num(g.fillAlpha)}"` : ""}`;
        body.push(
          `<text transform="${svgMatrix(m)}" font-family="Helvetica, Arial, sans-serif" font-size="${num(text.size)}"${FONTS[text.font] ?? ""} ${paint} xml:space="preserve">${escapeXml(value)}</text>`
        );
        break;
      }
      case "Do": {
        const name = (operands[operands.length - 1] as { name: string }).name;
        const index = Number(name.slice(2));
        // PDF images fill the unit square with their top row at y = 1.
        const m = concat([1, 0, 0, -1, 0, 1], g.ctm);
        body.push(
          `<image href="${imageHref(index)}" width="1" height="1" preserveAspectRatio="none"${page.images[index]?.pixelated ? ' style="image-rendering:pixelated" image-rendering="optimizeSpeed"' : ""} transform="${svgMatrix(m)}"${g.alpha < 1 ? ` opacity="${num(g.alpha)}"` : ""}/>`
        );
        break;
      }
      default:
        // BT, ET, cs, CS, M and anything else: no state the SVG needs.
        break;
    }
    operands.length = 0;
  }
  body.push("</g>".repeat(g.open));
  const w = num(page.width);
  const h = num(page.height);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}pt" height="${h}pt" viewBox="0 0 ${w} ${h}">`,
    ...(title ? [`<title>${escapeXml(title)}</title>`] : []),
    defs.length ? `<defs>${defs.join("")}</defs>` : "",
    // Page space has y up: the whole figure is flipped once.
    `<g transform="matrix(1 0 0 -1 0 ${h})">`,
    ...body,
    "</g>",
    "</svg>",
  ].join("\n");
}
