import catalog from "./countryCatalog.json";
import {
  GEOMETRY_KINDS,
  type TCountryGeometry,
  type TCountryResolution,
} from "./types.ts";

export const COUNTRY_ATLAS_VERSION = "world-atlas@2.0.2";

// The catalog lists scales with nonzero polygon area. For example, the source
// includes Vatican at 10m, but quantization collapses it to a line. Some
// territories share their sovereign's ISO code or have none, hence ne-* IDs.
const countries = catalog.map(([id, name, ...scales]) => ({
  id,
  name,
  scales,
}));
const byId = new Map(countries.map((country) => [country.id, country]));

export function countryName(id: string, resolution: TCountryResolution) {
  const country = byId.get(id);
  return country?.scales.includes(resolution) ? country.name : undefined;
}

/**
 * Several countries in words: "Germany + France + Poland", or past three
 * "Germany, France + 4 more countries".
 */
export function countriesName(ids: string[], resolution: TCountryResolution) {
  const names = ids.map((id) => countryName(id, resolution) ?? id);
  return names.length <= 3
    ? names.join(" + ")
    : `${names.slice(0, 2).join(", ")} + ${names.length - 2} more countries`;
}

export function isCountryId(id: string, resolution: TCountryResolution) {
  return countryName(id, resolution) !== undefined;
}

/** The picker and restored query labels need only the small name catalog. */
export async function getCountryList(resolution: TCountryResolution) {
  return countries
    .filter((country) => country.scales.includes(resolution))
    .map(({ id, name }) => ({ id, name }));
}

/** Closed GeoJSON [longitude, latitude] rings, grouped by polygon with holes. */
export async function getCountryRings(
  id: string,
  resolution: TCountryResolution
) {
  const name = countryName(id, resolution);
  if (!name) {
    throw new Error(
      `Country "${id}" is unavailable at the ${resolution} boundary scale.`
    );
  }
  const { countryRings } = await import("./countryGeoJSON.ts");
  return countryRings(name, resolution);
}

/** Most countries one selection holds. */
export const MAX_COUNTRIES = 64;

/**
 * The polygons of every country of a selection, in id order: countries do
 * not overlap, so a cell is inside the selection when inside one of them.
 */
export async function getCountriesRings(
  ids: string[],
  resolution: TCountryResolution
) {
  const each = await Promise.all(
    ids.map((id) => getCountryRings(id, resolution))
  );
  return each.flat();
}

/**
 * The country under a map click, at the given boundary scale: a right-click
 * menu preselects it in the country picker. Open sea gives undefined.
 */
export async function countryAt(
  lat: number,
  lon: number,
  resolution: TCountryResolution
): Promise<TCountryGeometry | undefined> {
  const { countryNameAt } = await import("./countryGeoJSON.ts");
  const name = await countryNameAt(lat, lon, resolution);
  const country = countries.find(
    (entry) => entry.name === name && entry.scales.includes(resolution)
  );
  return (
    country && { kind: GEOMETRY_KINDS.COUNTRY, id: country.id, resolution }
  );
}
