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
  // Open array from different store types
  // Or: const store = new zarr.LocalStore('path/to/data.zarr');
  const array = await zarr.open(root.resolve(varname), { kind: "array" });
  // console.log("Shape:", array.shape);
  // console.log("Number of dimensions:", array.shape.length);
  // console.log("Data type:", array.dtype);
  const obje = {
    shape: array.shape,
    dimensions: array.attrs._ARRAY_DIMENSIONS,
  };
  // console.log(obje);
  // // Calculate total size
  // const totalSize = array.shape.reduce((a, b) => a * b, 1);
  // const attrs = array.attrs;
  // console.log(array, array.attrs);
  // if (attrs && attrs.dimension_names) {
  //   console.log("Dimension names:", attrs.dimension_names);
  // }
  // console.log("Total elements:", totalSize);
  return obje;
}
