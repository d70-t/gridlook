/**
 * With units metadata already saying on_scale, the standard name was not
 * frozen, and the comparison was refused as another quantity.
 */
import { createPinia, setActivePinia } from "pinia";
import { expect, it } from "vitest";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import { ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import { standardNameOf, useAnalysisStore } from "@/store/analysisStore.ts";
import ComparePanel from "@/ui/analysis/ComparePanel.vue";

const source = { store: "a", key: "a", dataset: "", format: 3 as const };
const ref = { ref: "a", versionStatus: "session" };

function plot(
  id: number,
  variable: string,
  units: string,
  values: number[],
  extra: Record<string, unknown>
) {
  return {
    id,
    label: `P${id}`,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    source: { key: "a|field" },
    snapshot: false,
    result: {
      kind: ANALYSIS_KINDS.POINT_SERIES,
      query: { variable },
      longName: variable,
      units,
      values,
      dims: ["time"],
      shape: [3],
      time: {
        dimension: "time",
        raw: [1, 3, 5],
        units: "days since 2001-01-01",
        calendar: "standard",
        quantity: "intensive",
        bounds: [0, 2, 2, 4, 4, 6],
      },
      ...extra,
    },
  };
}

async function rows(pinia: ReturnType<typeof createPinia>) {
  const html = await renderToString(
    createSSRApp(ComparePanel, { areaSize: { width: 900, height: 630 } }).use(
      pinia
    )
  );
  return (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []).map((row) =>
    row
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

it.each([undefined, "temperature: on_scale"])(
  "a frozen comparison survives another dataset's names (units metadata %s)",
  async (metadata) => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useAnalysisStore();
    const air = { ...source, standardName: "air_temperature" };
    store.setActiveSource(source, ref as never, "A", { a: air, b: air });
    const extra = metadata ? { unitsMetadata: metadata } : {};
    store.$patch({
      windows: [
        plot(1, "a", "K", [273.15, 274.15, 275.15], extra),
        plot(2, "b", "degC", [0, 1, 2], extra),
      ],
      compare: { ids: [1, 2], reference: 1 },
    } as never);
    const before = await rows(pinia);
    expect(before.some((row) => row.endsWith("1.00 1.00 0 0"))).toBe(true);
    store.setActiveSource({ ...source, key: "b" }, ref as never, "B", {
      a: air,
      b: { ...source, standardName: "soil_temperature" },
    });
    expect(store.windows.every((w) => w.snapshot)).toBe(true);
    expect(
      store.windows.map((w) => standardNameOf(w.result!, store.variableSources))
    ).toEqual(["air_temperature", "air_temperature"]);
    expect(await rows(pinia)).toEqual(before);
  }
);
