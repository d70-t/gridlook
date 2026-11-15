/**
 * The eastward and northward wind components of a dataset, found as the map's
 * streamlines find them. Components along a grid's own axes are not offered:
 * without rotating them, barbs would point the wrong way.
 */
import { converter } from "@/lib/analysis/unitConvert.ts";
import {
  detectVectorVariablePair,
  type TVectorVariablePair,
} from "@/lib/data/vectorField.ts";

const GRID_RELATIVE =
  /^(x_|y_|grid_)|_(x|y)_velocity$|^(x|y)_wind$|sea_water_(x|y)_velocity/;

export type TWindPair = TVectorVariablePair;

/** An eastward name's northward partner by its usual spellings. */
const PARTNER_SPELLINGS: [RegExp, string][] = [
  // Both the letter and the direction (ROMS: u_eastward/v_northward).
  [/^u(.*)eastward/, "v$1northward"],
  [/^U(.*)[Ee]astward/, "V$1Northward"],
  [/^u/, "v"],
  [/^U/, "V"],
  [/_u$/, "_v"],
  [/_U$/, "_V"],
  [/eastward/, "northward"],
  [/Eastward/, "Northward"],
  [/east/, "north"],
];

/**
 * Pairs by name beyond the conventional ones (u100/v100, U10M/V10M,
 * uwnd/vwnd, wind_u/wind_v, eastward_wind_10m/northward_wind_10m,
 * u_eastward/v_northward), in the
 * same group, unless standard names say they are something else.
 */
function spelledPairs(
  variables: Record<string, { standardName?: string }>
): TWindPair[] {
  const names = new Set(Object.keys(variables));
  const pairs: TWindPair[] = [];
  for (const u of names) {
    const cut = u.lastIndexOf("/") + 1;
    const [group, base] = [u.slice(0, cut), u.slice(cut)];
    for (const [pattern, replacement] of PARTNER_SPELLINGS) {
      const v = group + base.replace(pattern, replacement);
      if (v === u || !names.has(v)) {
        continue;
      }
      const [su, sv] = [variables[u]?.standardName, variables[v]?.standardName];
      if (
        (su && !/eastward|^x_|_x_/.test(su)) ||
        (sv && !/northward|^y_|_y_/.test(sv))
      ) {
        continue;
      }
      pairs.push({ u, v, kind: "custom" });
      break;
    }
  }
  return pairs;
}

/**
 * The eastward/northward pairs to draw barbs with, most likely first: the
 * plotted variable's own pair, then the conventional names in its group
 * (as the map's streamlines find them), then other spellings. Any plot of
 * the dataset can carry them (a meteogram's temperature with its wind);
 * the caller keeps the first whose level matches the plot's. Pairs along
 * a grid's own axes are left out, with the reason.
 */
export function windPairs(
  variables: Record<string, { standardName?: string; units?: string }>,
  plotted: string
): { pairs: TWindPair[]; reason?: string } {
  let names = Object.keys(variables);
  const found: TWindPair[] = [];
  for (let pair = detectVectorVariablePair(names, plotted); pair;) {
    const known = pair;
    found.push(known);
    names = names.filter((name) => name !== known.u && name !== known.v);
    pair = detectVectorVariablePair(names, plotted);
  }
  for (const pair of spelledPairs(variables)) {
    if (!found.some((f) => f.u === pair.u || f.v === pair.v)) {
      found.push(pair);
    }
  }
  // The plotted variable's own pair first (plotting u100 takes u100/v100),
  // then those of its own group (25 Nov: a `multiscale/2` plot took the
  // `multiscale/0` currents, another grid).
  const group = plotted.slice(0, plotted.lastIndexOf("/") + 1);
  const own = (p: TWindPair) =>
    Number([p.u, p.v].includes(plotted)) * 2 +
    Number(p.u.slice(0, p.u.lastIndexOf("/") + 1) === group);
  found.sort((a, b) => own(b) - own(a));
  const pairs: TWindPair[] = [];
  let reason: string | undefined;
  for (const named of found) {
    const pair = oriented(variables, named);
    const refused =
      gridRelative(variables, pair) ??
      contradicted(variables, pair) ??
      notASpeed(variables, pair);
    if (refused) {
      reason ??= refused;
    } else {
      pairs.push(pair);
    }
  }
  return { pairs, reason: pairs.length ? undefined : reason };
}

const EASTWARD = /eastward|^x_|_x_/;
const NORTHWARD = /northward|^y_|_y_/;

/**
 * A pair found by its names, eastward first: only when both standard names say
 * plainly that the names are swapped (`u` northward, `v` eastward) is it turned
 * round. Anything else is kept as found, as before: standard names spelled
 * otherwise refused every pair of a dataset (25 Nov).
 */
function oriented(
  variables: Record<string, { standardName?: string }>,
  pair: TWindPair
): TWindPair {
  const [su, sv] = [
    variables[pair.u]?.standardName ?? "",
    variables[pair.v]?.standardName ?? "",
  ];
  const swapped =
    NORTHWARD.test(su) &&
    !EASTWARD.test(su) &&
    EASTWARD.test(sv) &&
    !NORTHWARD.test(sv);
  return swapped ? { ...pair, u: pair.v, v: pair.u } : pair;
}

/** A standard name's direction, when it states one plainly. */
/** Standard names of what is no horizontal component (a speed, upward…). */
const NOT_COMPONENT =
  /speed|upward|downward|vertical|magnitude|direction|divergence|vorticity|omega/i;

function directionOf(standardName: string | undefined) {
  const east = /eastward/.test(standardName ?? "");
  const north = /northward/.test(standardName ?? "");
  return east === north ? undefined : east ? "east" : "north";
}

/**
 * Why two components whose standard names both state a direction are no vector:
 * the same direction twice, or two quantities. Components without a stated
 * direction are kept, as found by their names.
 */
export function contradicted(
  variables: Record<string, { standardName?: string }>,
  pair: TWindPair
) {
  const [su, sv] = [
    variables[pair.u]?.standardName,
    variables[pair.v]?.standardName,
  ];
  const [du, dv] = [directionOf(su), directionOf(sv)];
  // A standard name that says what else it is (a speed, a vertical velocity) is
  // no horizontal component.
  for (const [name, standard, direction] of [
    [pair.u, su, du],
    [pair.v, sv, dv],
  ] as const) {
    // A modifier makes it another quantity: the standard error of a wind is no
    // wind.
    const modifier =
      /^\S+\s+(standard_error|detection_minimum|number_of_observations|status_flag)$/.exec(
        standard ?? ""
      )?.[1];
    if (modifier) {
      return `${name} is the ${modifier.replace(/_/g, " ")} of ${standard!.split(/\s/)[0].replace(/_/g, " ")} (its standard name says so), not a component to draw.`;
    }
    if (standard && !direction && NOT_COMPONENT.test(standard)) {
      return `${name} is ${standard.replace(/_/g, " ")} (its standard name says so), not an eastward or northward component.`;
    }
  }
  if (!du || !dv) {
    return undefined;
  }
  if (du === dv) {
    return `${pair.u} and ${pair.v} are both ${du}ward components (their standard names say so): there is no ${du === "east" ? "northward" : "eastward"} component to draw barbs with.`;
  }
  const quantity = (name: string) => name.replace(/(east|north)ward_/, "");
  return quantity(su!) === quantity(sv!)
    ? undefined
    : `${pair.u} (${su}) and ${pair.v} (${sv}) are components of different quantities.`;
}

/**
 * Metres per second per unit of a velocity component, or undefined when its
 * declared units are no speed. Velocity components in millimetres per second
 * are speeds. Undeclared units are taken as m s-1.
 */
export function speedFactor(units: string | undefined) {
  const declared = units?.trim();
  if (!declared) {
    return 1;
  }
  if (/^mm\s*(s-1|s\^-1|\/s|s\*\*-1)$/i.test(declared)) {
    return 0.001;
  }
  return converter(declared, "m s-1")?.(1);
}

/**
 * Why a pair cannot carry barbs: declared units that are no speed, one check
 * for found and chosen pairs alike.
 */
export function notASpeed(
  variables: Record<string, { units?: string }>,
  pair: { u: string; v: string }
) {
  const odd = [pair.u, pair.v].find(
    (name) => speedFactor(variables[name]?.units) === undefined
  );
  return odd
    ? `${odd} is in ${variables[odd]?.units}, not a speed; barbs and roses need velocities.`
    : undefined;
}

/** Why a pair cannot carry barbs: components along the grid's own axes. */
export function gridRelative(
  variables: Record<string, { standardName?: string }>,
  pair: { u: string; v: string }
) {
  const standard = [pair.u, pair.v].map(
    (name) => variables[name]?.standardName
  );
  return standard.some((name) => name && GRID_RELATIVE.test(name))
    ? `${pair.u} and ${pair.v} are along the grid's own axes, not east and north; barbs would point the wrong way.`
    : undefined;
}

/**
 * A best guess at a dataset's eastward and northward components when no
 * pair is recognized (25 Nov): names with an east or north word, or a
 * leading or trailing u and v, in the plotted variable's group first, in
 * speed units. A guess only fills the picker: it is used once chosen.
 */
export function guessComponents(
  variables: Record<string, { units?: string; support?: boolean }>,
  plotted: string
): { u: string; v: string } | undefined {
  const group = plotted.slice(0, plotted.lastIndexOf("/") + 1);
  const base = (name: string) => name.slice(name.lastIndexOf("/") + 1);
  const names = Object.keys(variables)
    .filter(
      (name) =>
        !variables[name]?.support &&
        speedFactor(variables[name]?.units) !== undefined
    )
    .sort(
      (a, b) =>
        Number(b.startsWith(group)) - Number(a.startsWith(group)) ||
        a.localeCompare(b)
    );
  const east = names.find((n) => /east|^u|_u$/i.test(base(n)));
  const north = names.find(
    (n) =>
      n !== east &&
      /north|^v|_v$/i.test(base(n)) &&
      (!east || n.startsWith(east.slice(0, east.lastIndexOf("/") + 1)))
  );
  return east && north ? { u: east, v: north } : undefined;
}
