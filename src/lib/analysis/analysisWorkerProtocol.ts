import type { TErrorDetail } from "./analysisErrors.ts";
import type {
  TRunErrorKind,
  TRunSource,
  TVariableSummary,
} from "./analysisRunner.ts";
import type { TLatLon } from "./sphere.ts";
import type {
  TAnalysisQuery,
  TAnalysisResult,
  TCountryGeometry,
  TCountryResolution,
  TPartialUpdate,
  TPlanEstimate,
} from "./types.ts";

import type { TRequestSettings } from "@/lib/data/ZarrDataManager.ts";

export const AnalysisMessageType = {
  DESCRIBE: "describe",
  CANCEL_DESCRIBE: "cancel-describe",
  PLAN: "plan",
  EXECUTE: "execute",
  CANCEL: "cancel",
  PAUSE: "pause",
  RESUME: "resume",
  RELEASE: "release",
  /** A live source published more time steps: forget cached gaps. */
  PUBLISHED: "published",
  /** The country at a map click, looked up off the page. */
  COUNTRY_AT: "country-at",
  /** A country's sampled map outline, prepared off the page. */
  COUNTRY_OUTLINE: "country-outline",
  COUNTRY_BORDERS: "country-borders",
  RESULT: "result",
  PARTIAL: "partial",
  ERROR: "error",
  /** The worker's handler is installed: requests can be posted. */
  READY: "ready",
} as const;

export type TAnalysisWorkerRequest = {
  requestId: number;
  requestSettings: TRequestSettings;
} & (
  | {
      type: typeof AnalysisMessageType.DESCRIBE;
      source: TRunSource;
      variable: string;
      /** Names this description for a later cancel. */
      describeId?: string;
    }
  | { type: typeof AnalysisMessageType.CANCEL_DESCRIBE; describeId: string }
  | {
      type: typeof AnalysisMessageType.PLAN;
      runId: string;
      source: TRunSource;
      query: TAnalysisQuery;
      /** Locate cells was chosen: load cold geometry and estimate the field. */
      geometryConfirmed?: boolean;
    }
  | { type: typeof AnalysisMessageType.EXECUTE; runId: string }
  | { type: typeof AnalysisMessageType.CANCEL; runId: string }
  | { type: typeof AnalysisMessageType.PAUSE; runId: string }
  | { type: typeof AnalysisMessageType.RESUME; runId: string }
  | { type: typeof AnalysisMessageType.RELEASE; sourceKey: string }
  | {
      type: typeof AnalysisMessageType.PUBLISHED;
      sourceKey: string;
      /** Time steps published since the last notice (inclusive). */
      from: number;
      to: number;
    }
  | {
      type: typeof AnalysisMessageType.COUNTRY_AT;
      lat: number;
      lon: number;
      resolution: TCountryResolution;
    }
  | {
      type: typeof AnalysisMessageType.COUNTRY_OUTLINE;
      id: string;
      resolution: TCountryResolution;
    }
  | { type: typeof AnalysisMessageType.COUNTRY_BORDERS }
);

export type TAnalysisPayload =
  | TVariableSummary
  | TPlanEstimate
  | TAnalysisResult
  | TCountryGeometry
  | TLatLon[][]
  | null;

export type TAnalysisWorkerResponse =
  | { type: typeof AnalysisMessageType.READY }
  | {
      requestId: number;
      type: typeof AnalysisMessageType.PARTIAL;
      payload: TPartialUpdate;
    }
  | {
      requestId: number;
      type: typeof AnalysisMessageType.RESULT;
      payload: TAnalysisPayload;
      fetches: { count: number; bytes: number; unknown: number };
    }
  | {
      requestId: number;
      type: typeof AnalysisMessageType.ERROR;
      kind: TRunErrorKind;
      message: string;
      detail?: TErrorDetail;
    };
