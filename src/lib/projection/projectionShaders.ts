import { PROJECTION_TYPES, type TProjectionType } from "./projectionUtils.ts";

export const PROJECTION_TYPE_BY_MODE = {
  [PROJECTION_TYPES.NEARSIDE_PERSPECTIVE]: 0,
  [PROJECTION_TYPES.EQUIRECTANGULAR]: 1,
  [PROJECTION_TYPES.MERCATOR]: 2,
  [PROJECTION_TYPES.ROBINSON]: 3,
  [PROJECTION_TYPES.MOLLWEIDE]: 4,
  [PROJECTION_TYPES.CYLINDRICAL_EQUAL_AREA]: 5,
  [PROJECTION_TYPES.AZIMUTHAL_EQUIDISTANT]: 6,
  [PROJECTION_TYPES.AZIMUTHAL_HYBRID]: 7,
} as const;

export type TProjectionTypeId =
  (typeof PROJECTION_TYPE_BY_MODE)[TProjectionType];

/**
 * Get the projection type constant for a given projection mode string
 */
export function getProjectionTypeFromMode(mode: string): number {
  const typedMode = mode as TProjectionType;
  return (
    PROJECTION_TYPE_BY_MODE[typedMode] ??
    PROJECTION_TYPE_BY_MODE[PROJECTION_TYPES.NEARSIDE_PERSPECTIVE]
  );
}
