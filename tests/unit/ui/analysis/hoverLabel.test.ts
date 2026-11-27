import { describe, expect, it } from "vitest";

import { hoverText, placeLabel } from "@/ui/analysis/hoverLabel.ts";

describe("hover labels", () => {
  it("says what a control is: its title first, else its aria-label", () => {
    const attrs: Record<string, string> = { "aria-label": "Close plot" };
    const button = {
      getAttribute: (name: string) => attrs[name] ?? null,
    } as Element;
    expect(hoverText(button)).toBe("Close plot");
    attrs.title = "Close plot P1 (Undo brings it back)";
    expect(hoverText(button)).toBe("Close plot P1 (Undo brings it back)");
    // While it shows, the title is held aside: still the words shown.
    attrs["data-hover-title"] = attrs.title;
    delete attrs.title;
    expect(hoverText(button)).toBe("Close plot P1 (Undo brings it back)");
  });

  it("sits below the control, inside the screen, or above it at the bottom", () => {
    const screen = { width: 400, height: 300 };
    expect(
      placeLabel(
        { left: 100, top: 10, width: 20, height: 20 },
        { width: 60, height: 18 },
        screen
      )
    ).toEqual({ left: 80, top: 36 });
    // At the right edge: pulled in.
    expect(
      placeLabel(
        { left: 390, top: 10, width: 10, height: 20 },
        { width: 60, height: 18 },
        screen
      ).left
    ).toBe(336);
    // At the bottom: above.
    expect(
      placeLabel(
        { left: 100, top: 280, width: 20, height: 20 },
        { width: 60, height: 18 },
        screen
      ).top
    ).toBe(256);
  });
});
