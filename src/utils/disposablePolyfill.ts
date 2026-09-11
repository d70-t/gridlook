// Load before healpix-geo so its WASM bindings register their disposal methods.
if (!Symbol.dispose) {
  Object.defineProperty(Symbol, "dispose", {
    value: Symbol.for("Symbol.dispose"),
  });
}
