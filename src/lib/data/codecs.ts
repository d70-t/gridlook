import { registerPCodec } from "@eeholmes/zarrita-pcodec";
import { registry } from "zarrita";

import { Fletcher32Codec } from "./fletcher32.ts";
import { GribscanRawGribCodec } from "./gribscan.ts";
registry.set("numcodecs.fletcher32", async () => Fletcher32Codec);
registry.set("numcodecs.gribscan.rawgrib", async () => GribscanRawGribCodec);
registerPCodec(registry);
