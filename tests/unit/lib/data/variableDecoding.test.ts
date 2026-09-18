import { expect, it } from "vitest";

import { castDataVarToFloat32 } from "@/lib/data/variableDecoding.ts";

it("converts signed and unsigned 64-bit arrays to renderable values", () => {
  expect(
    castDataVarToFloat32(new BigInt64Array([-42n, 0n, 4294967296n]))
  ).toEqual(new Float32Array([-42, 0, 4294967296]));
  expect(
    castDataVarToFloat32(new BigUint64Array([0n, 4294967296n, 2n ** 63n]))
  ).toEqual(new Float32Array([0, 4294967296, 2 ** 63]));
});
