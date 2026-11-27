/**
 * Converting values between units of one quantity, so two series compared
 * or two wind components combined are in the same units: temperatures
 * (K, °C, °F), speeds, lengths, pressures and mass fluxes. Anything else
 * converts only to itself; `undefined` means the units cannot be matched.
 */

/**
 * Units spelled as CF and common files spell them, normalised; case is
 * kept, as SI symbols need it (MPa is not mPa, Mm is not mm).
 */
function normal(units: string | undefined) {
  return (units ?? "")
    .trim()
    .replace(/\*\*/g, "^")
    .replace(/\^/g, "")
    .replace(/\s+/g, " ")
    .replace(/°/g, "deg");
}

/**
 * Whether a spelling may be read without its case: words (Kelvin, Meters
 * per second) and symbols without a prefix whose case changes the unit
 * (an upper-case M, G, T, P, E, Z or Y before a symbol is mega, giga…).
 */
function caseFree(units: string) {
  return (
    /^[A-Za-z]{4,}\b/.test(units) ||
    !/^[MGTPEZY](Pa|m|g|s|K|W|J|N|Hz|L|l|bar|t)\b/.test(units)
  );
}

/** A table's entry for a spelling: as written, else without its case. */
function lookup<T>(table: Record<string, T>, units: string) {
  const found =
    table[units] ?? (caseFree(units) ? table[units.toLowerCase()] : undefined);
  if (found !== undefined || !units.includes(" ")) {
    return found;
  }
  // Factors in another order are the same unit: kg s-1 m-2 is kg m-2 s-1.
  const key = factorsOf(units);
  const match = Object.keys(table).find(
    (k) => k.includes(" ") && factorsOf(k) === key
  );
  return match === undefined ? undefined : table[match];
}

/** A product of factors, in one order. */
function factorsOf(units: string) {
  return units.split(" ").sort().join(" ");
}

/** Two normalised spellings of one unit. */
function same(a: string, b: string) {
  return (
    a === b ||
    (caseFree(a) && caseFree(b) && a.toLowerCase() === b.toLowerCase()) ||
    (a.includes(" ") && factorsOf(a) === factorsOf(b))
  );
}

/** Multiplicative families: the factor to the family's base unit. */
const FAMILIES: Record<string, number>[] = [
  // Speed, base m s-1.
  {
    "m s-1": 1,
    "m/s": 1,
    "ms-1": 1,
    "m.s-1": 1,
    "meter per second": 1,
    "meters per second": 1,
    "metre per second": 1,
    "metres per second": 1,
    // UDUNITS words with exponents, as ROMS writes them (25 Nov: CIOFS
    // `u_eastward` in "meter second-1" was no speed, so no barbs).
    "meter second-1": 1,
    "meters second-1": 1,
    "metre second-1": 1,
    "metres second-1": 1,
    "m second-1": 1,
    "centimeter second-1": 0.01,
    "centimeters second-1": 0.01,
    "cm s-1": 0.01,
    "cm/s": 0.01,
    "km h-1": 1 / 3.6,
    "km/h": 1 / 3.6,
    "km s-1": 1000,
    "km/s": 1000,
    // A velocity in mm/s. The same spelling is a water-equivalent rate below:
    // the field's quantity decides which a display offers
    // (displayUnits.rateKind).
    "mm s-1": 0.001,
    "mm/s": 0.001,
    // A slow current per hour or day. The same spellings are rates of water
    // below: the quantity decides.
    "mm h-1": 0.001 / 3600,
    "mm/h": 0.001 / 3600,
    "mm day-1": 0.001 / 86400,
    "mm d-1": 0.001 / 86400,
    "mm/day": 0.001 / 86400,
    "cm day-1": 0.01 / 86400,
    "cm/day": 0.01 / 86400,
    "m day-1": 1 / 86400,
    "m d-1": 1 / 86400,
    "m/day": 1 / 86400,
    kph: 1 / 3.6,
    kt: 0.514444,
    kts: 0.514444,
    knot: 0.514444,
    knots: 0.514444,
    mph: 0.44704,
    "mi/h": 0.44704,
  },
  // Length, base m.
  {
    m: 1,
    metre: 1,
    meter: 1,
    metres: 1,
    meters: 1,
    cm: 0.01,
    mm: 0.001,
    km: 1000,
  },
  // Pressure, base Pa.
  {
    pa: 1,
    pascal: 1,
    pascals: 1,
    hpa: 100,
    mbar: 100,
    mb: 100,
    kpa: 1000,
    bar: 1e5,
    dbar: 1e4,
    atm: 101325,
  },
  // Mass flux (precipitation, evaporation), base kg m-2 s-1.
  {
    "kg m-2 s-1": 1,
    "kg/m2/s": 1,
    "mm s-1": 1,
    "mm/s": 1,
    "mm h-1": 1 / 3600,
    "mm/h": 1 / 3600,
    "mm day-1": 1 / 86400,
    "mm d-1": 1 / 86400,
    "mm/day": 1 / 86400,
  },
];

/** Temperatures: to kelvin and back. */
const TEMPERATURE: Record<
  string,
  { to: (x: number) => number; from: (k: number) => number }
> = {
  k: { to: (x) => x, from: (k) => k },
  kelvin: { to: (x) => x, from: (k) => k },
  degk: { to: (x) => x, from: (k) => k },
  degc: { to: (x) => x + 273.15, from: (k) => k - 273.15 },
  "deg c": { to: (x) => x + 273.15, from: (k) => k - 273.15 },
  celsius: { to: (x) => x + 273.15, from: (k) => k - 273.15 },
  degrees_celsius: { to: (x) => x + 273.15, from: (k) => k - 273.15 }, // eslint-disable-line camelcase
  "degrees celsius": { to: (x) => x + 273.15, from: (k) => k - 273.15 },
  // UDUNITS' own spellings.
  degree_celsius: { to: (x) => x + 273.15, from: (k) => k - 273.15 }, // eslint-disable-line camelcase
  "degree celsius": { to: (x) => x + 273.15, from: (k) => k - 273.15 },
  degree_c: { to: (x) => x + 273.15, from: (k) => k - 273.15 }, // eslint-disable-line camelcase
  degf: {
    to: (x) => ((x - 32) * 5) / 9 + 273.15,
    from: (k) => ((k - 273.15) * 9) / 5 + 32,
  },
  fahrenheit: {
    to: (x) => ((x - 32) * 5) / 9 + 273.15,
    from: (k) => ((k - 273.15) * 9) / 5 + 32,
  },
};

/** Whether two unit strings name the same unit (spelling aside). */
/**
 * Whether units are an area: a metric length squared (m², km², cm²…). Area
 * weights are relative, so any of them serves; seconds or none do not.
 */
export function isAreaUnit(units: unknown) {
  return /^\s*((k|h|da|d|c|m)?m(2|\^2|\*\*2| 2)|square[ _](kilo|hecto|deca|deci|centi|milli)?met(er|re)s?)\s*$/i.test(
    String(units ?? "")
  );
}

export function sameUnits(a: string | undefined, b: string | undefined) {
  return same(normal(a), normal(b)) || sameTemperatureUnit(a, b);
}

/**
 * Two spellings of one temperature unit (K and kelvin, degC and Celsius): the
 * same position on the same scale.
 */
function sameTemperatureUnit(a: string | undefined, b: string | undefined) {
  const [ta, tb] = [
    lookup(TEMPERATURE, normal(a)),
    lookup(TEMPERATURE, normal(b)),
  ];
  return Boolean(ta && tb && ta.to(0) === tb.to(0) && ta.to(1) === tb.to(1));
}

/** Whether CF `units_metadata` says the values are temperature differences. */
const difference = (metadata?: string) =>
  /temperature:\s*difference/i.test(metadata ?? "");

/** Whether CF `units_metadata` says the temperature scale is unknown. */
const unknown = (metadata?: string) =>
  /temperature:\s*unknown/i.test(metadata ?? "");

/**
 * A function taking values in `from` to `to`, or undefined when the units
 * are of different quantities or unknown (and not the same spelling).
 * Temperature differences (CF `units_metadata: "temperature: difference"`)
 * scale without the offset; a difference and a position on the scale do
 * not convert.
 */
export function converter(
  from: string | undefined,
  to: string | undefined,
  metadata: { from?: string; to?: string } = {}
): ((value: number) => number) | undefined {
  const [a, b] = [normal(from), normal(to)];
  const [ta, tb] = [lookup(TEMPERATURE, a), lookup(TEMPERATURE, b)];
  if (ta && tb && difference(metadata.from) !== difference(metadata.to)) {
    return undefined;
  }
  // A scale declared unknown: a position and a difference convert apart by
  // 273.15, so the stored units stay. Nor is it the same quantity as one
  // declared on the scale, in any units; two of unknown scale in one unit are.
  if (
    ta &&
    tb &&
    (unknown(metadata.from) !== unknown(metadata.to) ||
      (!same(a, b) && !sameTemperatureUnit(a, b) && unknown(metadata.from)))
  ) {
    return undefined;
  }
  if (same(a, b)) {
    return (value) => value;
  }
  if (ta && tb) {
    const [into, outOf] = [ta.to, tb.from];
    if (difference(metadata.from)) {
      // A degree's size only: 1 K = 1 °C = 1.8 °F.
      const scale = outOf(into(1)) - outOf(into(0));
      return (value) => value * scale;
    }
    return (value) => outOf(into(value));
  }
  for (const family of FAMILIES) {
    const [fa, fb] = [lookup(family, a), lookup(family, b)];
    if (fa !== undefined && fb !== undefined) {
      const factor = fa / fb;
      return (value) => value * factor;
    }
  }
  return undefined;
}

/** Values converted, or undefined when the units cannot be matched. */
export function convertValues(
  values: number[],
  from: string | undefined,
  to: string | undefined
) {
  const convert = converter(from, to);
  return convert ? values.map(convert) : undefined;
}
