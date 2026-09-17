import { describe, expect, it } from "vitest";

import { flattenErrorMessage } from "@/utils/errorHandling.ts";

describe("flattenErrorMessage", () => {
  it("returns the message when there is no cause", () => {
    expect(flattenErrorMessage(new Error("plain"))).toBe("plain");
  });

  it("appends the cause when there is one", () => {
    const error = new Error("outer", { cause: new Error("inner") });
    expect(flattenErrorMessage(error)).toBe("outer — inner");
  });

  it("stringifies a non-error", () => {
    expect(flattenErrorMessage("oops")).toBe("oops");
  });
});
