import { shallowRef } from "vue";

import type {
  TCountryGeometry,
  TCountryResolution,
} from "@/lib/analysis/types.ts";

/** An open country picker that accepts a country clicked on the map. */
export type TMapCountryPicker = {
  resolution: () => TCountryResolution;
  /** `additive`: Ctrl/⌘ held, the country joins those chosen. */
  choose: (country: TCountryGeometry | undefined, additive?: boolean) => void;
};

const open: TMapCountryPicker[] = [];

/**
 * The picker map clicks go to: the newest open one, for a new plot or in a
 * plot's Settings. The map shows a crosshair while there is one.
 */
export const mapCountryPicker = shallowRef<TMapCountryPicker>();

export function registerCountryPicker(picker: TMapCountryPicker) {
  open.push(picker);
  mapCountryPicker.value = picker;
  return () => {
    open.splice(open.indexOf(picker), 1);
    mapCountryPicker.value = open.at(-1);
  };
}
