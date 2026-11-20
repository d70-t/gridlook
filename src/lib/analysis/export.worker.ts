/**
 * Scientific file generation off the page's thread: the export model, the
 * Zarr ZIP compression and the NetCDF-4 write run here, so a large export
 * never stalls the map or the charts. One job at a time; inputs arrive as
 * transferred buffers and each reply transfers its bytes back.
 */
import { restoreSnapshot, type TExportSnapshot } from "./exportSnapshot.ts";
import {
  loadNetCDFModule,
  resetNetCDFModule,
  writeNetCDF,
} from "./netcdfWriter.ts";
import { exportModel, toZarrZip } from "./scientificExport.ts";

export type TExportRequest = {
  id: number;
  format: "nc" | "zarr";
  snapshot: TExportSnapshot;
};

export type TExportResponse =
  { id: number; bytes: Uint8Array } | { id: number; error: string };

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<TExportRequest>) => void) | null;
  postMessage: (message: TExportResponse, transfer?: Transferable[]) => void;
  /** Files written here (read by browser tests to prove the thread). */
  gridlookExportsWritten?: number;
};

scope.onmessage = async (event) => {
  const { id, format, snapshot } = event.data;
  try {
    const model = exportModel(restoreSnapshot(snapshot));
    const bytes =
      format === "zarr"
        ? await toZarrZip(model)
        : writeNetCDF(await loadNetCDFModule(), model);
    scope.gridlookExportsWritten = (scope.gridlookExportsWritten ?? 0) + 1;
    scope.postMessage({ id, bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (error) {
    if (format === "nc") {
      resetNetCDFModule();
    }
    scope.postMessage({ id, error: (error as Error).message });
  }
};
