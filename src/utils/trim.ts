/**
 * Trims characters from the start and end of a string.
 * If no characters are specified, it trims whitespace.
 */
export default function trim(s: string, c: string = "\\s"): string {
  if (c === "]") {
    c = "\\]";
  }
  if (c === "^") {
    c = "\\^";
  }
  if (c === "\\") {
    c = "\\\\";
  }
  return s.replace(new RegExp("^[" + c + "]+|[" + c + "]+$", "g"), "");
}
