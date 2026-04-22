import { registry } from "zarrita";

import { BitroundCodec } from "./bitround";

registry.set("numcodecs.bitround", async () => BitroundCodec);
