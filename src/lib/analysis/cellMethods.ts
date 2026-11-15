/**
 * CF `cell_methods`: "name: [name: …] method [where …] [over …] [(…)]",
 * repeated. A name is a dimension, a scalar coordinate or a standard name
 * (`time`, `area`), so the method over time can be named by the time dimension
 * itself.
 */

/**
 * Each name with the method that last applies to it. CF applies methods in the
 * order listed, so the last one for a name says what the value is: "time:
 * maximum within days time: mean over days" is a mean of daily maxima, not a
 * maximum.
 */
export function parseCellMethods(text: string | undefined) {
  const methods = new Map<string, string>();
  // Comments in parentheses say how, not over what.
  const words = (text ?? "")
    .replace(/\([^)]*\)/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let names: string[] = [];
  let skip = false;
  for (const word of words) {
    if (word.endsWith(":")) {
      if (skip) {
        skip = false;
        names = [];
      }
      names.push(word.slice(0, -1));
    } else if (names.length) {
      for (const name of names) {
        methods.set(name, word.toLowerCase());
      }
      names = [];
      // "where …" / "over …" qualify the method just read.
      skip = true;
    }
  }
  return methods;
}

/**
 * The statistic over time: under `time`, or under the time dimension's
 * own name (`dimension`), whichever the variable declares.
 */
/** One reduction of CF cell_methods: its axes, method and qualifiers. */
export type TCellStep = {
  names: string[];
  method: string;
  qualifier: string;
  /** Its comment's first sampling interval ("1 hour"), when stated. */
  interval?: string;
  /**
   * Every stated interval, in order: one per name, by position (CF
   * §7.3.2), or one for all of them. Units as written (`mm` is no `Mm`).
   */
  intervals?: string[];
};

/** Units of sampling intervals, as factors to seconds, metres or degrees. */
const INTERVAL_UNITS: Record<string, [number, string]> = {
  s: [1, "s"],
  sec: [1, "s"],
  min: [60, "s"],
  h: [3600, "s"],
  hr: [3600, "s"],
  d: [86400, "s"],
  m: [1, "m"],
  km: [1000, "m"],
  cm: [0.01, "m"],
  mm: [0.001, "m"],
  Mm: [1e6, "m"],
};
/** Words, any case: their plural and spellings. */
const INTERVAL_WORDS: [RegExp, [number, string]][] = [
  [/^seconds?$/i, [1, "s"]],
  [/^minutes?$/i, [60, "s"]],
  [/^hours?$/i, [3600, "s"]],
  [/^days?$/i, [86400, "s"]],
  [/^(metres?|meters?)$/i, [1, "m"]],
  [/^(kilometres?|kilometers?)$/i, [1000, "m"]],
  [/^degrees?(_(north|east|n|e))?$/i, [1, "degree"]],
];

/**
 * An interval in one unit per kind ("3600 s", "1000 m", "1 degree"), so "1
 * hour" is "60 minutes"; else as written. Symbols keep their case: mm is a
 * millimetre, Mm a megametre.
 */
function intervalKey(text: string) {
  const match =
    /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(\S*)\s*$/.exec(text);
  if (!match) {
    return text.trim();
  }
  const unit = match[2];
  const known =
    INTERVAL_UNITS[unit] ??
    INTERVAL_WORDS.find(([pattern]) => pattern.test(unit))?.[1];
  if (!known) {
    return text.trim().replace(/\s+/g, " ");
  }
  const value = Number(match[1]) * known[0];
  return `${Number(value.toPrecision(12))} ${known[1]}`;
}

/**
 * Each of a step's names with its interval (by position, or the one for
 * all), as "name (interval)", sorted by name; `rename` maps a name (the
 * time dimension to `time`).
 */
export function namedIntervals(
  step: TCellStep,
  rename: (name: string) => string = (name) => name
) {
  const list = step.intervals ?? [];
  return step.names
    .map((name, at) => {
      const interval =
        list.length === step.names.length
          ? list[at]
          : list.length === 1
            ? list[0]
            : list.length
              ? list.join(", ")
              : undefined;
      return `${rename(name)}${interval ? ` (interval: ${intervalKey(interval)})` : ""}`;
    })
    .sort();
}

/**
 * CF cell_methods as their ordered steps, comments left out: each step's axes,
 * its method, and its "where", "over" or "within" qualifiers, in the order
 * applied.
 */
export function cellMethodSteps(text: string | undefined): TCellStep[] {
  // Comments as one token each: only their interval is kept (CF 7.3.2).
  const words = (text ?? "").match(/\([^)]*\)|[^\s()]+/g) ?? [];
  const steps: TCellStep[] = [];
  let names: string[] = [];
  let current: TCellStep | undefined;
  for (const word of words) {
    if (word.startsWith("(")) {
      // Every interval, as written: several name several axes in order. Not
      // from the comment's free text.
      const head = word.split(/comment:/i)[0];
      const intervals = [
        ...head.matchAll(/interval:\s*([^)]*?)\s*(?=interval:|\)|$)/gi),
      ].map((m) => m[1].replace(/\s+/g, " "));
      if (current && intervals.length) {
        current.interval = intervals[0];
        current.intervals = intervals;
      }
    } else if (word.endsWith(":")) {
      current = undefined;
      names.push(word.slice(0, -1));
    } else if (names.length) {
      current = { names, method: word.toLowerCase(), qualifier: "" };
      steps.push(current);
      names = [];
    } else if (current) {
      current.qualifier = `${current.qualifier} ${word}`.trim();
    }
  }
  return steps;
}

/**
 * Each axis's steps in order ("maximum within days", "mean over days"),
 * `time` standing for `timeDimension` too.
 */
export function stepsByAxis(text: string | undefined, timeDimension?: string) {
  const byAxis = new Map<string, string[]>();
  for (const step of cellMethodSteps(text)) {
    for (const name of step.names) {
      const axis = name === timeDimension ? "time" : name;
      const list = byAxis.get(axis) ?? [];
      list.push(
        step.qualifier ? `${step.method} ${step.qualifier}` : step.method
      );
      byAxis.set(axis, list);
    }
  }
  return byAxis;
}

/** Reductions that keep a sum of parts a sum: a mean of a state is one. */
const LINEAR_METHODS = new Set(["mean", "point", "sum"]);

/** Whether a step that is no linear reduction is applied (`on` its axes). */
export function nonlinearStep(
  text: string | undefined,
  on: (names: string[]) => boolean = () => true
) {
  return cellMethodSteps(text).some(
    (step) => on(step.names) && !LINEAR_METHODS.has(step.method)
  );
}

/**
 * Why two components' statistics make no vector: their whole ordered chains
 * differ (method, qualifiers such as "where land", the order), or a step is not
 * linear, so the vector of the statistics is not the statistic of the vector.
 */
export function vectorMethodProblem(
  a: { cellMethods?: string; timeDimension?: string },
  b: { cellMethods?: string; timeDimension?: string }
) {
  // The steps in the order applied, each with its sampling interval: an area
  // mean of time means is no time mean of area means where cells are missing,
  // and a mean of hourly samples is no mean of daily ones. Each interval stays
  // with its own axis, in comparable units.
  const chain = (x: typeof a) =>
    cellMethodSteps(x.cellMethods)
      .map((step) => {
        const names = namedIntervals(step, (n) =>
          n === x.timeDimension ? "time" : n
        ).join(": ");
        const words = [step.method, step.qualifier].filter(Boolean).join(" ");
        return `${names}: ${words}`;
      })
      .join(", then ");
  const [ca, cb] = [chain(a), chain(b)];
  if (ca !== cb) {
    return `their cell methods differ (${ca || "none"} and ${cb || "none"})`;
  }
  const step = cellMethodSteps(a.cellMethods).find(
    (s) => !LINEAR_METHODS.has(s.method)
  );
  return step
    ? `the ${step.method} of each component is taken apart (${ca}), which makes no vector`
    : undefined;
}

export function timeCellMethod(
  cellMethods: string | undefined,
  dimension?: string
) {
  const methods = parseCellMethods(cellMethods);
  return (
    methods.get("time") ??
    (dimension === undefined ? undefined : methods.get(dimension))
  );
}

/**
 * Whether a quantity is intensive (a temperature, a rate: a value at an instant
 * unless cell_methods says otherwise; CF §7.3's default) or extensive (an
 * amount or accumulation over its cell), from its standard name and units;
 * undefined when neither tells.
 */
export function quantityKind(
  units: string | undefined,
  standardName?: string
): "intensive" | "extensive" | undefined {
  const name = standardName?.trim() ?? "";
  const unit = units?.trim() ?? "";
  // The standard name decides when given: an amount is extensive, a depth,
  // height or thickness is not.
  if (name) {
    return /_amount$|^integral_|accumulat/.test(name)
      ? "extensive"
      : "intensive";
  }
  if (/^(kg|j|mol)\s*(m-2|m\^-2|\/m2|\/m\^2)$/i.test(unit)) {
    return "extensive";
  }
  // A length alone is a depth or an accumulated depth: unknown, the same
  // in m as in mm.
  if (/^(m|mm|cm|km|metres?|meters?|millimet(er|re)s?)$/i.test(unit)) {
    return undefined;
  }
  return unit ? "intensive" : undefined;
}
