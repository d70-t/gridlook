uniform float projectionRadius;

varying vec3 vSpherePosition;

void main() {
  vSpherePosition = normalize(position);
  vec3 projected = position * projectionRadius;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(projected, 1.0);
}
