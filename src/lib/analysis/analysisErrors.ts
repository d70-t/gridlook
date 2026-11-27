/** A query the data cannot answer: shown to the user as its message. */
export class AnalysisInputError extends Error {}

/**
 * What a failure is, beside its words: decided where it happens, so the
 * window's help and the first-dates preview need not read it back out of
 * the message (fewer dates help a size refusal, Retry an unreachable
 * store).
 */
export type TErrorDetail =
  | {
      reason: "size";
      /** The values the full request would hold, when known. */
      values?: number;
      /** The most a plot holds, when the values are what is too many. */
      limit?: number;
      /** What the stored chunks decode to, when they are what is too much. */
      decodedBytes?: number;
      /** What a smaller request would use fewer of. */
      unit?: "bins" | "samples" | "columns";
    }
  | { reason: "unreachable" }
  | { reason: "memory" };

/** A request too large for one plot (values, stored chunks or memory). */
export class AnalysisSizeError extends AnalysisInputError {
  constructor(
    message: string,
    readonly detail: Extract<TErrorDetail, { reason: "size" }>
  ) {
    super(message);
  }
}

/** A result of more values than a plot holds, with what to use fewer of. */
export function tooManyValues(
  message: string,
  values: number,
  limit: number,
  unit: "bins" | "samples" | "columns"
) {
  return new AnalysisSizeError(message, {
    reason: "size",
    values,
    limit,
    unit,
  });
}
