import * as THREE from "three";

function* globeVertices(geometries: THREE.BufferGeometry[]) {
  // Reuse one vector: callers consume each vertex before advancing.
  const point = new THREE.Vector3();
  for (const geometry of geometries) {
    const coordinates = geometry.getAttribute("latLon");
    if (!coordinates) {
      continue;
    }
    for (let i = 0; i < coordinates.count; i++) {
      const lat = coordinates.getX(i);
      const lon = coordinates.getY(i);
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90
      ) {
        continue;
      }
      const latitude = THREE.MathUtils.degToRad(lat);
      const longitude = THREE.MathUtils.degToRad(lon);
      yield point.set(
        Math.cos(latitude) * Math.cos(longitude),
        Math.cos(latitude) * Math.sin(longitude),
        Math.sin(latitude)
      );
    }
  }
}

export function getRegionalCameraPosition(
  geometries: THREE.BufferGeometry[],
  camera: THREE.PerspectiveCamera
) {
  const bounds = new THREE.Box3();
  for (const point of globeVertices(geometries)) {
    bounds.expandByPoint(point);
  }
  const center = bounds.getCenter(new THREE.Vector3());
  if (bounds.isEmpty() || center.lengthSq() < 1e-12) {
    return null;
  }
  center.normalize();
  const right = new THREE.Vector3(-center.y, center.x, 0);
  if (right.lengthSq() < 1e-12) {
    right.set(1, 0, 0);
  }
  right.normalize();
  const up = new THREE.Vector3().crossVectors(center, right);
  const tanVertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const tanHorizontal = tanVertical * camera.aspect;
  let distance = 1;
  for (const point of globeVertices(geometries)) {
    const depth = point.dot(center);
    // A region spanning more than a hemisphere cannot be shown in full.
    if (depth <= 0) {
      return null;
    }
    distance = Math.max(
      distance,
      depth + (1.05 * Math.abs(point.dot(right))) / tanHorizontal,
      depth + (1.05 * Math.abs(point.dot(up))) / tanVertical,
      1.001 / depth // Keep the farthest vertices above the globe's horizon.
    );
  }
  const globeDistance =
    1.05 / Math.sin(Math.atan(Math.min(tanVertical, tanHorizontal)));
  return distance < globeDistance ? center.multiplyScalar(distance) : null;
}
