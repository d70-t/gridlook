const CHECKSUM_LENGTH = 4;
const MAX_WORDS_PER_BLOCK = 360;

export class Fletcher32Codec {
  readonly kind = "bytes_to_bytes";

  static fromConfig() {
    return new Fletcher32Codec();
  }

  encode(): never {
    throw new Error("encode not implemented");
  }

  decode(arr: Uint8Array): Uint8Array {
    if (arr.byteLength <= CHECKSUM_LENGTH) {
      throw new Error("Fletcher32 data must contain data and a checksum");
    }

    const decodedLength = arr.byteLength - CHECKSUM_LENGTH;
    const decoded = new Uint8Array(arr.buffer, arr.byteOffset, decodedLength);
    const expected = new DataView(
      arr.buffer,
      arr.byteOffset + decodedLength,
      CHECKSUM_LENGTH
    ).getUint32(0, true);

    if (fletcher32(decoded) !== expected) {
      throw new Error("Fletcher32 checksum mismatch");
    }

    return decoded;
  }

  computeEncodedSize(decodedSize: number): number {
    return decodedSize + CHECKSUM_LENGTH;
  }
}

function fletcher32(data: Uint8Array): number {
  let sum1 = 0;
  let sum2 = 0;
  let offset = 0;
  let wordsRemaining = Math.ceil(data.byteLength / 2);

  while (wordsRemaining > 0) {
    const blockLength = Math.min(wordsRemaining, MAX_WORDS_PER_BLOCK);
    wordsRemaining -= blockLength;

    for (let word = 0; word < blockLength; word += 1) {
      sum1 += data[offset] << 8;
      if (offset + 1 < data.byteLength) {
        sum1 += data[offset + 1];
      }
      sum2 += sum1;
      offset += 2;
    }

    sum1 = fold(sum1);
    sum2 = fold(sum2);
  }

  sum1 = fold(sum1);
  sum2 = fold(sum2);

  return ((sum2 << 16) | sum1) >>> 0;
}

function fold(sum: number): number {
  return (sum & 0xffff) + (sum >>> 16);
}
