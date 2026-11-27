/**
 * NetCDF-4 (HDF5) files from the shared export model, written with the
 * netCDF-C library compiled to WebAssembly. The package's high-level
 * attribute setters only change JavaScript objects, so this calls the C
 * entry points directly: attributes, fill values and 64-bit integers are
 * stored in the file.
 */
import type { TExportAttr, TExportModel } from "./scientificExport.ts";

/** The parts of the Emscripten module the writer uses. */
export type TNetCDFModule = {
  _malloc(size: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  getValue(pointer: number, type: string): number;
  setValue(pointer: number, value: number, type: string): void;
  lengthBytesUTF8(text: string): number;
  stringToUTF8(text: string, pointer: number, max: number): void;
  FS: {
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
} & Record<string, unknown>;

const NC = {
  NETCDF4: 0x1000,
  CLOBBER: 0,
  GLOBAL: -1,
  INT: 4,
  DOUBLE: 6,
  INT64: 10,
  UINT64: 11,
  STRING: 12,
} as const;

const TYPES = {
  f8: NC.DOUBLE,
  i4: NC.INT,
  i8: NC.INT64,
  u8: NC.UINT64,
  str: NC.STRING,
} as const;

type TCall = (...args: number[]) => number;

class Writer {
  private readonly scratch: number;

  constructor(private readonly m: TNetCDFModule) {
    this.scratch = m._malloc(8);
  }

  call(name: string, ...args: number[]) {
    const fn = this.m[`_${name}_wrapper`] as TCall | undefined;
    if (!fn) {
      throw new Error(`NetCDF writer: ${name} is not available.`);
    }
    const status = fn(...args);
    if (status !== 0) {
      throw new Error(`NetCDF writer: ${name} failed (${status}).`);
    }
  }

  out() {
    return this.m.getValue(this.scratch, "i32");
  }

  get scratchPointer() {
    return this.scratch;
  }

  text(value: string) {
    const n = this.m.lengthBytesUTF8(value) + 1;
    const pointer = this.m._malloc(n);
    this.m.stringToUTF8(value, pointer, n);
    return { pointer, length: n - 1 };
  }

  /**
   * Copy typed values into the heap. The module's HEAPU8 is read after the
   * allocation, which may have grown (and replaced) the memory.
   */
  bytes(values: ArrayBufferView) {
    const pointer = this.m._malloc(Math.max(8, values.byteLength));
    if (!pointer) {
      throw new Error("NetCDF writer: out of WebAssembly memory.");
    }
    this.m.HEAPU8.set(
      new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
      pointer
    );
    return pointer;
  }

  /** A size_t[] (32-bit in WebAssembly) for start/count vectors. */
  sizes(values: number[]) {
    return this.bytes(Uint32Array.from(values));
  }

  free(...pointers: number[]) {
    pointers.forEach((pointer) => this.m._free(pointer));
  }

  close() {
    this.m._free(this.scratch);
  }
}

// eslint-disable-next-line max-lines-per-function
function putAttr(
  w: Writer,
  ncid: number,
  varid: number,
  name: string,
  value: TExportAttr
) {
  const key = w.text(name);
  try {
    if (typeof value === "string") {
      const text = w.text(value);
      w.call(
        "nc_put_att_text",
        ncid,
        varid,
        key.pointer,
        text.length,
        text.pointer
      );
      w.free(text.pointer);
      return;
    }
    const values = Array.isArray(value) ? value : [value];
    const integral = values.every(
      (v) => Number.isInteger(v) && Math.abs(v) < 2 ** 31
    );
    // flag_values must match an integer variable; other numbers are doubles.
    if (integral && name === "flag_values") {
      const pointer = w.bytes(Int32Array.from(values));
      w.call(
        "nc_put_att_int",
        ncid,
        varid,
        key.pointer,
        NC.INT,
        values.length,
        pointer
      );
      w.free(pointer);
    } else {
      const pointer = w.bytes(Float64Array.from(values));
      w.call(
        "nc_put_att_double",
        ncid,
        varid,
        key.pointer,
        NC.DOUBLE,
        values.length,
        pointer
      );
      w.free(pointer);
    }
  } finally {
    w.free(key.pointer);
  }
}

/** Text values (NC_STRING): an array of pointers to UTF-8 strings. */
function putStrings(w: Writer, ncid: number, varid: number, values: string[]) {
  // NetCDF strings end at a NUL: "ctl" and "ctl\0B" would both read "ctl" and
  // merge two members. Refused, not truncated.
  if (values.some((value) => value.includes("\0"))) {
    throw new Error(
      "A label holds a NUL character, which NetCDF text cannot store; download Zarr to keep it exactly."
    );
  }
  const texts = values.map((value) => w.text(value));
  const pointers = w.bytes(Uint32Array.from(texts.map((t) => t.pointer)));
  try {
    w.call("nc_put_var_string", ncid, varid, pointers);
  } finally {
    w.free(pointers, ...texts.map((t) => t.pointer));
  }
}

// Values are written in slabs of at most this many bytes along the first
/** netCDF's default fill values of the 64-bit integer types. */
const NC_FILL_INT64 = -9223372036854775806n;
const NC_FILL_UINT64 = 18446744073709551614n;

/**
 * The text of a scalar integer equal to its type's default fill value: a
 * reader masking the default (netCDF4-Python) still finds the value.
 */
function defaultFillCollision(array: TExportModel["arrays"][number]) {
  if (array.type !== "i8" && array.type !== "u8") {
    return undefined;
  }
  const data = array.data as BigInt64Array | BigUint64Array;
  const fill = array.type === "i8" ? NC_FILL_INT64 : NC_FILL_UINT64;
  if (data.length !== 1 || data[0] !== fill) {
    return undefined;
  }
  // The identifier as text: a reader that masks it still has its value.
  return String(fill);
}

// dimension, so a large result never needs one huge heap copy.
const SLAB_BYTES = 4 * 2 ** 20;

// eslint-disable-next-line max-lines-per-function
function putValues(
  w: Writer,
  ncid: number,
  varid: number,
  array: TExportModel["arrays"][number],
  sizes: Map<string, number>
) {
  const shape = array.dims.map((dim) => sizes.get(dim)!);
  if (array.type === "str") {
    putStrings(w, ncid, varid, array.data as string[]);
    return;
  }
  const data = array.data as Exclude<typeof array.data, string[]>;
  const kind = {
    f8: "double",
    i4: "int",
    i8: "longlong",
    u8: "ulonglong",
  }[array.type];
  if (!shape.length) {
    const pointer = w.bytes(data);
    if (array.type === "u8") {
      // The library exports only the slab form for unsigned 64-bit values;
      // a scalar is a slab of rank zero.
      const none = w.sizes([]);
      w.call("nc_put_vara_ulonglong", ncid, varid, none, none, pointer);
      w.free(none);
    } else {
      w.call(`nc_put_var_${kind}`, ncid, varid, pointer);
    }
    w.free(pointer);
    return;
  }
  // Tiles of at most SLAB_BYTES across every axis: a single giant row is
  // split too, so the WASM heap never holds more than one tile of input.
  const tile = tileShape(shape, SLAB_BYTES / data.BYTES_PER_ELEMENT);
  const strides = shape.map((_, d) =>
    shape.slice(d + 1).reduce((p, n) => p * n, 1)
  );
  const origin = shape.map(() => 0);
  for (;;) {
    const count = shape.map((n, d) => Math.min(tile[d], n - origin[d]));
    const buffer = gatherTile(data, strides, origin, count);
    const start = w.sizes(origin);
    const counts = w.sizes(count);
    const pointer = w.bytes(buffer);
    try {
      w.call(`nc_put_vara_${kind}`, ncid, varid, start, counts, pointer);
    } finally {
      w.free(pointer, start, counts);
    }
    // Next tile: odometer over the tile grid, last axis fastest.
    let d = shape.length - 1;
    while (d >= 0) {
      origin[d] += tile[d];
      if (origin[d] < shape[d]) {
        break;
      }
      origin[d] = 0;
      d--;
    }
    if (d < 0) {
      return;
    }
  }
}

/** A tile of at most `limit` values, split along the leading axes first. */
function tileShape(shape: number[], limit: number) {
  const tile = shape.map((n) => Math.max(1, n));
  for (let d = 0; d < tile.length; d++) {
    const rest = tile.slice(d + 1).reduce((p, n) => p * n, 1);
    if (tile[d] * rest <= limit) {
      break;
    }
    tile[d] = Math.max(1, Math.floor(limit / rest));
    if (tile[d] > 1 || rest <= limit) {
      break;
    }
  }
  return tile;
}

/** Copy one tile (row-major) out of the full row-major array. */
function gatherTile<
  T extends Float64Array | Int32Array | BigInt64Array | BigUint64Array,
>(data: T, strides: number[], origin: number[], count: number[]): T {
  const rank = count.length;
  const inner = count[rank - 1];
  const total = count.reduce((p, n) => p * n, 1);
  const out = new (data.constructor as new (n: number) => T)(total);
  const index = new Array<number>(rank - 1).fill(0);
  for (let at = 0; at < total; at += inner) {
    let offset = origin[rank - 1];
    for (let d = 0; d < rank - 1; d++) {
      offset += (origin[d] + index[d]) * strides[d];
    }
    out.set(data.subarray(offset, offset + inner) as never, at);
    for (let d = rank - 2; d >= 0; d--) {
      if (++index[d] < count[d]) {
        break;
      }
      index[d] = 0;
    }
  }
  return out;
}

let fileCounter = 0;

/** A NetCDF-4 file of the model, as bytes. */
// eslint-disable-next-line max-lines-per-function
export function writeNetCDF(m: TNetCDFModule, model: TExportModel): Uint8Array {
  const w = new Writer(m);
  const path = w.text(`/gridlook-export-${++fileCounter}.nc`);
  const pathName = `/gridlook-export-${fileCounter}.nc`;
  let ncid = -1;
  try {
    w.call(
      "nc_create",
      path.pointer,
      NC.CLOBBER | NC.NETCDF4,
      w.scratchPointer
    );
    ncid = w.out();
    const dimids = new Map<string, number>();
    const sizes = new Map(model.dims);
    for (const [name, size] of model.dims) {
      const key = w.text(name);
      w.call("nc_def_dim", ncid, key.pointer, size, w.scratchPointer);
      w.free(key.pointer);
      dimids.set(name, w.out());
    }
    const varids: number[] = [];
    for (const array of model.arrays) {
      const key = w.text(array.name);
      const ids = w.bytes(
        Int32Array.from(array.dims.map((dim) => dimids.get(dim)!))
      );
      w.call(
        "nc_def_var",
        ncid,
        key.pointer,
        TYPES[array.type],
        array.dims.length,
        ids,
        w.scratchPointer
      );
      w.free(key.pointer, ids);
      const varid = w.out();
      varids.push(varid);
      // Doubles: NaN marks missing. Integers carry no fill value: default
      // readers would turn them into floats and round large identifiers; their
      // validity is in the status variables (and −1 is documented). Not on a
      // dimension coordinate: CF does not allow missing values there.
      const coordinate =
        array.dims.length === 1 && array.dims[0] === array.name;
      const collides = defaultFillCollision(array);
      if (array.type === "str") {
        // Text has no fill value to set.
      } else if (array.type === "f8" && !coordinate) {
        const fill = w.bytes(Float64Array.of(Number.NaN));
        w.call("nc_def_var_fill", ncid, varid, 0, fill);
        w.free(fill);
      } else {
        // No fill, also for a value equal to the library's default fill: an
        // explicit other _FillValue made xarray decode the identifier as
        // float64, 18446744073709551614 as 2^64, and merge members under
        // concatenation. netCDF4-Python still masks that one value by its
        // default; its exact text is kept beside it.
        w.call("nc_def_var_fill", ncid, varid, 1, 0);
      }
      for (const [name, value] of Object.entries(array.attrs)) {
        putAttr(w, ncid, varid, name, value);
      }
      if (collides && array.attrs.gridlook_identifier === undefined) {
        putAttr(w, ncid, varid, "gridlook_identifier", collides);
      }
    }
    for (const [name, value] of Object.entries(model.attrs)) {
      putAttr(w, ncid, NC.GLOBAL, name, value);
    }
    w.call("nc_enddef", ncid);
    model.arrays.forEach((array, at) =>
      putValues(w, ncid, varids[at], array, sizes)
    );
    w.call("nc_close", ncid);
    ncid = -1;
    const bytes = m.FS.readFile(pathName).slice();
    m.FS.unlink(pathName);
    return bytes;
  } finally {
    if (ncid >= 0) {
      (m._nc_close_wrapper as TCall | undefined)?.(ncid);
      try {
        m.FS.unlink(pathName);
      } catch {
        // the file was not created
      }
    }
    w.free(path.pointer);
    w.close();
  }
}

let loading: Promise<TNetCDFModule> | undefined;

/**
 * The netCDF-C library, loaded once: the Emscripten factory itself (not the
 * package's wrapper, whose copied memory views go stale when the memory
 * grows). Tests pass the WebAssembly bytes; the page fetches them.
 */
export function loadNetCDFModule(
  options: { wasmBinary?: Uint8Array } = {}
): Promise<TNetCDFModule> {
  loading ??= (async () => {
    const factory =
      await import("../../../node_modules/@earthyscience/netcdf4-wasm/dist/netcdf4-wasm.js");
    const wasmUrl = new URL(
      "../../../node_modules/@earthyscience/netcdf4-wasm/dist/netcdf4-wasm.wasm",
      import.meta.url
    ).href;
    const create = factory.default as (o: object) => Promise<TNetCDFModule>;
    const bytes = options.wasmBinary;
    return create({
      // Given bytes are instantiated through Emscripten's hook (0.4 of the
      // package no longer reads `wasmBinary`); the page fetches the file.
      ...(bytes
        ? {
            instantiateWasm(
              imports: WebAssembly.Imports,
              receive: (instance: WebAssembly.Instance) => void
            ) {
              // A copy types as an ArrayBuffer view (not a shared one).
              void WebAssembly.instantiate(new Uint8Array(bytes), imports).then(
                (made) => receive(made.instance)
              );
              return {};
            },
          }
        : { locateFile: () => wasmUrl }),
      print: () => undefined,
      printErr: () => undefined,
    });
  })();
  loading.catch(() => (loading = undefined));
  return loading;
}

/** Forget the library after a failure, so the next download starts fresh. */
export function resetNetCDFModule() {
  loading = undefined;
}
