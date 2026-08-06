export const CAMERA_VERTICAL_FOV_DEGREES = 45;

export function getVisibleVerticalSpan(
  distance: number,
  fovDegrees = CAMERA_VERTICAL_FOV_DEGREES
) {
  const halfFovRadians = (fovDegrees * Math.PI) / 360;
  return 2 * distance * Math.tan(halfFovRadians);
}

export function getCameraDistanceForVerticalSpan(
  span: number,
  fovDegrees = CAMERA_VERTICAL_FOV_DEGREES
) {
  const halfFovRadians = (fovDegrees * Math.PI) / 360;
  return span / (2 * Math.tan(halfFovRadians));
}
