/**
 * The view tabs at a window's lower right: Chart first and Data last, with
 * the figures the data allow between them (a wind or current rose, a
 * hodograph, a scatter or T–S). A figure tab that appears is announced
 * once per plot and pulses once; Chart stays selected until it is chosen.
 */

/** The chart window's line icons (PlotIcon.vue draws them). */
export type TPlotIcon =
  | "chart"
  | "data"
  | "rose"
  | "hodograph"
  | "scatter"
  | "ts"
  | "method"
  | "settings"
  | "barbs"
  | "currents"
  | "trend"
  | "export";

export type TViewTab = {
  id: "chart" | "rose" | "hodograph" | "scatter" | "data";
  label: string;
  icon: TPlotIcon;
};

export function viewTabs(options: {
  figure?: "rose" | "hodograph";
  /** Ocean currents: a current rose, not a wind rose. */
  current?: boolean;
  scatter?: "Scatter" | "T–S";
}): TViewTab[] {
  return [
    { id: "chart", label: "Chart", icon: "chart" },
    ...(options.figure === "rose"
      ? [
          {
            id: "rose" as const,
            label: options.current ? "Current rose" : "Wind rose",
            icon: "rose" as const,
          },
        ]
      : options.figure === "hodograph"
        ? [
            {
              id: "hodograph" as const,
              label: "Hodograph",
              icon: "hodograph" as const,
            },
          ]
        : []),
    ...(options.scatter
      ? [
          {
            id: "scatter" as const,
            label: options.scatter,
            icon:
              options.scatter === "T–S"
                ? ("ts" as const)
                : ("scatter" as const),
          },
        ]
      : []),
    { id: "data", label: "Data", icon: "data" },
  ];
}

/** Figure tabs already introduced, per plot (survives minimize/restore). */
const introduced = new Set<string>();

/**
 * Whether this figure tab is new for this plot: true once, the first time
 * it is offered; the caller announces it and pulses it.
 */
export function introduceTab(plotId: string, tab: TViewTab["id"]) {
  if (tab === "chart" || tab === "data") {
    return false;
  }
  const key = `${plotId}|${tab}`;
  if (introduced.has(key)) {
    return false;
  }
  introduced.add(key);
  return true;
}
