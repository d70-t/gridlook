import type { DataType } from "zarrita";

const Endian = {
  BIG: "big",
  LITTLE: "little",
} as const;

type TEndian = (typeof Endian)[keyof typeof Endian];

const GribEdition = {
  ONE: 1,
  TWO: 2,
} as const;

const Grib2DataRepresentationTemplate = {
  COMPLEX_PACKING: 2,
  COMPLEX_PACKING_SPATIAL_DIFFERENCING: 3,
  JPEG2000: 40,
  PNG: 41,
  CCSDS: 42,
  SIMPLE_PACKING: 0,
} as const;

const AecFlag = {
  DATA_3BYTE: 1 << 1,
  DATA_PREPROCESS: 1 << 3,
  DATA_SIGNED: 1 << 0,
  MSB: 1 << 2,
  PAD_RSI: 1 << 5,
  RESTRICTED: 1 << 4,
} as const;

type TCodecMeta = {
  codecs?: Array<{
    configuration?: Record<string, unknown>;
    name: string;
  }>;
  dataType?: DataType;
};

type TSection = {
  length: number;
  number: number;
  offset: number;
};

type TGrib1Bitmap = {
  count: number;
  data: Uint8Array;
};

type TGrib1BinaryData = {
  bitsPerValue: number;
  dataBytes: Uint8Array;
  packedCount: number;
  referenceValue: number;
  scale: number;
};

type TAecParams = {
  bitsPerSample: number;
  blockSize: number;
  flags: number;
  rsi: number;
};

type TDecodedArray =
  | BigInt64Array
  | BigUint64Array
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array;

export class GribscanRawGribCodec {
  readonly kind = "bytes_to_bytes";
  readonly #dataType: DataType;
  readonly #endian: TEndian;

  constructor(dataType: DataType = "float64", endian: TEndian = Endian.LITTLE) {
    this.#dataType = dataType;
    this.#endian = endian;
  }

  static fromConfig(_configuration: unknown, meta?: TCodecMeta) {
    return new GribscanRawGribCodec(
      meta?.dataType ?? "float64",
      getBytesEndian(meta)
    );
  }

  encode(arr: Uint8Array): Uint8Array {
    return arr;
  }

  decode(arr: Uint8Array): Uint8Array {
    return valuesToBytes(decodeGribMessage(arr), this.#dataType, this.#endian);
  }
}

class BitReader {
  #bytes: Uint8Array;
  #position: number;

  constructor(bytes: Uint8Array, byteOffset = 0) {
    this.#bytes = bytes;
    this.#position = byteOffset * 8;
  }

  alignToByte() {
    const remainder = this.#position % 8;
    if (remainder !== 0) {
      this.#position += 8 - remainder;
    }
  }

  readUint(bits: number) {
    if (bits === 0) {
      return 0;
    }

    let result = 0;
    let remaining = bits;
    while (remaining > 0) {
      const byteIndex = this.#position >> 3;
      if (byteIndex >= this.#bytes.byteLength) {
        throw new Error("Unexpected end of GRIB bitstream");
      }
      const bitOffset = this.#position & 7;
      const available = 8 - bitOffset;
      const take = Math.min(available, remaining);
      const shift = available - take;
      const mask = (1 << take) - 1;

      result = (result << take) | ((this.#bytes[byteIndex] >> shift) & mask);
      this.#position += take;
      remaining -= take;
    }

    return result >>> 0;
  }

  readBit() {
    return this.readUint(1) === 1;
  }
}

function decodeGribMessage(buffer: ArrayBufferLike | Uint8Array) {
  const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (
    buf[0] !== 0x47 ||
    buf[1] !== 0x52 ||
    buf[2] !== 0x49 ||
    buf[3] !== 0x42
  ) {
    throw new Error("Not a GRIB message: missing 'GRIB' magic bytes");
  }

  const edition = buf[7];
  if (edition === GribEdition.ONE) {
    return decodeGrib1(buf);
  }
  if (edition === GribEdition.TWO) {
    return decodeGrib2(buf);
  }
  throw new Error(`Unsupported GRIB edition: ${edition}`);
}

function decodeGrib1(buf: Uint8Array) {
  const view = createDataView(buf);
  const pdsStart = 8;
  const pdsLength = readUint24(view, pdsStart);
  const flagByte = view.getUint8(pdsStart + 7);
  const gdsPresent = (flagByte & 0x80) !== 0;
  const bmsPresent = (flagByte & 0x40) !== 0;
  const decimalScaleFactor = readGrib1DecimalScaleFactor(view, pdsStart);

  let offset = pdsStart + pdsLength;

  if (gdsPresent) {
    offset += readUint24(view, offset);
  }

  const { bitmap, nextOffset } = readGrib1Bitmap(buf, view, offset, bmsPresent);
  const binaryData = readGrib1BinaryData(
    buf,
    view,
    nextOffset,
    decimalScaleFactor
  );
  const packed = unpackGrib1Values(binaryData);

  return bitmap ? applyGrib1Bitmap(bitmap, packed) : packed;
}

function readGrib1Bitmap(
  buf: Uint8Array,
  view: DataView,
  offset: number,
  bmsPresent: boolean
) {
  if (!bmsPresent) {
    return { bitmap: undefined, nextOffset: offset };
  }

  const bmsLength = readUint24(view, offset);
  const unusedBits = view.getUint8(offset + 3);
  const bitmapByteCount = bmsLength - 6;
  return {
    bitmap: {
      count: bitmapByteCount * 8 - unusedBits,
      data: new Uint8Array(
        buf.buffer,
        buf.byteOffset + offset + 6,
        bitmapByteCount
      ),
    },
    nextOffset: offset + bmsLength,
  };
}

function readGrib1BinaryData(
  buf: Uint8Array,
  view: DataView,
  bdsStart: number,
  decimalScaleFactor: number
): TGrib1BinaryData {
  const bdsLength = readUint24(view, bdsStart);
  const flagBds = view.getUint8(bdsStart + 3);
  const unusedBitsAtEnd = flagBds & 0x0f;
  const binaryScaleFactor = signMagnitude(
    view.getUint16(bdsStart + 4, false),
    16
  );
  const referenceValue = readIbmFloat32(view, bdsStart + 6);
  const bitsPerValue = view.getUint8(bdsStart + 10);
  const dataStart = bdsStart + 11;
  const dataBytes = new Uint8Array(
    buf.buffer,
    buf.byteOffset + dataStart,
    bdsLength - 11
  );
  const scale =
    Math.pow(2, binaryScaleFactor) / Math.pow(10, decimalScaleFactor);
  const packedCount =
    bitsPerValue > 0
      ? Math.floor((dataBytes.length * 8 - unusedBitsAtEnd) / bitsPerValue)
      : 0;

  return { bitsPerValue, dataBytes, packedCount, referenceValue, scale };
}

function unpackGrib1Values(binaryData: TGrib1BinaryData) {
  const packed = new Float64Array(binaryData.packedCount);
  const reader = new BitReader(binaryData.dataBytes);
  for (let i = 0; i < binaryData.packedCount; i++) {
    packed[i] =
      binaryData.referenceValue +
      reader.readUint(binaryData.bitsPerValue) * binaryData.scale;
  }
  return packed;
}

function applyGrib1Bitmap(bitmap: TGrib1Bitmap, packed: Float64Array) {
  const out = new Float64Array(bitmap.count).fill(NaN);
  const bitmapReader = new BitReader(bitmap.data);
  let packedIndex = 0;
  for (let i = 0; i < bitmap.count; i++) {
    if (bitmapReader.readUint(1) === 1) {
      out[i] = packed[packedIndex++];
    }
  }
  return out;
}

function readGrib1DecimalScaleFactor(view: DataView, pdsStart: number) {
  return signMagnitude(view.getUint16(pdsStart + 26, false), 16);
}

function decodeGrib2(buf: Uint8Array) {
  const { sections, view } = parseGrib2Sections(buf);
  const sectionsByNumber = new Map(
    sections.map((section) => [section.number, section])
  );
  const section3 = sectionsByNumber.get(3);
  const section5 = sectionsByNumber.get(5);
  const section6 = sectionsByNumber.get(6);
  const section7 = sectionsByNumber.get(7);

  if (!section3 || !section5 || !section6 || !section7) {
    throw new Error("GRIB2 message missing required sections (3, 5, 6, or 7)");
  }

  const totalPoints = view.getUint32(section3.offset + 6, false);
  const template = view.getUint16(section5.offset + 9, false);
  switch (template) {
    case Grib2DataRepresentationTemplate.SIMPLE_PACKING:
      return decodeTemplate0(section5, section6, section7, view, totalPoints);
    case Grib2DataRepresentationTemplate.COMPLEX_PACKING:
      return decodeTemplate2(section5, section6, section7, view, totalPoints);
    case Grib2DataRepresentationTemplate.COMPLEX_PACKING_SPATIAL_DIFFERENCING:
      return decodeTemplate3(section5, section6, section7, view, totalPoints);
    case Grib2DataRepresentationTemplate.JPEG2000:
      throw new Error("GRIB2 template 40 (JPEG 2000) is not supported");
    case Grib2DataRepresentationTemplate.PNG:
      throw new Error("GRIB2 template 41 (PNG) is not supported");
    case Grib2DataRepresentationTemplate.CCSDS:
      return decodeTemplate42(section5, section6, section7, view, totalPoints);
    default:
      throw new Error(
        `GRIB2 data representation template ${template} is not supported`
      );
  }
}

function decodeTemplate0(
  section5: TSection,
  section6: TSection,
  section7: TSection,
  view: DataView,
  totalPoints: number
) {
  const s5 = section5.offset;
  const referenceValue = view.getFloat32(s5 + 11, false);
  const binaryScaleFactor = view.getInt16(s5 + 15, false);
  const decimalScaleFactor = view.getInt16(s5 + 17, false);
  const bitsPerValue = view.getUint8(s5 + 19);
  const valueCount = view.getUint32(s5 + 5, false);
  const scale =
    Math.pow(2, binaryScaleFactor) / Math.pow(10, decimalScaleFactor);

  return unpackSimple(
    section6,
    section7,
    view,
    referenceValue,
    scale,
    bitsPerValue,
    valueCount,
    totalPoints
  );
}

function decodeTemplate2(
  section5: TSection,
  section6: TSection,
  section7: TSection,
  view: DataView,
  totalPoints: number
) {
  const params = readComplexPackingParams(section5, view);
  const reader = createSection7Reader(section7, view);
  const groupReference = readGroupReferences(reader, params);
  reader.alignToByte();
  const groupWidth = readGroupWidths(reader, params);
  reader.alignToByte();
  const groupLength = readGroupLengths(reader, params);
  reader.alignToByte();

  const out = new Float64Array(params.valueCount);
  let outIndex = 0;
  for (let group = 0; group < params.groupCount; group++) {
    const width = groupWidth[group];
    const length = groupLength[group];
    for (let i = 0; i < length; i++) {
      const value = width > 0 ? reader.readUint(width) : 0;
      if (
        isComplexPackingMissingValue(value, width, params.missingManagement)
      ) {
        out[outIndex++] = NaN;
        continue;
      }
      out[outIndex++] =
        params.referenceValue + (groupReference[group] + value) * params.scale;
    }
  }

  return applyBitmap(section6, view, out, totalPoints);
}

function decodeTemplate3(
  section5: TSection,
  section6: TSection,
  section7: TSection,
  view: DataView,
  totalPoints: number
) {
  const params = readComplexPackingParams(section5, view);
  const orderSpatialDifferencing = view.getUint8(section5.offset + 47);
  const extraDescriptorOctets = view.getUint8(section5.offset + 48);
  const extraDescriptorBits = extraDescriptorOctets * 8;
  const reader = createSection7Reader(section7, view);
  const initialValues = Array.from({ length: orderSpatialDifferencing }, () =>
    signMagnitude(reader.readUint(extraDescriptorBits), extraDescriptorBits)
  );
  const overallMinimum = signMagnitude(
    reader.readUint(extraDescriptorBits),
    extraDescriptorBits
  );
  const groupReference = readGroupReferences(reader, params);
  reader.alignToByte();
  const groupWidth = readGroupWidths(reader, params);
  reader.alignToByte();
  const groupLength = readGroupLengths(reader, params);
  reader.alignToByte();
  const values = unpackComplexIntegerValues(
    reader,
    params,
    groupReference,
    groupWidth,
    groupLength
  );

  restoreSpatialDifferences(
    values,
    initialValues,
    overallMinimum,
    orderSpatialDifferencing
  );

  const out = new Float64Array(params.valueCount);
  for (let i = 0; i < params.valueCount; i++) {
    out[i] = params.referenceValue + values[i] * params.scale;
  }
  return applyBitmap(section6, view, out, totalPoints);
}

function decodeTemplate42(
  section5: TSection,
  section6: TSection,
  section7: TSection,
  view: DataView,
  totalPoints: number
) {
  const s5 = section5.offset;
  const binaryScaleFactor = view.getInt16(s5 + 15, false);
  const decimalScaleFactor = view.getInt16(s5 + 17, false);
  const params = {
    bitsPerSample: view.getUint8(s5 + 19),
    blockSize: view.getUint8(s5 + 22),
    flags: aecFlagsFromGrib2(view.getUint8(s5 + 21)),
    rsi: view.getUint16(s5 + 23, false),
  };
  const sampleValues = decodeAecSamples(
    createSection7Bytes(section7, view),
    params,
    view.getUint32(s5 + 5, false)
  );
  const scale =
    Math.pow(2, binaryScaleFactor) / Math.pow(10, decimalScaleFactor);

  return applyBitmap(
    section6,
    view,
    scaleAecSamples(sampleValues, view.getFloat32(s5 + 11, false), scale),
    totalPoints
  );
}

function readComplexPackingParams(section5: TSection, view: DataView) {
  const s5 = section5.offset;
  const binaryScaleFactor = view.getInt16(s5 + 15, false);
  const decimalScaleFactor = view.getInt16(s5 + 17, false);
  return {
    bitsGroupWidth: view.getUint8(s5 + 36),
    bitsPerValue: view.getUint8(s5 + 19),
    bitsScaledLength: view.getUint8(s5 + 46),
    groupCount: view.getUint32(s5 + 31, false),
    lastGroupLength: view.getUint32(s5 + 42, false),
    lengthIncrement: view.getUint8(s5 + 41),
    missingManagement: view.getUint8(s5 + 22),
    referenceGroupLength: view.getUint32(s5 + 37, false),
    referenceGroupWidth: view.getUint8(s5 + 35),
    referenceValue: view.getFloat32(s5 + 11, false),
    scale: Math.pow(2, binaryScaleFactor) / Math.pow(10, decimalScaleFactor),
    valueCount: view.getUint32(s5 + 5, false),
  };
}

function readGroupReferences(
  reader: BitReader,
  params: ReturnType<typeof readComplexPackingParams>
) {
  const groupReference = new Uint32Array(params.groupCount);
  for (let group = 0; group < params.groupCount; group++) {
    groupReference[group] = reader.readUint(params.bitsPerValue);
  }
  return groupReference;
}

function readGroupWidths(
  reader: BitReader,
  params: ReturnType<typeof readComplexPackingParams>
) {
  const groupWidth = new Uint32Array(params.groupCount);
  for (let group = 0; group < params.groupCount; group++) {
    groupWidth[group] =
      params.referenceGroupWidth + reader.readUint(params.bitsGroupWidth);
  }
  return groupWidth;
}

function readGroupLengths(
  reader: BitReader,
  params: ReturnType<typeof readComplexPackingParams>
) {
  const groupLength = new Uint32Array(params.groupCount);
  for (let group = 0; group < params.groupCount - 1; group++) {
    groupLength[group] =
      params.referenceGroupLength +
      reader.readUint(params.bitsScaledLength) * params.lengthIncrement;
  }
  groupLength[params.groupCount - 1] = params.lastGroupLength;
  return groupLength;
}

function unpackComplexIntegerValues(
  reader: BitReader,
  params: ReturnType<typeof readComplexPackingParams>,
  groupReference: Uint32Array,
  groupWidth: Uint32Array,
  groupLength: Uint32Array
) {
  const values = new Int32Array(params.valueCount);
  let outIndex = 0;
  for (let group = 0; group < params.groupCount; group++) {
    const width = groupWidth[group];
    const length = groupLength[group];
    for (let i = 0; i < length; i++) {
      const value = width > 0 ? reader.readUint(width) : 0;
      values[outIndex++] = groupReference[group] + value;
    }
  }
  return values;
}

function restoreSpatialDifferences(
  values: Int32Array,
  initialValues: number[],
  overallMinimum: number,
  orderSpatialDifferencing: number
) {
  if (orderSpatialDifferencing === 1) {
    values[0] = initialValues[0];
    for (let i = 1; i < values.length; i++) {
      values[i] += overallMinimum + values[i - 1];
    }
    return;
  }
  if (orderSpatialDifferencing === 2) {
    values[0] = initialValues[0];
    values[1] = initialValues[1];
    for (let i = 2; i < values.length; i++) {
      values[i] += overallMinimum + 2 * values[i - 1] - values[i - 2];
    }
    return;
  }
  throw new Error(
    `GRIB2 spatial differencing order ${orderSpatialDifferencing} is not supported`
  );
}

function unpackSimple(
  section6: TSection,
  section7: TSection,
  view: DataView,
  referenceValue: number,
  scale: number,
  bitsPerValue: number,
  valueCount: number,
  totalPoints: number
) {
  const out = new Float64Array(valueCount);
  if (bitsPerValue === 0) {
    out.fill(referenceValue);
    return applyBitmap(section6, view, out, totalPoints);
  }

  const reader = createSection7Reader(section7, view);
  for (let i = 0; i < valueCount; i++) {
    out[i] = referenceValue + reader.readUint(bitsPerValue) * scale;
  }
  return applyBitmap(section6, view, out, totalPoints);
}

function applyBitmap(
  section6: TSection,
  view: DataView,
  packedValues: Float64Array,
  totalPoints: number
) {
  const bitmapIndicator = view.getUint8(section6.offset + 5);
  if (bitmapIndicator === 255) {
    return packedValues;
  }
  if (bitmapIndicator !== 0) {
    throw new Error(
      `GRIB2 bitmap indicator ${bitmapIndicator} is not supported`
    );
  }

  const bitmapStart = section6.offset + 6;
  const bitmapByteCount = section6.length - 6;
  const out = new Float64Array(totalPoints).fill(NaN);
  const reader = new BitReader(
    new Uint8Array(view.buffer, view.byteOffset + bitmapStart, bitmapByteCount)
  );
  let packedIndex = 0;
  for (let i = 0; i < totalPoints; i++) {
    if (reader.readUint(1) === 1) {
      out[i] = packedValues[packedIndex++];
    }
  }
  return out;
}

function parseGrib2Sections(buf: Uint8Array) {
  const view = createDataView(buf);
  const sections: TSection[] = [{ length: 16, number: 0, offset: 0 }];
  let position = 16;

  while (position < buf.byteLength - 4) {
    if (
      buf[position] === 0x37 &&
      buf[position + 1] === 0x37 &&
      buf[position + 2] === 0x37 &&
      buf[position + 3] === 0x37
    ) {
      sections.push({ length: 4, number: 8, offset: position });
      break;
    }

    const sectionLength = view.getUint32(position, false);
    sections.push({
      length: sectionLength,
      number: view.getUint8(position + 4),
      offset: position,
    });
    position += sectionLength;
  }

  return { sections, view };
}

function createSection7Reader(section7: TSection, view: DataView) {
  return new BitReader(createSection7Bytes(section7, view));
}

function createSection7Bytes(section7: TSection, view: DataView) {
  const dataStart = section7.offset + 5;
  return new Uint8Array(
    view.buffer,
    view.byteOffset + dataStart,
    section7.length - 5
  );
}

class AecDecoder {
  readonly #idLength: number;
  readonly #output: Float64Array;
  readonly #params: TAecParams;
  readonly #reader: BitReader;
  #blockIndexWithinRsi = 0;
  #predictor: number | undefined;
  #sampleIndex = 0;

  constructor(input: Uint8Array, params: TAecParams, outputSamples: number) {
    validateAecParams(params);
    this.#idLength = getAecIdLength(params);
    this.#output = new Float64Array(outputSamples);
    this.#params = params;
    this.#reader = new BitReader(input);
  }

  decode() {
    while (this.#sampleIndex < this.#output.length) {
      this.#decodeBlock();
    }
    return this.#output;
  }

  #decodeBlock() {
    if (this.#isRsiStart()) {
      this.#predictor = undefined;
    }

    const id = this.#reader.readUint(this.#idLength);
    const maxId = Math.pow(2, this.#idLength) - 1;
    if (id === 0) {
      this.#decodeLowEntropyBlock();
    } else if (id === maxId) {
      this.#decodeUncompressedBlock();
    } else {
      this.#decodeSplitBlock(id - 1);
    }
  }

  #decodeLowEntropyBlock() {
    const selector = this.#reader.readBit();
    const referenceSampleConsumed = this.#consumeRsiReferenceIfNeeded();
    const remaining = this.#remainingBlockSamples(referenceSampleConsumed);

    if (!selector) {
      this.#decodeZeroRun(referenceSampleConsumed);
      return;
    }

    this.#decodeSecondExtension(remaining, referenceSampleConsumed);
    this.#advanceBlockIndex(1);
  }

  #decodeZeroRun(referenceSampleConsumed: boolean) {
    const blockCount = this.#readZeroBlockCount();
    const sampleCount =
      blockCount * this.#params.blockSize - Number(referenceSampleConsumed);
    this.#emitRepeatedValue(0, sampleCount);
    this.#advanceBlockIndex(blockCount);
  }

  #decodeUncompressedBlock() {
    const referenceSampleConsumed = this.#consumeRsiReferenceIfNeeded();
    const remaining = this.#remainingBlockSamples(referenceSampleConsumed);
    for (let i = 0; i < remaining && this.#hasOutputSpace(); i++) {
      this.#emitValue(this.#reader.readUint(this.#params.bitsPerSample));
    }
    this.#advanceBlockIndex(1);
  }

  #decodeSplitBlock(k: number) {
    const referenceSampleConsumed = this.#consumeRsiReferenceIfNeeded();
    const sampleCount = Math.min(
      this.#remainingBlockSamples(referenceSampleConsumed),
      this.#output.length - this.#sampleIndex
    );
    const values = this.#readSplitValues(k, sampleCount);

    for (const value of values) {
      this.#emitValue(value);
    }
    this.#advanceBlockIndex(1);
  }

  #readSplitValues(k: number, sampleCount: number) {
    const values = new Uint32Array(sampleCount);
    const multiplier = Math.pow(2, k);
    for (let i = 0; i < sampleCount; i++) {
      values[i] = readUnary(this.#reader) * multiplier;
    }
    for (let i = 0; k > 0 && i < sampleCount; i++) {
      values[i] += this.#reader.readUint(k);
    }
    return values;
  }

  #decodeSecondExtension(remaining: number, referenceSampleConsumed: boolean) {
    let remainingInBlock = remaining;
    let emitOddFirst = referenceSampleConsumed;

    while (remainingInBlock > 0 && this.#hasOutputSpace()) {
      const [evenValue, oddValue] = readSecondExtensionPair(this.#reader);
      if (emitOddFirst) {
        this.#emitValue(oddValue);
        remainingInBlock -= 1;
        emitOddFirst = false;
        continue;
      }
      this.#emitValue(evenValue);
      remainingInBlock -= 1;
      if (remainingInBlock > 0 && this.#hasOutputSpace()) {
        this.#emitValue(oddValue);
        remainingInBlock -= 1;
      }
    }
  }

  #readZeroBlockCount() {
    const runOptionStart = 5;
    const runLength = readUnary(this.#reader);
    let blockCount = runLength + 1;

    if (blockCount === runOptionStart) {
      blockCount = Math.min(
        this.#params.rsi - this.#blockIndexWithinRsi,
        64 - (this.#blockIndexWithinRsi % 64)
      );
    } else if (blockCount > runOptionStart) {
      blockCount -= 1;
    }

    return blockCount;
  }

  #consumeRsiReferenceIfNeeded() {
    if (!this.#isRsiStart()) {
      return false;
    }

    const raw = this.#reader.readUint(this.#params.bitsPerSample);
    const value = hasAecFlag(this.#params, AecFlag.DATA_SIGNED)
      ? signExtend(raw, this.#params.bitsPerSample)
      : raw;
    this.#output[this.#sampleIndex++] = value;
    this.#predictor = value;
    return true;
  }

  #emitRepeatedValue(value: number, count: number) {
    for (let i = 0; i < count && this.#hasOutputSpace(); i++) {
      this.#emitValue(value);
    }
  }

  #emitValue(value: number) {
    if (!this.#hasOutputSpace()) {
      return;
    }

    const sampleValue = hasAecFlag(this.#params, AecFlag.DATA_PREPROCESS)
      ? this.#restorePreprocessedValue(value)
      : this.#readRawSampleValue(value);
    this.#output[this.#sampleIndex++] = sampleValue;
  }

  #restorePreprocessedValue(value: number) {
    if (this.#predictor === undefined) {
      throw new Error("CCSDS/AEC stream is missing a reference sample");
    }

    const next = inverseAecPreprocess(this.#predictor, value, this.#params);
    this.#predictor = next;
    return next;
  }

  #readRawSampleValue(value: number) {
    return hasAecFlag(this.#params, AecFlag.DATA_SIGNED)
      ? signExtend(value, this.#params.bitsPerSample)
      : value;
  }

  #remainingBlockSamples(referenceSampleConsumed: boolean) {
    return this.#params.blockSize - Number(referenceSampleConsumed);
  }

  #advanceBlockIndex(blockCount: number) {
    this.#blockIndexWithinRsi += blockCount;
    if (!hasAecFlag(this.#params, AecFlag.DATA_PREPROCESS)) {
      return;
    }

    if (this.#blockIndexWithinRsi >= this.#params.rsi) {
      this.#blockIndexWithinRsi %= this.#params.rsi;
      if (hasAecFlag(this.#params, AecFlag.PAD_RSI)) {
        this.#reader.alignToByte();
      }
    }
  }

  #isRsiStart() {
    return (
      hasAecFlag(this.#params, AecFlag.DATA_PREPROCESS) &&
      this.#blockIndexWithinRsi === 0
    );
  }

  #hasOutputSpace() {
    return this.#sampleIndex < this.#output.length;
  }
}

function decodeAecSamples(
  input: Uint8Array,
  params: TAecParams,
  outputSamples: number
) {
  return new AecDecoder(input, params, outputSamples).decode();
}

function readUnary(reader: BitReader) {
  let count = 0;
  while (!reader.readBit()) {
    count += 1;
    if (count > 1_000_000) {
      throw new Error("CCSDS/AEC unary run is too long");
    }
  }
  return count;
}

function readSecondExtensionPair(reader: BitReader): [number, number] {
  const value = readUnary(reader);
  if (value > 90) {
    throw new Error("CCSDS/AEC second-extension symbol is too large");
  }

  let index = 0;
  for (let sum = 0; sum <= 12; sum++) {
    for (let k = 0; k <= sum; k++) {
      if (index === value) {
        return [sum - k, k];
      }
      index += 1;
    }
  }

  return [0, 0];
}

function inverseAecPreprocess(
  previousValue: number,
  encodedDelta: number,
  params: TAecParams
) {
  const delta =
    encodedDelta % 2 === 0 ? encodedDelta / 2 : -((encodedDelta + 1) / 2);
  const halfDelta = Math.floor(encodedDelta / 2) + (encodedDelta % 2);

  return hasAecFlag(params, AecFlag.DATA_SIGNED)
    ? inverseSignedAecPreprocess(
        previousValue,
        encodedDelta,
        delta,
        halfDelta,
        params
      )
    : inverseUnsignedAecPreprocess(
        previousValue,
        encodedDelta,
        delta,
        halfDelta,
        params
      );
}

function inverseSignedAecPreprocess(
  previousValue: number,
  encodedDelta: number,
  delta: number,
  halfDelta: number,
  params: TAecParams
) {
  const signedMax = Math.pow(2, params.bitsPerSample - 1) - 1;
  if (previousValue < 0) {
    return halfDelta <= signedMax + previousValue + 1
      ? previousValue + delta
      : encodedDelta - signedMax - 1;
  }
  return halfDelta <= signedMax - previousValue
    ? previousValue + delta
    : signedMax - encodedDelta;
}

function inverseUnsignedAecPreprocess(
  previousValue: number,
  encodedDelta: number,
  delta: number,
  halfDelta: number,
  params: TAecParams
) {
  const unsignedMax = Math.pow(2, params.bitsPerSample) - 1;
  const midpoint = Math.pow(2, params.bitsPerSample - 1);
  const highMask = Math.floor(previousValue / midpoint) % 2 === 1;
  const threshold = highMask ? unsignedMax - previousValue : previousValue;

  if (halfDelta <= threshold) {
    return previousValue + delta;
  }
  return highMask ? unsignedMax - encodedDelta : encodedDelta;
}

function scaleAecSamples(
  sampleValues: Float64Array,
  referenceValue: number,
  scale: number
) {
  const out = new Float64Array(sampleValues.length);
  for (let i = 0; i < sampleValues.length; i++) {
    out[i] = referenceValue + sampleValues[i] * scale;
  }
  return out;
}

function aecFlagsFromGrib2(ccsdsFlags: number) {
  let flags = 0;

  if ((ccsdsFlags & (1 << 0)) !== 0) {
    flags |= AecFlag.DATA_SIGNED;
  }
  if ((ccsdsFlags & (1 << 1)) !== 0) {
    flags |= AecFlag.DATA_3BYTE;
  }
  if ((ccsdsFlags & (1 << 2)) !== 0) {
    flags |= AecFlag.MSB;
  }
  if ((ccsdsFlags & (1 << 3)) !== 0) {
    flags |= AecFlag.DATA_PREPROCESS;
  }
  if ((ccsdsFlags & (1 << 4)) !== 0) {
    flags |= AecFlag.RESTRICTED;
  }
  if ((ccsdsFlags & (1 << 5)) !== 0) {
    flags |= AecFlag.PAD_RSI;
  }

  return flags;
}

function validateAecParams(params: TAecParams) {
  if (params.bitsPerSample < 1 || params.bitsPerSample > 32) {
    throw new Error("CCSDS/AEC bits per sample must be between 1 and 32");
  }
  if (![8, 16, 32, 64].includes(params.blockSize)) {
    throw new Error("CCSDS/AEC block size must be one of 8, 16, 32, or 64");
  }
  if (params.rsi <= 0) {
    throw new Error("CCSDS/AEC reference sample interval must be positive");
  }
}

function getAecIdLength(params: TAecParams) {
  if (hasAecFlag(params, AecFlag.RESTRICTED) && params.bitsPerSample <= 4) {
    return params.bitsPerSample <= 2 ? 1 : 2;
  }
  if (params.bitsPerSample > 16) {
    return 5;
  }
  return params.bitsPerSample > 8 ? 4 : 3;
}

function hasAecFlag(params: TAecParams, flag: number) {
  return (params.flags & flag) !== 0;
}

function valuesToBytes(
  values: Float64Array,
  dataType: DataType,
  endian: TEndian
) {
  const typedValues = castValues(values, dataType);
  const bytes = new Uint8Array(
    typedValues.buffer,
    typedValues.byteOffset,
    typedValues.byteLength
  );

  if (endian === Endian.LITTLE || bytesPerElement(typedValues) === 1) {
    return bytes;
  }

  const swapped = new Uint8Array(bytes);
  byteswapInPlace(swapped, bytesPerElement(typedValues));
  return swapped;
}

function castValues(values: Float64Array, dataType: DataType): TDecodedArray {
  switch (dataType) {
    case "int8":
      return Int8Array.from(values);
    case "int16":
      return Int16Array.from(values);
    case "int32":
      return Int32Array.from(values);
    case "int64":
      return BigInt64Array.from(values, (value) => BigInt(Math.trunc(value)));
    case "uint8":
      return Uint8Array.from(values);
    case "uint16":
      return Uint16Array.from(values);
    case "uint32":
      return Uint32Array.from(values);
    case "uint64":
      return BigUint64Array.from(values, (value) => BigInt(Math.trunc(value)));
    case "float32":
      return Float32Array.from(values);
    case "float64":
      return values;
    default:
      throw new Error(`GRIB values cannot be decoded as ${dataType}`);
  }
}

function isComplexPackingMissingValue(
  value: number,
  width: number,
  missingManagement: number
) {
  if (missingManagement === 0 || width === 0) {
    return false;
  }

  const allOnes = Math.pow(2, width) - 1;
  if (value === allOnes) {
    return true;
  }

  return missingManagement === 2 && width > 1 && value === allOnes - 1;
}

function getBytesEndian(meta?: TCodecMeta): TEndian {
  const bytesCodec = meta?.codecs?.find((codec) => codec.name === "bytes");
  return bytesCodec?.configuration?.endian === Endian.BIG
    ? Endian.BIG
    : Endian.LITTLE;
}

function createDataView(buf: Uint8Array) {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

function readUint24(view: DataView, offset: number) {
  return (
    (view.getUint8(offset) << 16) |
    (view.getUint8(offset + 1) << 8) |
    view.getUint8(offset + 2)
  );
}

function readIbmFloat32(view: DataView, offset: number) {
  const b0 = view.getUint8(offset);
  const b1 = view.getUint8(offset + 1);
  const b2 = view.getUint8(offset + 2);
  const b3 = view.getUint8(offset + 3);
  const sign = b0 & 0x80 ? -1 : 1;
  const exponent = (b0 & 0x7f) - 64;
  const mantissa = ((b1 << 16) | (b2 << 8) | b3) / 0x1000000;
  return sign * mantissa * Math.pow(16, exponent);
}

function signMagnitude(raw: number, bits: number) {
  if (bits === 0) {
    return 0;
  }

  const signBit = Math.pow(2, bits - 1);
  if (raw >= signBit) {
    return -(raw - signBit);
  }
  return raw;
}

function signExtend(raw: number, bits: number) {
  const signBit = Math.pow(2, bits - 1);
  return raw >= signBit ? raw - Math.pow(2, bits) : raw;
}

function bytesPerElement(values: TDecodedArray) {
  return values.BYTES_PER_ELEMENT;
}

function byteswapInPlace(bytes: Uint8Array, bytesPerElementValue: number) {
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += bytesPerElementValue
  ) {
    for (let i = 0; i < bytesPerElementValue / 2; i++) {
      const left = offset + i;
      const right = offset + bytesPerElementValue - 1 - i;
      const tmp = bytes[left];
      bytes[left] = bytes[right];
      bytes[right] = tmp;
    }
  }
}
