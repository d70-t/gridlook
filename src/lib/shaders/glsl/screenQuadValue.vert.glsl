attribute float data_value;

varying float v_value;

void main() {
  v_value = data_value;
  gl_Position = vec4(position, 1.0);
}
