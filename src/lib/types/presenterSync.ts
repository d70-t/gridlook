export const PresenterRole = {
  CONTROLLER: "controller",
  DISPLAY: "display",
} as const;

export type TPresenterRole = (typeof PresenterRole)[keyof typeof PresenterRole];

export const PRESENTER_CHANNEL = "gridlook-presenter";

export type TPresenterStatePayload = {
  // globe control store fields
  varnameSelector?: string;
  colormap?: string;
  invertColormap?: boolean;
  posterizeLevels?: number;
  userBoundsLow?: number;
  userBoundsHigh?: number;
  landSeaMaskChoice?: string;
  landSeaMaskUseTexture?: boolean;
  projectionMode?: string;
  projectionCenter?: { lat: number; lon: number };
  isRotating?: boolean;
  showCoastLines?: boolean;
  showGraticules?: boolean;
  dimSlidersValues?: (number | null)[];
  selection?: { low: number; high: number };
  // url-parameter store fields
  paramCameraState?: string;
  paramGridType?: string;
};

export type TPresenterMessage =
  | { type: "state-update"; payload: TPresenterStatePayload }
  | { type: "full-state"; payload: TPresenterStatePayload }
  | {
      type: "projection-center-update";
      projectionCenter: { lat: number; lon: number };
    }
  | {
      type: "dim-sliders-update";
      dimSlidersValues: (number | null)[];
    }
  | { type: "navigate"; hash: string };
