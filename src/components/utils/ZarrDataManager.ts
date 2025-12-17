import type { TDataSource, TSources } from "@/types/GlobeTypes";
import * as zarr from "zarrita";

type CacheEntry<T> = Promise<T> | T;

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
  private static datasetCache: Map<
    string,
    CacheEntry<zarr.Group<zarr.FetchStore>>
  > = new Map();
  private static variableCache: Map<
    string,
    CacheEntry<zarr.Array<zarr.DataType, zarr.FetchStore>>
  > = new Map();
  private static dataCache: Map<string, CacheEntry<unknown>> = new Map();
  private static dataCacheWhitelist = new Set(["time", "lat", "lon"]);

  private static normalizeStorePath(store: string) {
    return store.replace(/\/+$/, "");
  }

  private static normalizeDatasetPath(dataset: string) {
    return dataset.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  private static datasetCacheKey(datasource: TDatasetSource) {
    return [
      this.normalizeStorePath(datasource.store),
      this.normalizeDatasetPath(datasource.dataset),
    ].join("::");
  }

  private static variableCacheKey(
    datasource: TDatasetSource,
    variable: string
  ) {
    return [this.datasetCacheKey(datasource), variable].join("::");
  }

  private static dataCacheKey(
    datasource: TDatasetSource,
    variable: string,
    selection?: (number | null | zarr.Slice)[]
  ) {
    const selectionKey = selection ? JSON.stringify(selection) : "full";
    return [this.variableCacheKey(datasource, variable), selectionKey].join(
      "::"
    );
  }

  private static async getDataset(
    datasource: TDatasetSource
  ): Promise<zarr.Group<zarr.FetchStore>> {
    const cacheKey = this.datasetCacheKey(datasource);
    const cached = this.datasetCache.get(cacheKey);
    if (cached) {
      return cached instanceof Promise ? await cached : cached;
    }

    const fetchPromise = (async () => {
      const root = zarr.root(new zarr.FetchStore(datasource.store));
      const datasetPath = this.normalizeDatasetPath(datasource.dataset);
      const target = datasetPath ? root.resolve(datasetPath) : root;
      return await zarr.open(target, { kind: "group" });
    })();

    this.datasetCache.set(cacheKey, fetchPromise);
    try {
      const dataset = await fetchPromise;
      this.datasetCache.set(cacheKey, dataset);
      return dataset;
    } catch (error) {
      this.datasetCache.delete(cacheKey);
      throw error;
    }
  }

  private static async getVariable(
    datasource: TDatasetSource,
    store: zarr.Group<zarr.FetchStore>,
    variable: string
  ): Promise<zarr.Array<zarr.DataType, zarr.FetchStore>> {
    const cacheKey = this.variableCacheKey(datasource, variable);
    const cached = this.variableCache.get(cacheKey);
    if (cached) {
      return cached instanceof Promise ? await cached : cached;
    }

    const fetchPromise = (async () => {
      return await zarr.open(store.resolve(variable), {
        kind: "array",
      });
    })();

    this.variableCache.set(cacheKey, fetchPromise);
    try {
      const array = await fetchPromise;
      this.variableCache.set(cacheKey, array);
      return array;
    } catch (error) {
      this.variableCache.delete(cacheKey);
      throw error;
    }
  }

  static async getDatasetGroup(datasource: TDatasetSource) {
    return await this.getDataset(datasource);
  }

  static async getVariableInfo(
    datasource: TDatasetSource,
    variable: string
  ): Promise<zarr.Array<zarr.DataType, zarr.FetchStore>> {
    const group = await this.getDataset(datasource);
    const array = await this.getVariable(datasource, group, variable);
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
    // Check if variable is in whitelist and should be cached
    if (this.dataCacheWhitelist.has(variable)) {
      const cacheKey = this.dataCacheKey(datasource, variable, selection);
      const cached = this.dataCache.get(cacheKey);
      if (cached) {
        return cached instanceof Promise ? await cached : cached;
      }

      const fetchPromise = (async () => {
        const array = await this.getVariableInfo(datasource, variable);
        if (selection && selection.length > 0) {
          return await zarr.get(array, selection);
        }
        return await zarr.get(array);
      })();

      this.dataCache.set(cacheKey, fetchPromise);
      try {
        const data = await fetchPromise;
        this.dataCache.set(cacheKey, data);
        return data;
      } catch (error) {
        this.dataCache.delete(cacheKey);
        throw error;
      }
    }

    // Non-whitelisted variables: fetch without caching
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
    this.datasetCache.clear();
    this.variableCache.clear();
    this.dataCache.clear();
  }
}
