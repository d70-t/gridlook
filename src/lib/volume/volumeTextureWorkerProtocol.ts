import type { GridOptions } from "healpix-geo";

import type {
  TVolumeTextureBuildRequest,
  TVolumeTextureBuildResult,
} from "./volumeTexture.ts";

export type TVolumeTextureWorkerBuildRequest = TVolumeTextureBuildRequest & {
  grid: GridOptions;
};

export type TVolumeTextureWorkerRequest = TVolumeTextureWorkerBuildRequest & {
  requestId: number;
};

export type TVolumeTextureWorkerResponse =
  | ({ requestId: number; type: "result" } & TVolumeTextureBuildResult)
  | {
      requestId: number;
      type: "progress";
      completed: number;
      total: number;
    }
  | { requestId: number; type: "error"; message: string };
