/**
 * Trims characters from the start and end of a string.
 * If no characters are specified, it trims whitespace.
 */
export default function trim(str: string, chars?: string): string {
  if (!chars) {
    return str.replace(/^\s+|\s+$/g, "");
  }
  const pattern = new RegExp(`^[${chars}]+|[${chars}]+$`, "g");
  return str.replace(pattern, "");
}
