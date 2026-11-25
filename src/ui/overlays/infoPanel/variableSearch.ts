import uFuzzy from "@leeoniya/ufuzzy";

import type { TVariableTableRow } from "./types";

export const SearchField = {
  ALL: "all",
  NAME: "name",
  LONG_NAME: "long_name",
  STANDARD_NAME: "standard_name",
  UNITS: "units",
} as const;

export type TSearchField = (typeof SearchField)[keyof typeof SearchField];

export const searchFieldLabels: Record<TSearchField, string> = {
  [SearchField.ALL]: "All",
  [SearchField.NAME]: "Name",
  [SearchField.LONG_NAME]: "Long name",
  [SearchField.STANDARD_NAME]: "Standard name",
  [SearchField.UNITS]: "Units",
};

type TTextField = Exclude<TSearchField, typeof SearchField.ALL>;

const ALL_FIELDS: TTextField[] = [
  SearchField.NAME,
  SearchField.LONG_NAME,
  SearchField.STANDARD_NAME,
  SearchField.UNITS,
];

// Joins the fields of a variable when searching all of them: uFuzzy's
// terms never span it, the gaps between terms do (so "air temp hourly" can
// match the long name and the group path of the same variable).
const FIELD_SEPARATOR = "\u001f";

// Each term of the query has to appear as it is typed...
const exactSearch = new uFuzzy();
// ...and only when nothing does, a term may contain one typo. Tolerating
// typos right away would list "tos" and "ta" for "tas".
const typoSearch = new uFuzzy({
  intraMode: 1,
  intraIns: 1,
  intraSub: 1,
  intraTrn: 1,
  intraDel: 1,
});

type THighlightSegment = { text: string; match: boolean };

export type TVariableHighlight = {
  name: THighlightSegment[];
  // the first attribute with matched parts
  attribute: { label: string; segments: THighlightSegment[] } | null;
};

export type TVariableSearchResult = {
  rows: TVariableTableRow[];
  /** The matched parts of a row, the name from `nameStart` on. */
  highlight: (row: TVariableTableRow, nameStart: number) => TVariableHighlight;
};

function fieldText(row: TVariableTableRow, field: TTextField) {
  if (field === SearchField.NAME) {
    return row.name;
  }
  const value = row.attrs?.[field];
  return typeof value === "string" ? value : "";
}

function searchedFields(field: TSearchField) {
  return field === SearchField.ALL ? ALL_FIELDS : [field];
}

/** The strings to search, one per row; rebuild only when rows or field change. */
export function variableHaystack(
  rows: TVariableTableRow[],
  field: TSearchField
) {
  const fields = searchedFields(field);
  return rows.map((row) =>
    fields.map((f) => fieldText(row, f)).join(FIELD_SEPARATOR)
  );
}

/** Splits `text` into matched and unmatched parts; `ranges` start at `offset`. */
function highlightSegments(
  text: string,
  ranges: number[],
  offset = 0
): THighlightSegment[] {
  const segments: THighlightSegment[] = [];
  let position = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    const start = Math.max(ranges[i] - offset, position);
    const end = Math.min(ranges[i + 1] - offset, text.length);
    if (end <= start) {
      continue;
    }
    if (start > position) {
      segments.push({ text: text.slice(position, start), match: false });
    }
    segments.push({ text: text.slice(start, end), match: true });
    position = end;
  }
  if (position < text.length) {
    segments.push({ text: text.slice(position), match: false });
  }
  return segments;
}

export function searchVariables(
  rows: TVariableTableRow[],
  haystack: string[],
  query: string,
  field: TSearchField
): TVariableSearchResult {
  let search = exactSearch;
  let indices = exactSearch.filter(haystack, query) ?? [];
  if (indices.length === 0) {
    search = typoSearch;
    indices = typoSearch.filter(haystack, query) ?? [];
  }
  const indexByName = new Map(
    indices.map((index) => [rows[index].name, index])
  );

  // ponytail: highlight ranges are found per rendered row (uFuzzy's info()
  // for one index) instead of for all matches up front, which would take
  // long for tens of thousands of matches.
  function highlight(row: TVariableTableRow, nameStart: number) {
    const displayName = row.name.slice(nameStart);
    const index = indexByName.get(row.name);
    const result: TVariableHighlight = {
      name: [{ text: displayName, match: false }],
      attribute: null,
    };
    if (index === undefined) {
      return result;
    }
    const ranges = search.info([index], haystack, query).ranges[0] ?? [];
    let offset = 0;
    for (const f of searchedFields(field)) {
      const text = fieldText(row, f);
      if (f === SearchField.NAME) {
        result.name = highlightSegments(
          displayName,
          ranges,
          offset + nameStart
        );
      } else if (!result.attribute) {
        const segments = highlightSegments(text, ranges, offset);
        if (segments.some((segment) => segment.match)) {
          result.attribute = { label: searchFieldLabels[f], segments };
        }
      }
      offset += text.length + FIELD_SEPARATOR.length;
    }
    return result;
  }

  return { rows: indices.map((index) => rows[index]), highlight };
}
