/**
 * A palette kept by name, loaded on demand. Only the latest request is kept: a
 * palette that finishes loading after a newer choice is dropped.
 */
export function paletteLoader(
  read: (name: string) => Promise<Uint8ClampedArray | undefined>
) {
  let wanted = "";
  let kept: { name: string; data: Uint8ClampedArray } | undefined;
  return {
    async load(name: string) {
      // Wanted even when it is the one kept: a request still loading for
      // another is dropped.
      wanted = name;
      if (kept?.name === name) {
        return;
      }
      const data = await read(name);
      if (data && wanted === name) {
        kept = { name, data };
      }
    },
    get name() {
      return kept?.name ?? "";
    },
    get data() {
      return kept?.data;
    },
  };
}
