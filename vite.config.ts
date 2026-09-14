import { fileURLToPath, URL } from "url";

import vue from "@vitejs/plugin-vue";
import { createLogger, defineConfig, type Plugin } from "vite";
import glsl from "vite-plugin-glsl";
import wasm from "vite-plugin-wasm";

function netCDFWorkerWasm(): Plugin {
  return {
    name: "netcdf-worker-wasm",
    enforce: "pre",
    transform(code, id) {
      // Vite appends ?worker_file&type=module to development worker requests.
      const [path] = id.split("?");
      if (
        !path.endsWith("/@earthyscience/netcdf4-wasm/dist/netcdf-worker.js")
      ) {
        return;
      }
      // netcdf4-wasm 0.2.4 ignores wasmPath in its lazy worker.
      // Remove this shim when upstream supports a bundler-resolved WASM URL.
      const start = code.indexOf("                const origin =");
      const returnStart = code.indexOf("return `${origin}", start);
      const end = code.indexOf(";", returnStart);
      if (start === -1 || returnStart === -1 || end === -1) {
        this.error("NetCDF worker WASM loader changed; update the URL shim.");
      }
      return {
        code:
          code.slice(0, start) +
          'return new URL("./netcdf4-wasm.wasm", import.meta.url).href;' +
          code.slice(end + 1),
        map: null,
      };
    },
  };
}

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
  plugins: [vue(), glsl(), wasm(), netCDFWorkerWasm()],
  optimizeDeps: {
    exclude: ["@earthyscience/netcdf4-wasm"],
  },
  worker: {
    format: "es",
    plugins: () => [wasm(), netCDFWorkerWasm()],
  },
  build: {
    sourcemap: true,
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
