/**
 * What a failed plot can do next: a plain title, why it failed, and the actions
 * that can help. A request that is too large fails the same way on every retry,
 * so it offers its first dates, fewer dates or wider bins instead; a source
 * that could not be reached is worth retrying.
 */

import type { TErrorDetail } from "@/lib/analysis/analysisErrors.ts";

export type TErrorAction =
  "first-dates" | "dates" | "bins" | "samples" | "settings" | "retry" | "copy";

export type TErrorHelp = {
  title: string;
  why: string;
  actions: TErrorAction[];
  /** The values asked for and the most a plot holds, when the size failed. */
  size?: { values: number; limit: number };
};

const number = (text: string) => Number(text.replace(/[,\s ]/g, ""));

/** The values a too-large request asked for, and the limit, from its message. */
export function sizeOf(message: string) {
  const product =
    /([\d,]+)\s+(?:bins|columns|samples|levels)\s*×\s*([\d,]+)\s+times is more than ([\d,]+) values/.exec(
      message
    );
  if (product) {
    return {
      values: number(product[1]) * number(product[2]),
      limit: number(product[3]),
    };
  }
  const total = /would hold ([\d,]+) values; plots keep at most ([\d,]+)/.exec(
    message
  );
  return total
    ? { values: number(total[1]), limit: number(total[2]) }
    : undefined;
}

/**
 * The help for a failure (`timeRange`: the plot spans dates): by what the
 * worker said it is (`detail`), else by its words, for a failure that
 * carries none.
 */
// eslint-disable-next-line max-lines-per-function
export function errorHelp(
  message: string,
  timeRange: boolean,
  detail?: TErrorDetail
): TErrorHelp {
  const typed =
    detail?.reason === "size" &&
    detail.values !== undefined &&
    detail.limit !== undefined
      ? { values: detail.values, limit: detail.limit }
      : undefined;
  const size = detail ? typed : sizeOf(message);
  if (size) {
    const times = Math.max(1, Math.ceil(size.values / size.limit));
    const unit =
      detail?.reason === "size"
        ? detail.unit
        : /\bbins?\b|bin width/.test(message)
          ? "bins"
          : /samples/.test(message)
            ? "samples"
            : undefined;
    return {
      title: "Too many values for one plot",
      why: `This request would hold ${size.values.toLocaleString("en-US")} values; a plot holds at most ${size.limit.toLocaleString("en-US")}, so it needs about ${times}× less. Retrying would fail the same way.`,
      actions: [
        ...(timeRange ? (["first-dates", "dates"] as const) : []),
        ...(unit === "bins" ? (["bins"] as const) : []),
        ...(unit === "samples" ? (["samples"] as const) : []),
        "settings" as const,
        "copy" as const,
      ],
      size,
    };
  }
  if (
    detail
      ? detail.reason === "unreachable"
      : /network|fetch|timed? ?out|HTTP|status \d{3}|Failed to load|CORS|offline|ECONN/i.test(
          message
        )
  ) {
    return {
      title: "The data could not be reached",
      why: "The store did not answer (a network problem, or the server is busy). What was read so far is kept; trying again often works.",
      actions: ["retry", "copy"],
    };
  }
  if (
    detail
      ? detail.reason === "memory"
      : /out of memory|allocation|Array buffer|RangeError/i.test(message)
  ) {
    return {
      title: "Not enough memory in this browser",
      why: "The browser could not hold this much data at once. Fewer dates (or a smaller area) need less.",
      actions: [
        ...(timeRange ? (["first-dates", "dates"] as const) : []),
        "settings" as const,
        "copy" as const,
      ],
    };
  }
  return {
    title: "This plot could not be made",
    why: "Try again, or change the selection or dates in Settings. Copy the details to report it.",
    actions: ["retry", "settings", "copy"],
  };
}
