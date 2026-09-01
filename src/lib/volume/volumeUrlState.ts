export type TVolumeUrlSelection = {
  variable: string;
  color: string;
  opacity: number;
};

type TEncodedVolumeState = {
  version: 1;
  selections: Array<[variable: string, color: string, opacity: number]>;
};

function base64UrlEncode(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  const binary = atob(padded);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0))
  );
}

export function encodeVolumeUrlState(selections: TVolumeUrlSelection[]) {
  if (selections.length === 0) {
    return "";
  }
  const state: TEncodedVolumeState = {
    version: 1,
    selections: selections
      .slice(0, 4)
      .map((selection) => [
        selection.variable,
        selection.color.replace(/^#/, "").toLowerCase(),
        Number(selection.opacity.toFixed(2)),
      ]),
  };
  return base64UrlEncode(JSON.stringify(state));
}

export function decodeVolumeUrlState(value?: string): TVolumeUrlSelection[] {
  if (!value) {
    return [];
  }
  try {
    const state = JSON.parse(
      base64UrlDecode(value)
    ) as Partial<TEncodedVolumeState>;
    if (state.version !== 1 || !Array.isArray(state.selections)) {
      return [];
    }
    return state.selections.slice(0, 4).flatMap((selection) => {
      if (
        !Array.isArray(selection) ||
        selection.length !== 3 ||
        typeof selection[0] !== "string" ||
        selection[0].length === 0 ||
        typeof selection[1] !== "string" ||
        !/^[0-9a-f]{6}$/i.test(selection[1]) ||
        typeof selection[2] !== "number" ||
        !Number.isFinite(selection[2])
      ) {
        return [];
      }
      return [
        {
          variable: selection[0],
          color: `#${selection[1].toLowerCase()}`,
          opacity: Math.max(0, Math.min(1, selection[2])),
        },
      ];
    });
  } catch {
    return [];
  }
}
