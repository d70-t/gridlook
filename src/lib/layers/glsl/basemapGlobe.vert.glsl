// Full-screen quad: the fragment shader intersects each pixel's camera ray
// with the exact unit sphere instead of drawing a tessellated one.
varying vec3 vRayDirection;

void main() {
  // Affine in screen position, so linear interpolation keeps it exact;
  // only its direction is used.
  vec4 viewRay = inverse(projectionMatrix) * vec4(position.xy, 1.0, 1.0);
  vRayDirection = transpose(mat3(viewMatrix)) * viewRay.xyz;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
