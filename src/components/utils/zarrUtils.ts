import type { TSources } from "@/types/GlobeTypes";
import * as zarr from "zarrita";

export function getDataSourceStore(datasources: TSources, varname: string) {
  const datasource = datasources.levels[0].datasources[varname];
  return zarr.root(
    new zarr.FetchStore(
      (datasource.store.endsWith("/")
        ? datasource.store.slice(0, -1)
        : datasource.store) +
        "/" +
        datasource.dataset
    )
  );
}

export async function findCRSVar(root: zarr.FetchStore, varname: string) {
  const datavar = await zarr.open(root.resolve(varname), {
    kind: "array",
  });
  if (datavar.attrs?.grid_mapping) {
    return String(datavar.attrs.grid_mapping).split(":")[0];
  }
  const group = await zarr.open(root, { kind: "group" });
  if (group.attrs?.grid_mapping) {
    return String(group.attrs.grid_mapping).split(":")[0];
  }
  return "crs";
}
