varying vec2 vProjectedCoord;

void main() {
  vProjectedCoord = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
