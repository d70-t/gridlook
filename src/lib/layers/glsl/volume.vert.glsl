out vec3 volumeWorldPosition;

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  volumeWorldPosition = worldPosition.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
