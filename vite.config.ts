import { fileURLToPath, URL } from "url";

import vue from "@vitejs/plugin-vue";
import { createLogger, defineConfig } from "vite";
import glsl from "vite-plugin-glsl";
import wasm from "vite-plugin-wasm";

// @earthyscience/netcdf4-wasm ships .js.map files referencing original
// TypeScript sources that aren't included in the published package, so Vite
// can never find them. Silence just that one warning; everything else still
// logs normally.
const logger = createLogger();
const { warnOnce } = logger;
logger.warnOnce = (msg, options) => {
  if (msg.includes("points to missing source files")) {
    return;
  }
  warnOnce(msg, options);
};

// https://vitejs.dev/config/
export default defineConfig({
  customLogger: logger,
  plugins: [vue(), glsl(), wasm()],
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
  build: {
    sourcemap: true,
  },
  // @earthyscience/netcdf4-wasm's worker bundle references this Next.js env
  // var directly; it has no runtime value in a plain browser Worker, so it
  // must be statically replaced at build time or `process` throws.
  define: {
    "process.env.NEXT_PUBLIC_BASE_PATH": JSON.stringify(""),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: "modern-compiler",
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  base: "./",
});
