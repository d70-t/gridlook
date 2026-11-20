import { registerPCodec } from "@eeholmes/zarrita-pcodec";
import {
  Blosc2Codec,
  Fletcher32Codec,
  GribscanRawGribCodec,
  LogBinsCodec,
} from "codecita";
import { registry } from "zarrita";
import { registerHcc } from "zarrita-hcc";

registry.set("numcodecs.fletcher32", async () => Fletcher32Codec);
registry.set("numcodecs.gribscan.rawgrib", async () => GribscanRawGribCodec);
registry.set("numcodecs.log_bins", async () => LogBinsCodec);
registry.set("numcodecs.blosc2", async () => Blosc2Codec);
registry.set("blosc2", async () => Blosc2Codec);

registerPCodec(registry);
registerHcc(registry);
