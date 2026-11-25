import { expect, it } from "vitest";

import {
  mapCountryPicker,
  registerCountryPicker,
} from "@/ui/analysis/countryPicking.ts";

const picker = () => ({ resolution: () => "50m" as const, choose() {} });

it("sends map picks to the newest open country picker, then back", () => {
  const plot = picker();
  const settings = picker();
  const closePlot = registerCountryPicker(plot);
  expect(mapCountryPicker.value).toBe(plot);
  // Settings → Change country, opened while the new-plot panel is open.
  const closeSettings = registerCountryPicker(settings);
  expect(mapCountryPicker.value).toBe(settings);
  closeSettings();
  expect(mapCountryPicker.value).toBe(plot);
  closePlot();
  expect(mapCountryPicker.value).toBeUndefined();
});
