import { expect, it } from "vitest";

import { canonicalNumber, idEncoding } from "@/lib/analysis/identifiers.ts";

it("interim48: identifiers are numbers only when each is one, written as one, all different", () => {
  expect(["12", "-3", "0.5"].map(canonicalNumber)).toEqual([true, true, true]);
  expect(["001", "1.0", "1e0", " 1", ""].map(canonicalNumber)).toEqual([
    false,
    false,
    false,
    false,
    false,
  ]);
  expect(idEncoding(["1", "2", "18446744073709551615"])).toBe("u8");
  expect(idEncoding(["1", "1.0", "1e0", "001"])).toBe("text");
  expect(idEncoding(["1", "2", "1"])).toBe("text");
});

it("interim49: one lossless encoding per source, text where no number type holds all", () => {
  // Either side of 2^63: all uint64, not a mix of int64 and uint64.
  const across = [
    "9223372036854775806",
    "9223372036854775807",
    "9223372036854775808",
    "9223372036854775809",
  ];
  expect(idEncoding(across)).toBe("u8");
  expect(idEncoding(["-1", "9223372036854775808"])).toBe("text");
  expect(idEncoding(["18446744073709551616", "18446744073709551617"])).toBe(
    "text"
  );
  expect(idEncoding(["-2", "7"])).toBe("i8");
  expect(idEncoding(["3", "4"], "uint8")).toBe("u8");
  expect(idEncoding(["0.5", "1.25"])).toBe("f8");
  expect(idEncoding(["control", "perturbed"])).toBe("text");
});
