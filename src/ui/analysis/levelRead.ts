import { publicSourceRef } from "@/lib/analysis/analysisExport.ts";
import { storePath } from "@/lib/data/sourceType.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";

/**
 * Plots read the catalog's first level, whichever the map shows: named in
 * Method when there are several. A catalog of one level records it too: its
 * variables' stores are what a script opens.
 */
export function levelRead(
  sources: TSources,
  store: string,
  dataset: string | undefined,
  /** The address opened: a JSON catalog, or a store. */
  src: string
) {
  // Labels without a store's access parameters.
  const shown = (text: string) => publicSourceRef(text).ref;
  const catalog = /\.json(?:$|[?#])/i.test(src);
  return sources.levels.length > 1 || catalog
    ? {
        level: {
          index: 0,
          count: sources.levels.length,
          label: shown(sources.levels[0].path ?? storePath(store, dataset)),
          paths: sources.levels.map((level) =>
            level.path ? shown(level.path) : undefined
          ),
        },
      }
    : {};
}
