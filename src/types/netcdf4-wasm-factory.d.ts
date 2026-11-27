// The Emscripten factory inside @earthyscience/netcdf4-wasm, imported by
// path (the package exports only its wrapper).
declare module "*/netcdf4-wasm/dist/netcdf4-wasm.js" {
  const create: (options: object) => Promise<unknown>;
  export default create;
}
