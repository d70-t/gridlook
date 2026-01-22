import * as zarr from "zarrita";

import { lru } from "@/lib/data/lruStore";
import type { TDataSource, TSources } from "@/lib/types/GlobeTypes";

export type TZarrDatasetMetadata = {
  attrs: zarr.Attributes;
  store: string;
  dataset: string;
};

export type TZarrVariableMetadata = {
  attrs: zarr.Attributes;
  shape: readonly number[];
  chunks: readonly (number | null)[];
  dtype: zarr.Array<zarr.DataType, zarr.FetchStore>["dtype"];
  store: string;
  dataset: string;
  variable: string;
};

type TDatasetSource = Pick<TDataSource, "dataset" | "store">;

export class ZarrDataManager {
  private static fetchStore: zarr.Location<zarr.FetchStore> | null = null;
  private static fetchStorePath: string | null = null;

  private static normalizeStorePath(store: string) {
    return store.replace(/\/+$/, "");
  }

  private static normalizeDatasetPath(dataset: string) {
    return dataset.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  private static async getDataset(
    datasource: TDatasetSource
  ): Promise<zarr.Group<zarr.FetchStore>> {
    const storePath = this.normalizeStorePath(datasource.store);
    if (!this.fetchStore || this.fetchStorePath !== storePath) {
      this.fetchStorePath = storePath;
      this.fetchStore = zarr.root(lru(new zarr.FetchStore(storePath)));
    }
    const root = this.fetchStore!;
    const datasetPath = this.normalizeDatasetPath(datasource.dataset);
    const target = datasetPath ? root.resolve(datasetPath) : root;
    return await zarr.open(target, { kind: "group" });
  }

  private static async getVariable(
    store: zarr.Group<zarr.FetchStore>,
    variable: string
  ): Promise<zarr.Array<zarr.DataType, zarr.FetchStore>> {
    const fetchPromise = (async () => {
      return await zarr.open(store.resolve(variable), {
        kind: "array",
      });
    })();
    const array = await fetchPromise;
    return array;
  }

  static async getDatasetGroup(datasource: TDatasetSource) {
    return await this.getDataset(datasource);
  }

  static async getVariableInfo(
    datasource: TDatasetSource,
    variable: string
  ): Promise<zarr.Array<zarr.DataType, zarr.FetchStore>> {
    const group = await this.getDataset(datasource);
    const array = await this.getVariable(group, variable);
    return array;
  }

  static async getVariableInfoByDatasetSources(
    datasource: TSources,
    variable: string
  ): Promise<zarr.Array<zarr.DataType, zarr.FetchStore>> {
    const array = await ZarrDataManager.getVariableInfo(
      ZarrDataManager.getDatasetSource(datasource!, variable),
      variable
    );
    return array;
  }

  static async getVariableData(
    datasource: TDatasetSource,
    variable: string,
    selection?: (number | null | zarr.Slice)[]
  ) {
    const array = await this.getVariableInfo(datasource, variable);
    if (selection && selection.length > 0) {
      return await zarr.get(array, selection);
    }
    return await zarr.get(array);
  }

  static getVariableDataFromArray(
    array: zarr.Array<zarr.DataType, zarr.FetchStore>,
    selection?: (number | null | zarr.Slice)[]
  ) {
    if (selection && selection.length > 0) {
      return zarr.get(array, selection);
    }
    return zarr.get(array);
  }

  static async getCRSInfo(
    datasource: TSources,
    variable: string
  ): Promise<zarr.Array<zarr.DataType, zarr.FetchStore>> {
    const crsVar = await this.findCRSVar(datasource, variable);
    const variableSource = this.getDatasetSource(datasource, variable);
    return await this.getVariableInfo(variableSource, crsVar);
  }

  static async findCRSVar(datasources: TSources, varname: string) {
    const source = this.getDatasetSource(datasources, varname);
    const datavar = await ZarrDataManager.getVariableInfo(source, varname);
    if (datavar.attrs?.grid_mapping) {
      return String(datavar.attrs.grid_mapping).split(":")[0];
    }
    const group = await ZarrDataManager.getDatasetGroup(source);
    if (group.attrs?.grid_mapping) {
      return String(group.attrs.grid_mapping).split(":")[0];
    }
    return "crs";
  }

  static getDatasetSource(
    datasources: TSources,
    varname: string
  ): TDatasetSource {
    return datasources.levels[0].datasources[varname];
  }

  static invalidateCache() {
    this.fetchStore = null;
    this.fetchStorePath = null;
  }
}
