/**
 * What a failure is travels with it: decided where it happens, not read
 * back out of its words by the window and the preview.
 */
import { expect, it } from "vitest";

import {
  AnalysisSizeError,
  tooManyValues,
} from "@/lib/analysis/analysisErrors.ts";
import { classifyError } from "@/lib/analysis/analysisRunner.ts";
import { sizeRefusal } from "@/lib/analysis/preview.ts";
import { errorHelp } from "@/ui/analysis/errorHelp.ts";

it("the worker says what a failure is", () => {
  const size = tooManyValues("Too many cells.", 4_000_000, 2_000_000, "bins");
  expect(classifyError(size)).toEqual({
    kind: "input",
    message: "Too many cells.",
    detail: {
      reason: "size",
      values: 4_000_000,
      limit: 2_000_000,
      unit: "bins",
    },
  });
  expect(classifyError(new RangeError("Invalid array length")).detail).toEqual({
    reason: "memory",
  });
  expect(classifyError(new TypeError("Failed to fetch")).detail).toEqual({
    reason: "unreachable",
  });
  expect(classifyError(new Error("HTTP 503")).detail).toEqual({
    reason: "unreachable",
  });
  expect(
    classifyError(new Error("A coordinate is odd.")).detail
  ).toBeUndefined();
});

it("the help and the first dates follow the detail, whatever the words", () => {
  // Words that name nothing the old parser knew.
  const detail = {
    reason: "size" as const,
    values: 6_000_000,
    limit: 2_000_000,
    unit: "bins" as const,
  };
  const help = errorHelp("Zu viele Werte.", true, detail);
  expect(help.title).toBe("Too many values for one plot");
  expect(help.size).toEqual({ values: 6_000_000, limit: 2_000_000 });
  expect(help.actions).toEqual([
    "first-dates",
    "dates",
    "bins",
    "settings",
    "copy",
  ]);
  expect(sizeRefusal("Zu viele Werte.", detail)).toEqual({
    values: 6_000_000,
    limit: 2_000_000,
  });
  // Too many stored chunks: some dates fit.
  const chunks = new AnalysisSizeError("Zu viele Chunks.", {
    reason: "size",
    decodedBytes: 2 ** 30,
  });
  expect(sizeRefusal(chunks.message, chunks.detail)).toEqual({
    values: undefined,
    refused: "Zu viele Chunks.",
    decodedBytes: 2 ** 30,
  });
  // A store that did not answer, said in any words: Retry.
  expect(
    errorHelp("Keine Antwort.", true, { reason: "unreachable" }).actions
  ).toEqual(["retry", "copy"]);
  // "HTTP" in a size message is no network failure.
  expect(errorHelp("HTTP-sized request.", false, detail).title).toBe(
    "Too many values for one plot"
  );
  // Without a detail (an older message), the words still decide.
  expect(errorHelp("HTTP 503", false).actions).toEqual(["retry", "copy"]);
});
