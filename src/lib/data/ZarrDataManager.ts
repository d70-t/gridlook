import { IcechunkStore } from "icechunk-js";
import QuickLRU from "quick-lru";
import * as zarr from "zarrita";

import {
  ZARR_FORMAT,
  type TDataSource,
  type TSources,
  type TZarrFormat,
} from "@/lib/types/GlobeTypes.ts";

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
type TIcechunkStore = zarr.AsyncReadable & Pick<IcechunkStore, "listNodes">;

export class ZarrDataManager {
  private static pendingStore: Promise<
    zarr.Location<zarr.AsyncReadable>
  > | null = null;
  private static fetchStorePath: string | null = null;

  private static normalizeStorePath(store: string) {
    return store.replace(/\/+$/, "");
  }

  private static normalizeDatasetPath(dataset: string) {
    return dataset.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  static isIcechunkStorePath(storePath: string) {
    return this.normalizeStorePath(storePath.split(/[?#]/)[0]).endsWith(
      ".icechunk"
    );
  }

  private static async createIcechunkStore(
    storePath: string
  ): Promise<TIcechunkStore> {
    return await IcechunkStore.open(this.normalizeStorePath(storePath));
  }

  static async createListableIcechunkStore(storePath: string) {
    const store = await this.createIcechunkStore(storePath);
    const contents = store.listNodes().map((node) => ({
      path: node.path as zarr.AbsolutePath,
      kind: node.nodeData.type,
    }));
    return Object.assign(store, { contents: () => contents });
  }

  public static async createNewStore(storePath: string, isIcechunk = false) {
    let store: zarr.AsyncReadable | undefined = undefined;
    if (isIcechunk || this.isIcechunkStorePath(storePath)) {
      store = await this.createIcechunkStore(storePath);
    } else {
      store = new zarr.FetchStore(storePath, { useSuffixRequest: true });
    }

    const cache = new QuickLRU<string, Uint8Array | undefined>({
      maxSize: 512,
    });
    const fetchStore = zarr.extendStore(
      store,
      (s) => zarr.withRangeCoalescing(s, { coalesceSize: 32768 }),
      (s) => zarr.withByteCaching(s, { cache: cache })
    );
    return fetchStore;
  }

  private static async getDataset(
    datasource: TDatasetSource,
    format?: TZarrFormat
  ): Promise<zarr.Group<zarr.AsyncReadable>> {
    const storePath = this.normalizeStorePath(datasource.store);
    if (!this.pendingStore || this.fetchStorePath !== storePath) {
      this.fetchStorePath = storePath;
      this.pendingStore = this.createNewStore(
        storePath,
        format === ZARR_FORMAT.ICECHUNK
      )
        .then((s) => zarr.root(s))
        .catch((e) => {
          // Clear the cache on failure so callers can retry.
          if (this.fetchStorePath === storePath) {
            this.pendingStore = null;
          }
          throw e;
        });
    }
    // Capture locally so a concurrent path switch cannot swap the store under us.
    const root = await this.pendingStore;
    const datasetPath = this.normalizeDatasetPath(datasource.dataset);
    const target = datasetPath ? root.resolve(datasetPath) : root;
    let dataset: zarr.Group<zarr.AsyncReadable>;
    if (format === ZARR_FORMAT.V2) {
      dataset = await zarr.open.v2(target, { kind: "group" });
    } else if (format === ZARR_FORMAT.V3) {
      dataset = await zarr.open.v3(target, { kind: "group" });
    } else {
      dataset = await zarr.open(target, { kind: "group" });
    }
    return dataset;
  }

  private static async getVariable(
    store: zarr.Group<zarr.AsyncReadable>,
    variable: string,
    format?: TZarrFormat
  ): Promise<zarr.Array<zarr.DataType, zarr.AsyncReadable>> {
    const fetchPromise = (async () => {
      if (format === ZARR_FORMAT.V2) {
        return await zarr.open.v2(store.resolve(variable), { kind: "array" });
      } else if (format === ZARR_FORMAT.V3) {
        return await zarr.open.v3(store.resolve(variable), { kind: "array" });
      }
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
    variable: string,
    format?: TZarrFormat
  ): Promise<zarr.Array<zarr.DataType, zarr.AsyncReadable>> {
    const group = await this.getDataset(datasource, format);
    const array = await this.getVariable(group, variable, format);
    return array;
  }

  static async getVariableInfoByDatasetSources(
    datasource: TSources,
    variable: string
  ): Promise<zarr.Array<zarr.DataType, zarr.AsyncReadable>> {
    const array = await ZarrDataManager.getVariableInfo(
      ZarrDataManager.getDatasetSource(datasource!, variable),
      variable,
      datasource.zarr_format
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
    array: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
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
  ): Promise<zarr.Array<zarr.DataType, zarr.AsyncReadable>> {
    const crsVar = await this.findCRSVar(datasource, variable);
    const variableSource = this.getDatasetSource(datasource, variable);
    return await this.getVariableInfo(
      variableSource,
      ZarrDataManager.resolveVariablePath(variable, crsVar),
      datasource.zarr_format
    );
  }

  static async findCRSVar(datasources: TSources, varname: string) {
    const source = this.getDatasetSource(datasources, varname);
    const datavar = await ZarrDataManager.getVariableInfo(
      source,
      varname,
      datasources.zarr_format
    );
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

  static async getDimensionNames(datasources: TSources, varname: string) {
    const source = this.getDatasetSource(datasources, varname) as TDataSource;
    if (source.attrs && source.attrs.dimensionNames) {
      return source.attrs.dimensionNames as string[];
    }

    const datavar = await ZarrDataManager.getVariableInfo(
      ZarrDataManager.getDatasetSource(datasources, varname),
      varname,
      datasources.zarr_format
    );
    return datavar.dimensionNames ?? [];
  }

  static resolveVariablePath(
    contextVariable: string,
    variable: string
  ): string {
    if (variable.includes("/") || !contextVariable.includes("/")) {
      return variable;
    }
    const groupPath = contextVariable.split("/").slice(0, -1).join("/");
    return `${groupPath}/${variable}`;
  }

  static invalidateCache() {
    this.pendingStore = null;
    this.fetchStorePath = null;
  }
}
