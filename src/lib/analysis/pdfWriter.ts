/**
 * A small PDF writer for exported figures: one page of vector drawing
 * (paths and text in the standard Helvetica faces, WinAnsi-encoded, so no
 * font is embedded), images, image-tiled patterns, document information and
 * attached files (the plot's query and provenance travel inside the PDF).
 */
import { zlibSync } from "fflate";

export type TPdfImage = {
  width: number;
  height: number;
  /** Row-major RGB, top row first. */
  rgb: Uint8Array;
  /** Coverage per pixel; left out when the image is opaque. */
  alpha?: Uint8Array;
  /**
   * Drawn without smoothing (a heatmap's cells): each pixel its own colour at
   * any scale.
   */
  pixelated?: boolean;
};

/** An image tiled from the origin of `matrix` (pattern space to page). */
export type TPdfPattern = {
  image: number;
  width: number;
  height: number;
  matrix: number[];
};

export type TPdfPage = {
  /** Page size in points. */
  width: number;
  height: number;
  /** Content stream operators, one character per byte (Latin-1). */
  content: string;
  images: TPdfImage[];
  patterns: TPdfPattern[];
  /** Opacity of graphics state `/G{i}`. */
  alphas: number[];
};

export type TPdfAttachment = {
  name: string;
  mime: string;
  description: string;
  bytes: Uint8Array;
};

export type TPdfInfo = {
  title: string;
  subject?: string;
  date: Date;
  attachments?: TPdfAttachment[];
};

/** `/F1`…`/F4`: regular, bold, oblique, bold oblique. */
const PDF_FONTS = [
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-Oblique",
  "Helvetica-BoldOblique",
];

export function pdfFontName(bold: boolean, italic: boolean) {
  return `/F${1 + (bold ? 1 : 0) + (italic ? 2 : 0)}`;
}

// Helvetica advance widths (Adobe AFM, 1/1000 em) for ASCII 32–126.
const ASCII_WIDTHS = {
  regular: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
    278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
    584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
    833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
    278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
    500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
    500, 334, 260, 334, 584,
  ],
  bold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
    278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
    584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
    833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
    278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
    556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
    500, 389, 280, 389, 584,
  ],
};

// Common symbols beyond ASCII: [regular, bold].
const SYMBOL_WIDTHS: Record<string, [number, number]> = {
  " ": [278, 278],
  "°": [400, 400],
  "|": [278, 278],
  "×": [584, 584],
  "±": [584, 584],
  µ: [556, 611],
  "²": [333, 333],
  "³": [333, 333],
  "¹": [333, 333],
  ß: [611, 611],
  "–": [556, 556],
  "—": [1000, 1000],
  "‘": [222, 278],
  "’": [222, 278],
  "“": [333, 500],
  "”": [333, 500],
  "•": [350, 350],
  "…": [1000, 1000],
  "‰": [1000, 1000],
  "€": [556, 556],
};

/**
 * Width of one character in Helvetica, 1/1000 em, or undefined where the
 * table does not know it. Accented letters take their base letter's width
 * (the dotless i of ì í î ï is wider than i).
 */
export function helveticaWidth(
  char: string,
  bold: boolean
): number | undefined {
  const code = char.charCodeAt(0);
  if (code >= 32 && code <= 126) {
    return ASCII_WIDTHS[bold ? "bold" : "regular"][code - 32];
  }
  const symbol = SYMBOL_WIDTHS[char];
  if (symbol) {
    return symbol[bold ? 1 : 0];
  }
  const base = char.normalize("NFD")[0];
  if (base !== char && base.charCodeAt(0) < 127) {
    return base === "i" ? 278 : helveticaWidth(base, bold);
  }
  return undefined;
}

// Windows-1252 bytes 0x80–0x9F, by code point.
const WIN_ANSI_HIGH: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

// Characters drawn as a near equivalent the encoding has.
const WIN_ANSI_SUBSTITUTES: Record<string, string> = {
  "−": "-", // minus sign
  " ": " ", // thin space
  " ": " ", // narrow no-break space
  " ": " ", // figure space
};

/**
 * Text as WinAnsi bytes (one character per byte), or undefined when a
 * character has no byte: the caller then draws that text as an image.
 */
export function toWinAnsi(text: string) {
  let out = "";
  for (const raw of text) {
    const char = WIN_ANSI_SUBSTITUTES[raw] ?? raw;
    const code = char.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += String.fromCharCode(code);
    } else if (WIN_ANSI_HIGH[code] !== undefined) {
      out += String.fromCharCode(WIN_ANSI_HIGH[code]);
    } else {
      return undefined;
    }
  }
  return out;
}

/** A PDF literal string of bytes: parentheses and backslashes escaped. */
export function pdfLiteral(bytes: string) {
  return `(${bytes
    .replace(/[\\()]/g, (c) => `\\${c}`)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")})`;
}

/** A text string for document metadata: literal if ASCII, else UTF-16BE. */
function pdfText(text: string) {
  if (/^[\x20-\x7e]*$/.test(text)) {
    return pdfLiteral(text);
  }
  let hex = "FEFF";
  for (let at = 0; at < text.length; at++) {
    hex += text.charCodeAt(at).toString(16).padStart(4, "0").toUpperCase();
  }
  return `<${hex}>`;
}

function pdfDate(date: Date) {
  const two = (n: number) => String(n).padStart(2, "0");
  return `(D:${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z)`;
}

const latin1 = (text: string) => {
  const bytes = new Uint8Array(text.length);
  for (let at = 0; at < text.length; at++) {
    bytes[at] = text.charCodeAt(at) & 0xff;
  }
  return bytes;
};

const isOpaque = (alpha: Uint8Array | undefined) =>
  !alpha || alpha.every((a) => a === 255);

/** The page as a complete PDF file. */
// eslint-disable-next-line max-lines-per-function
export function writePdf(page: TPdfPage, info: TPdfInfo): Uint8Array {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const write = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? latin1(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, body: string) => {
    offsets[id] = length;
    write(`${id} 0 obj\n${body}\nendobj\n`);
  };
  const stream = (id: number, dict: string, data: Uint8Array) => {
    const packed = zlibSync(data, { level: 6 });
    offsets[id] = length;
    write(
      `${id} 0 obj\n<< ${dict} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`
    );
    write(packed);
    write("\nendstream\nendobj\n");
  };

  // Object numbers, in writing order.
  let next = 1;
  const catalogId = next++;
  const pagesId = next++;
  const pageId = next++;
  const contentId = next++;
  const fontIds = PDF_FONTS.map(() => next++);
  const imageIds = page.images.map((image) => ({
    id: next++,
    mask: isOpaque(image.alpha) ? 0 : next++,
  }));
  const patternIds = page.patterns.map(() => next++);
  const attachments = (info.attachments ?? []).map((file) => ({
    file,
    data: next++,
    spec: next++,
  }));
  const infoId = next++;

  write("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
  const names = [...attachments]
    .sort((a, b) => (a.file.name < b.file.name ? -1 : 1))
    .map((a) => `${pdfText(a.file.name)} ${a.spec} 0 R`)
    .join(" ");
  object(
    catalogId,
    `<< /Type /Catalog /Pages ${pagesId} 0 R${
      attachments.length
        ? ` /Names << /EmbeddedFiles << /Names [${names}] >> >> /AF [${attachments.map((a) => `${a.spec} 0 R`).join(" ")}]`
        : ""
    } >>`
  );
  object(pagesId, `<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
  const fonts = fontIds.map((id, at) => `/F${at + 1} ${id} 0 R`).join(" ");
  const xobjects = imageIds.map(({ id }, at) => `/Im${at} ${id} 0 R`).join(" ");
  const states = page.alphas
    .map((a, at) => `/G${at} << /Type /ExtGState /ca ${a} /CA ${a} >>`)
    .join(" ");
  const patterns = patternIds.map((id, at) => `/P${at} ${id} 0 R`).join(" ");
  object(
    pageId,
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /ProcSet [/PDF /Text /ImageB /ImageC] /Font << ${fonts} >> /XObject << ${xobjects} >> /ExtGState << ${states} >> /Pattern << ${patterns} >> >> /Contents ${contentId} 0 R >>`
  );
  stream(contentId, "", latin1(page.content));
  fontIds.forEach((id, at) =>
    object(
      id,
      `<< /Type /Font /Subtype /Type1 /BaseFont /${PDF_FONTS[at]} /Encoding /WinAnsiEncoding >>`
    )
  );
  page.images.forEach((image, at) => {
    const { id, mask } = imageIds[at];
    const size = `/Width ${image.width} /Height ${image.height} /BitsPerComponent 8`;
    stream(
      id,
      `/Type /XObject /Subtype /Image ${size} /ColorSpace /DeviceRGB${mask ? ` /SMask ${mask} 0 R` : ""}`,
      image.rgb
    );
    if (mask) {
      stream(
        mask,
        `/Type /XObject /Subtype /Image ${size} /ColorSpace /DeviceGray`,
        image.alpha!
      );
    }
  });
  page.patterns.forEach((pattern, at) => {
    const { width: w, height: h } = pattern;
    // Image space is upside down against pattern (canvas) space.
    stream(
      patternIds[at],
      `/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 ${w} ${h}] /XStep ${w} /YStep ${h} /Matrix [${pattern.matrix.join(" ")}] /Resources << /XObject << /T ${imageIds[pattern.image].id} 0 R >> >>`,
      latin1(`q ${w} 0 0 ${-h} 0 ${h} cm /T Do Q`)
    );
  });
  for (const { file, data, spec } of attachments) {
    stream(
      data,
      `/Type /EmbeddedFile /Subtype /${file.mime.replace("/", "#2F")} /Params << /Size ${file.bytes.length} /ModDate ${pdfDate(info.date)} >>`,
      file.bytes
    );
    object(
      spec,
      `<< /Type /Filespec /F ${pdfText(file.name)} /UF ${pdfText(file.name)} /EF << /F ${data} 0 R /UF ${data} 0 R >> /Desc ${pdfText(file.description)} /AFRelationship /Supplement >>`
    );
  }
  object(
    infoId,
    `<< /Title ${pdfText(info.title)}${info.subject ? ` /Subject ${pdfText(info.subject)}` : ""} /Creator (Gridlook) /Producer (Gridlook) /CreationDate ${pdfDate(info.date)} >>`
  );

  const xref = length;
  write(`xref\n0 ${next}\n0000000000 65535 f \n`);
  for (let id = 1; id < next; id++) {
    write(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  write(
    `trailer\n<< /Size ${next} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  );
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
