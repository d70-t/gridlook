import { registerPCodec } from "@eeholmes/zarrita-pcodec";
import { registry } from "zarrita";

import { Fletcher32Codec } from "./fletcher32.ts";
import { GribscanRawGribCodec } from "./gribscan.ts";
import { LogBinsCodec } from "./logBins.ts";
registry.set("numcodecs.fletcher32", async () => Fletcher32Codec);
registry.set("numcodecs.gribscan.rawgrib", async () => GribscanRawGribCodec);
registry.set("numcodecs.log_bins", async () => LogBinsCodec);
registerPCodec(registry);
