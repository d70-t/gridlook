/**
 * Find a chart: every chart Gridlook draws, findable by its name or the
 * names scientists use for it, and the charts suggested for the data shown
 * (from its metadata alone: nothing is read to suggest). An entry picks a
 * place on the dial and a plot; a chart that is a switch inside a plot
 * (barbs, members, anomaly…) is turned on as the plot opens.
 */
import { figuresOf, SECTOR_LIST, SECTORS, type TSector } from "./orbitDial.ts";

import { ANALYSIS_KINDS, type TAnalysisKind } from "@/lib/analysis/types.ts";
import type { TTurnOn } from "@/store/analysisStore.ts";

export type { TTurnOn };

export type TFinderEntry = {
  title: string;
  sector: TSector;
  kind: TAnalysisKind;
  /** Where it lives, e.g. "Point — Time series". */
  where: string;
  /** The switch inside the plot this chart is, turned on as it opens. */
  turnOn?: TTurnOn;
  /** Other names it goes by (searched, not shown). */
  words?: string;
  /**
   * A view of Compare: choosing it opens Compare (which asks for places
   * when it needs them) and then shows this view.
   */
  compare?: TCompareView;
};

/** Compare's views: the Taylor diagram (with the portrait) and the others. */
export type TCompareView = "taylor" | "bias" | "scatter" | "qq" | "parallel";

const sectorLabel = (sector: TSector) =>
  SECTOR_LIST.find((s) => s.id === sector)?.label ?? sector;

function figureTitle(sector: TSector, kind: TAnalysisKind) {
  return figuresOf(sector).find((f) => f.kind === kind)?.title ?? kind;
}

function entry(
  title: string,
  sector: TSector,
  kind: TAnalysisKind,
  extra: { turnOn?: TTurnOn; words?: string; compare?: TCompareView } = {}
): TFinderEntry {
  return {
    title,
    sector,
    kind,
    where: extra.compare
      ? "Compare plots: two or more places or areas"
      : `${sectorLabel(sector)} — ${figureTitle(sector, kind)}`,
    ...extra,
  };
}

/** Other names of the plots on the dial, by kind. */
const SYNONYMS: Partial<Record<TAnalysisKind, string>> = {
  [ANALYSIS_KINDS.POINT_SERIES]:
    "line chart meteogram timeseries station site location gridpoint grid point single point evolution over time temporal record history pixel nearest cell",
  [ANALYSIS_KINDS.REGION_SERIES]:
    "area average regional mean field mean spatial mean area weighted basin catchment domain index global mean country average nino index box average regional climate",
  [ANALYSIS_KINDS.PROFILE]:
    "sounding vertical column radiosonde ctd cast skewt lapse rate stratification inversion boundary layer mixed layer halocline level profile",
  [ANALYSIS_KINDS.TIME_DEPTH]:
    "time height time pressure time depth vertical evolution column over time time altitude qbo descending mixed layer seasonal stratification",
  [ANALYSIS_KINDS.SECTION]:
    "curtain transect vertical section cross section xsection ship track flight track along track route slice vertical slice",
  [ANALYSIS_KINDS.HOVMOLLER_PATH]:
    "hovmoller distance time along track propagation route time",
  [ANALYSIS_KINDS.HOVMOLLER_LON]:
    "hovmoller longitude time propagation mjo kelvin wave rossby wave eastward westward phase speed time longitude diagram",
  [ANALYSIS_KINDS.HOVMOLLER_LAT]:
    "hovmoller latitude time itcz migration monsoon onset seasonal march poleward time latitude diagram",
  [ANALYSIS_KINDS.LAT_VERTICAL]:
    "zonal mean latitude height cross section latitude pressure jet stream hadley cell tropopause meridional circulation zonal average",
  [ANALYSIS_KINDS.LON_VERTICAL]:
    "meridional mean longitude depth pressure thermocline walker section walker circulation equatorial section",
  [ANALYSIS_KINDS.DISTRIBUTION]:
    "histogram pdf density percentile quantile spread 95 range median frequency distribution statistics variability kde probability",
};

/** The plots on the dial: one entry per place and plot. */
function dialEntries(): TFinderEntry[] {
  return SECTOR_LIST.flatMap(({ id }) =>
    figuresOf(id).map((f) =>
      entry(f.title, id, f.kind, { words: SYNONYMS[f.kind] })
    )
  );
}

const { POINT_SERIES, REGION_SERIES, PROFILE, DISTRIBUTION } = ANALYSIS_KINDS;

/** Charts that are a switch inside a plot, or a view of several plots. */
const SWITCHES: TFinderEntry[] = [
  entry("Wind barbs", SECTORS.POINT, POINT_SERIES, {
    turnOn: { wind: true },
    words: "wind vector arrows u v knots",
  }),
  entry("Wind or current rose", SECTORS.POINT, POINT_SERIES, {
    turnOn: { wind: true, figure: "rose" },
    words: "wind rose direction frequency",
  }),
  entry("Hodograph", SECTORS.POINT, PROFILE, {
    turnOn: { wind: true, figure: "hodograph" },
    words: "wind shear profile",
  }),
  entry("Ensemble plume", SECTORS.POINT, POINT_SERIES, {
    turnOn: { members: "plume" },
    words: "members spaghetti realizations",
  }),
  entry("Ensemble fan (10–90 %)", SECTORS.POINT, POINT_SERIES, {
    turnOn: { members: "fan" },
    words: "members percentiles uncertainty",
  }),
  entry("Chance above a value", SECTORS.POINT, POINT_SERIES, {
    turnOn: { members: "chance" },
    words: "exceedance probability threshold members",
  }),
  entry("Anomaly", SECTORS.POINT, POINT_SERIES, {
    turnOn: { timeView: "anomaly" },
    words:
      "departure deviation climatology anomalies baseline standardized difference from normal",
  }),
  entry("Annual cycle", SECTORS.POINT, POINT_SERIES, {
    turnOn: { timeView: "annual" },
    words:
      "seasonal cycle climatology monthly mean monthly climatology seasonality",
  }),
  entry("Diurnal cycle", SECTORS.POINT, POINT_SERIES, {
    turnOn: { timeView: "diurnal" },
    words: "daily cycle hourly day night sub daily",
  }),
  entry("Trend", SECTORS.POINT, POINT_SERIES, {
    turnOn: { trend: true },
    words:
      "linear regression slope per decade per year warming rate change rate",
  }),
  entry("Spread over an area", SECTORS.BOX, REGION_SERIES, {
    turnOn: { spread: "std" },
    words: "standard deviation min max band",
  }),
  entry("Middle 95 % of an area", SECTORS.BOX, DISTRIBUTION, {
    words: "percentile 5 95 range tails",
  }),
  entry("Running mean", SECTORS.POINT, POINT_SERIES, {
    turnOn: { timeView: "running" },
    words: "moving average smoothing filter rolling mean low pass",
  }),
  entry("Cumulative total", SECTORS.POINT, POINT_SERIES, {
    turnOn: { timeView: "cumulative" },
    words:
      "accumulation running sum precipitation total accumulated rainfall cumulative sum",
  }),
  entry("Days above a value", SECTORS.POINT, POINT_SERIES, {
    turnOn: { timeView: "count" },
    words:
      "exceedance count threshold hot days frost per year heatwave tropical nights ice days extreme days indices",
  }),
  entry("Boxes by month", SECTORS.POINT, POINT_SERIES, {
    turnOn: { timeView: "boxes" },
    words: "box plot boxplot whisker seasonal monthly distribution",
  }),
  entry("Spectrum", SECTORS.POINT, POINT_SERIES, {
    turnOn: { timeView: "spectrum" },
    words:
      "periodogram power spectral density fft frequency cycle periodicity fourier",
  }),
  entry("Return levels", SECTORS.POINT, POINT_SERIES, {
    turnOn: { timeView: "return" },
    words:
      "extreme value gumbel return period 100-year 50-year annual maximum extremes",
  }),
  entry("Cumulative distribution (CDF)", SECTORS.BOX, DISTRIBUTION, {
    turnOn: { curve: "cdf" },
    words: "cdf ecdf cumulative share below",
  }),
  entry("Share of the area above a value", SECTORS.BOX, DISTRIBUTION, {
    turnOn: { shareAbove: "mean" },
    words: "exceedance fraction threshold area",
  }),
  entry("Scatter against another variable", SECTORS.POINT, POINT_SERIES, {
    turnOn: { pair: "any" },
    words:
      "scatter relationship correlation two variables joint against versus",
  }),
  entry("Temperature–salinity diagram", SECTORS.POINT, PROFILE, {
    turnOn: { pair: "salinity" },
    words: "ts t-s water mass ocean salinity",
  }),
  entry("Bias over time", SECTORS.POINT, POINT_SERIES, {
    compare: "bias",
    words:
      "difference error model minus observations compare bias validation evaluation",
  }),
  entry("Observed vs simulated scatter", SECTORS.POINT, POINT_SERIES, {
    compare: "scatter",
    words: "scatter model evaluation compare one to one",
  }),
  entry("Q–Q plot", SECTORS.POINT, POINT_SERIES, {
    compare: "qq",
    words: "qq quantile distribution compare",
  }),
  entry("Parallel coordinates", SECTORS.POINT, POINT_SERIES, {
    compare: "parallel",
    words: "scores metrics compare models",
  }),
  entry("Taylor diagram", SECTORS.POINT, POINT_SERIES, {
    compare: "taylor",
    words:
      "model evaluation correlation rmse compare skill validation standard deviation",
  }),
  entry("Gleckler portrait", SECTORS.POINT, POINT_SERIES, {
    compare: "taylor",
    words: "portrait diagram error seasons compare",
  }),
];

/** Searches to offer when one finds nothing. */
export const SEARCH_EXAMPLES = [
  "time series",
  "cross-section",
  "Hovmöller",
  "anomaly",
  "histogram",
  "trend",
];

/** Lower case, accents dropped (Hovmöller → hovmoller), dashes as spaces. */
function plain(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ö/g, "o")
    .replace(/[–×|/-]/g, " ");
}

/** Words that say nothing about which chart: "show me a plot of …". */
const STOPWORDS = new Set(
  "a an the of for in on at to by with and or me my show plot plots chart charts graph diagram figure view make draw see want please how".split(
    " "
  )
);

/** Spellings and short forms scientists type, as the words searched. */
const ALIASES: Record<string, string> = {
  hovmoeller: "hovmoller",
  hovmuller: "hovmoller",
  xsection: "cross section",
  xsec: "cross section",
  crosssection: "cross section",
  ts: "time series",
  timeseries: "time series",
  tseries: "time series",
  sst: "temperature time series",
  precip: "precipitation",
  rain: "precipitation",
  rainfall: "precipitation",
  pr: "precipitation",
  tas: "temperature",
  temp: "temperature",
  climatology: "climatology",
  clim: "climatology",
  seasonality: "seasonal",
  enso: "nino index",
  nino: "nino index",
  pdf: "pdf",
  kde: "density",
  cdf: "cdf",
  stdev: "standard deviation",
  std: "standard deviation",
  sd: "standard deviation",
  sigma: "standard deviation",
  rmse: "rmse",
  corr: "correlation",
  regression: "trend",
  detrend: "trend",
  avg: "average",
  mean: "mean",
  vs: "against",
  versus: "against",
  extremes: "extreme",
  heatwave: "hot days exceedance",
  frost: "frost days",
  drought: "cumulative precipitation",
};

/** Words of a query: stopwords dropped, aliases expanded, plurals cut. */
function queryWords(query: string) {
  const words = plain(query).split(/\s+/);
  // The word still being typed stays, stop word or not ("an" of "anomaly").
  const typing = /\S$/.test(query) ? words.length - 1 : -1;
  return words
    .filter((w, at) => w && (at === typing || !STOPWORDS.has(w)))
    .map((w) => ALIASES[w] ?? w)
    .flatMap((w) => w.split(" "));
}

/** Damerau–Levenshtein distance, stopping once it exceeds `most`. */
function editDistance(a: string, b: string, most: number) {
  if (Math.abs(a.length - b.length) > most) {
    return most + 1;
  }
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (__, j) => (i ? (j ? 0 : i) : j))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** A text's words, and each two run together ("crosssection"). */
function textWords(text: string) {
  const words = plain(text).split(/\s+/).filter(Boolean);
  return [...words, ...words.slice(1).map((w, k) => words[k] + w)];
}

/**
 * How well one query word matches a text's words: 1 for the word itself
 * (or its singular), 0.8 for the start of a word, 0.6 for a near miss (a
 * typo: one edit in five letters or more, two in eight), 0.4 inside a word.
 */
function wordMatch(word: string, words: string[]) {
  const singular = word.length > 3 ? word.replace(/s$/, "") : word;
  let best = 0;
  for (const w of words) {
    if (w === word || w === singular || w.replace(/s$/, "") === singular) {
      return 1;
    }
    // A word's start from the first letter typed (search as you type).
    // A short start says less than a whole word elsewhere: "t" of "time"
    // ranks below an exact "t" (T–S); four letters on count fully.
    if (w.startsWith(word)) {
      best = Math.max(best, 0.5 + 0.3 * Math.min(1, word.length / 4));
    } else if (word.length >= 5) {
      const most = word.length >= 8 ? 2 : 1;
      if (editDistance(word, w.slice(0, word.length + most), most) <= most) {
        best = Math.max(best, 0.6);
      }
    }
    if (!best && word.length >= 3 && w.includes(word)) {
      best = 0.4;
    }
  }
  return best;
}

/**
 * Charts whose name, place or other names match every word of the query
 * (in any order, with typos, short forms and plurals forgiven), the best
 * first: words in the name count most, then the other names, then the
 * place; names that start with the query lead. A plot offered in several
 * places (an area mean: box, polygon, country) is listed in each.
 */
export function findCharts(query: string, limit = 8): TFinderEntry[] {
  const words = queryWords(query);
  if (!words.length) {
    return [];
  }
  const all = [...dialEntries(), ...SWITCHES];
  const first = plain(query).trim();
  return all
    .map((e, at) => {
      const fields = [
        { weight: 3, words: textWords(e.title) },
        { weight: 2, words: textWords(e.words ?? "") },
        { weight: 1, words: textWords(e.where) },
      ];
      let score = 0;
      for (const word of words) {
        const best = Math.max(
          ...fields.map((f) => f.weight * wordMatch(word, f.words))
        );
        if (!best) {
          return undefined; // every word must match somewhere
        }
        score += best;
      }
      return { e, at, score, starts: plain(e.title).startsWith(first) };
    })
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .sort(
      (a, b) =>
        Number(b.starts) - Number(a.starts) || b.score - a.score || a.at - b.at
    )
    .map(({ e }) => e)
    .slice(0, limit);
}

const byTitle = (title: string) =>
  [...SWITCHES, ...dialEntries()].find((e) => e.title === title)!;

/**
 * Up to three charts suited to the data, from metadata alone: a wind
 * pair suggests barbs and a rose, members a plume, levels a profile,
 * ocean temperature with salinity a T–S diagram, precipitation (skewed,
 * bounded at 0) its total and its distribution.
 */
export function suggestCharts(data: {
  wind?: boolean;
  ensemble?: boolean;
  vertical?: boolean;
  standardName?: string;
  /** Ocean temperature with a salinity in the dataset. */
  temperatureSalinity?: boolean;
  /** Why each plot is unavailable ("" when offered). */
  reasons: Record<TAnalysisKind, string>;
  /**
   * The variable has a time axis: the rest of the three places go to what
   * scientists most often look at over time (a temperature's trend first).
   */
  timed?: boolean;
}): TFinderEntry[] {
  const list: TFinderEntry[] = [];
  if (data.ensemble) {
    list.push(byTitle("Ensemble plume"));
  }
  if (data.wind) {
    list.push(byTitle("Wind barbs"), byTitle("Wind or current rose"));
  }
  if (data.vertical) {
    list.push(byTitle("Vertical profile"));
    if (data.wind) {
      list.push(byTitle("Hodograph"));
    }
  }
  if (data.temperatureSalinity && data.vertical) {
    list.push(byTitle("Temperature–salinity diagram"));
  }
  if (/precipitation|rainfall/.test(data.standardName ?? "")) {
    list.push(byTitle("Cumulative total"), byTitle("Middle 95 % of an area"));
  }
  if (data.timed) {
    const temperature = /temperature/.test(data.standardName ?? "");
    const common = temperature
      ? ["Trend", "Anomaly", "Annual cycle"]
      : ["Anomaly", "Annual cycle", "Trend"];
    for (const title of common) {
      if (!list.some((e) => e.title === title)) {
        list.push(byTitle(title));
      }
    }
  }
  return list.filter((e) => !data.reasons[e.kind]).slice(0, 3);
}
