import { registerPCodec } from "@eeholmes/zarrita-pcodec";
import { registry } from "zarrita";

import { Fletcher32Codec } from "./fletcher32.ts";
registry.set("numcodecs.fletcher32", async () => Fletcher32Codec);
registerPCodec(registry);
