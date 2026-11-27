/**
 * The read-status row under a figure, as plain facts. Three different
 * things are never mixed: request parts ("Part 6 of 36": the planned
 * reads), scientific dates ("60 of 432 dates": steps of the time axis
 * read) and bytes ("22 MiB fetched": what the store actually sent, apart
 * from what was decoded).
 */
import { timeLabelAt } from "@/lib/analysis/calendar.ts";
import { rowsUntil } from "@/lib/analysis/timeRows.ts";
import type { TAnalysisResult } from "@/lib/analysis/types.ts";

/** Bytes as KiB, MiB or GiB (binary), one decimal under ten. */
export function bytesText(bytes: number) {
  return bytes >= 2 ** 30
    ? `${(bytes / 2 ** 30).toFixed(1)} GiB`
    : bytes >= 2 ** 20
      ? `${(bytes / 2 ** 20).toFixed(bytes < 10 * 2 ** 20 ? 1 : 0)} MiB`
      : `${Math.max(1, Math.round(bytes / 2 ** 10))} KiB`;
}

const count = (n: number) => n.toLocaleString("en-US");

/** Dates read of those asked for, and the last date reached. */
export function datesRead(result: TAnalysisResult | undefined) {
  const time = result?.time;
  // Chunks of one date still arriving: counted as chunks, not dates.
  if (!time || result.partial?.chunks) {
    return undefined;
  }
  const total = time.raw.length;
  const read = result.partial
    ? Math.max(
        0,
        Math.min(total, rowsUntil(result.query.time, result.partial.readUntil))
      )
    : total;
  return {
    read,
    total,
    text: `${count(read)} of ${count(total)} dates`,
    through: read ? timeLabelAt(time, read - 1) : "",
  };
}

type TRange = { start: number; stop: number };

/**
 * Dates read toward everything asked for, when an Extend or Read all reads in
 * steps (earlier dates first, then the later ones): the plot's dates already
 * shown plus those this step has read, of the whole span asked for. Each step
 * reading against its own range made the count fall back (68 of 136, then 170
 * of 272) and the line restart.
 */
export function goalDates(
  ext:
    | { shown: TRange; target: TRange; then?: TRange; before: boolean }
    | undefined,
  result: TAnalysisResult | undefined
) {
  const step = datesRead(result);
  const range = result?.query.time;
  if (!ext || !step || !range) {
    return step;
  }
  const spans = [ext.shown, ext.target, ...(ext.then ? [ext.then] : [])];
  const start = Math.min(...spans.map((r) => r.start));
  const total = Math.max(...spans.map((r) => r.stop)) - start;
  const until = result.partial ? result.partial.readUntil : range.stop;
  // Earlier dates: this step's own rows; later ones: past those shown.
  const added = ext.before
    ? until - range.start
    : until - Math.max(range.start, ext.shown.stop);
  const read = Math.min(
    total,
    ext.shown.stop - ext.shown.start + Math.max(0, added)
  );
  return {
    ...step,
    read,
    total,
    text: `${count(read)} of ${count(total)} dates`,
  };
}

/** Stored chunks of one date read so far, with the share. */
export function chunksText(progress: { done: number; total: number }) {
  const share = Math.floor((100 * progress.done) / Math.max(1, progress.total));
  return `${count(progress.done)} of ${count(progress.total)} chunks (${share} %)`;
}

/** Request parts: the planned reads, not dates. */
export function partsText(
  progress: { done: number; total: number } | undefined,
  paused: boolean
) {
  if (!progress?.total) {
    return "";
  }
  if (paused) {
    return `Paused after part ${count(progress.done)} of ${count(progress.total)}`;
  }
  return progress.done < progress.total
    ? `Part ${count(progress.done + 1)} of ${count(progress.total)}`
    : `All ${count(progress.total)} parts read`;
}

/**
 * What the store sent (HTTP bytes when the worker saw them, else the stored
 * bytes of the chunks read), and what was decoded, labelled apart.
 */
export function bytesRead(
  counters: TAnalysisResult["counters"] | undefined,
  /** The source's transfers happen where they cannot be counted (NetCDF). */
  unmeasured = false
) {
  if (!counters?.chunkReads) {
    return { fetched: "", decoded: "" };
  }
  const sent = counters.physicalBytes || counters.fetchedBytes;
  return {
    // Not counted is not nothing.
    fetched: unmeasured
      ? "transfer not measured"
      : sent
        ? `${bytesText(sent)} fetched`
        : "",
    decoded: counters.decodedBytes
      ? `${bytesText(counters.decodedBytes)} decoded`
      : "",
  };
}

/** The stages before a figure: what is done, under way and still ahead. */
export type TStage = {
  name: string;
  /** What the stage does, said while it is under way. */
  detail: string;
  state: "done" | "now" | "next";
};

/**
 * A plot's stages from its status ("loading", "planning", "queued",
 * "running"): describing the variable, planning the reads, waiting for a
 * free slot (only when it waits) and reading. Unknown statuses: none.
 */
export function stagesOf(status: string): TStage[] {
  const order = ["loading", "planning", "queued", "running"];
  const at = order.indexOf(status);
  if (at < 0) {
    return [];
  }
  const all = [
    {
      key: "loading",
      name: "Describe the variable",
      detail: "Reading its metadata: dimensions, time axis, grid and units",
    },
    {
      key: "planning",
      name: "Plan the reads",
      detail: "Finding the cells and the stored chunks this plot needs",
    },
    {
      key: "queued",
      name: "Wait for a free slot",
      detail: "Other plots are reading; this one starts when one finishes",
    },
    {
      key: "running",
      name: "Read and compute",
      detail: "Fetching and decoding chunks; the figure appears with the first",
    },
  ];
  return all
    .filter((stage) => stage.key !== "queued" || status === "queued")
    .map(({ key, name, detail }) => ({
      name,
      detail,
      state: order.indexOf(key) < at ? "done" : key === status ? "now" : "next",
    }));
}
