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

export async function getArrayInfo(root: zarr.FetchStore, varname: string) {
  const array = await zarr.open(root.resolve(varname), { kind: "array" });
  const obje = {
    shape: array.shape,
    dimensions: array.attrs._ARRAY_DIMENSIONS,
  };
  return obje;
}

export function getMissingValue(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>
) {
  const attributes = datavar.attrs;
  if ("missingValue" in attributes) return Number(datavar.attrs.missingValue);
  if ("missing_value" in attributes) return Number(datavar.attrs.missing_value);
  else return NaN;
}

export function getFillValue(
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>
) {
  const symbols = Object.getOwnPropertySymbols(datavar);
  const contextSymbol = symbols.find(
    (sym) => sym.toString() === "Symbol(zarrita.context)"
  );
  if (!contextSymbol) return NaN;
  // FIXME
  // @ts-expect-error These context symbol is not publicly exposed in the documentation
  const obj = datavar[contextSymbol];
  return Number(obj.fill_value);
}
