/** Run here against a local range server. */
import { execFileSync } from "node:child_process";
import path from "node:path";

import { expect, it } from "vitest";

import { pythonScript } from "@/lib/analysis/pythonExport.ts";
import { ANALYSIS_KINDS, type TAnalysisResult } from "@/lib/analysis/types.ts";

const FIXTURES = path.join(__dirname, "netcdfFixtures");
const URL = "https://example.org/file.nc";

const HAS_READERS = (() => {
  try {
    execFileSync("python3", [
      "-c",
      "import xarray, scipy, h5py, h5netcdf, dask",
    ]);
    return true;
  } catch {
    return false;
  }
})();

// Serves the fixtures with byte ranges, runs the recipe on each file.
const RUN = String.raw`
import io, sys, threading, xarray as xr
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
root, block, mode = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
class H(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def send_head(self):
        data = (root / self.path.lstrip("/")).read_bytes()
        # "whole": a server that ignores byte ranges (HTTP 200, the file).
        # "probe": ranges for the first byte only; "wrong": other bytes than
        # asked for, labelled as such.
        rng = self.headers.get("Range") if mode != "whole" else None
        if rng and mode == "probe" and rng != "bytes=0-0":
            rng = None
        if rng:
            a, b = rng.split("=")[1].split("-")
            a, b = int(a), int(b) if b else len(data) - 1
            if mode == "wrong" and a > 0:
                a, b = a - 1, b - 1
            body = data[a:b + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {a}-{b}/{len(data)}")
        else:
            body = data
            self.send_response(200)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        return io.BytesIO(body if self.command == "GET" else b"")
s = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=s.serve_forever, daemon=True).start()
for name in ["remote-classic.nc", "remote-offset.nc", "remote-netcdf4.nc"]:
    url = f"http://127.0.0.1:{s.server_port}/{name}"
    env = {"xr": xr}
    code = "\n".join(l.removeprefix("# ") for l in block.split("\n"))
    exec(code.replace(${JSON.stringify(JSON.stringify(URL))}, repr(url)), env)
    print(name, float(env["ds"]["signal"].values.ravel()[0]))
    env["ds"].close()
# The h5py and netCDF4 wheels each bring an HDF5, which can crash at exit.
sys.stdout.flush()
import os; os._exit(0)
`;

function exampleScript() {
  return pythonScript(
    {
      kind: ANALYSIS_KINDS.POINT_SERIES,
      query: {
        version: 1,
        kind: ANALYSIS_KINDS.POINT_SERIES,
        variable: "signal",
        fixed: {},
        geometry: { kind: "point", lat: 0, lon: 0 },
        source: { versionStatus: "best-effort", ref: URL },
      },
      values: [1, 2],
      dims: ["time"],
      shape: [2],
      notes: [],
      time: { dimension: "time", raw: [0, 1], units: "days since 2001-01-01" },
    } as unknown as TAnalysisResult,
    "p",
    "P"
  );
}

it("interim47: the generated HTTP fallback enforces its 4 GiB limit when the size is unknown", () => {
  const script = exampleScript();
  const lines = script.split("\n");
  const from = lines.findIndex((l) => l.startsWith("# import io, re"));
  const to = lines.findIndex((l) => l.startsWith("# da = ds["));
  const block = lines
    .slice(from, to)
    .map((l) => l.slice(2))
    .join("\n");
  // A real unknown-length response permits read through EOF. Record the
  // requested size without allocating a large file or making a network call.
  const run = String.raw`
import io, sys, urllib.request
from types import SimpleNamespace
class Response(io.BytesIO):
    headers = {}
    def read(self, size=-1):
        print(size)
        return super().read(size)
urllib.request.urlopen = lambda url: Response(b"data")
xr = SimpleNamespace(open_dataset=lambda *args, **kwargs: True)
exec(sys.argv[1])
`;
  const reads = execFileSync("python3", ["-I", "-c", run, block], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map(Number);
  expect(reads.length).toBeGreaterThan(0);
  expect(Math.min(...reads)).toBeGreaterThan(0);
  expect(Math.max(...reads)).toBeLessThanOrEqual(4 * 1024 ** 3 + 1);
});

it("opens NetCDF-3 and NetCDF-4 over HTTP with the script's recipe", ({
  skip,
}) => {
  const script = exampleScript();
  // The recipe's open block, from its imports to the whole-file fallback.
  const lines = script.split("\n");
  const from = lines.findIndex((l) => l.startsWith("# import io, re"));
  const to = lines.findIndex((l) => l.includes("ds = xr.open_dataset(whole"));
  const block = lines.slice(from, to + 1).join("\n");
  expect(block).not.toContain("engine=");
  if (!HAS_READERS) {
    skip();
  }
  // By byte ranges, and from a server that sends the whole file.
  for (const mode of ["ranges", "whole", "probe", "wrong"]) {
    const out = execFileSync(
      "python3",
      ["-I", "-c", RUN, FIXTURES, block, mode],
      {
        encoding: "utf8",
      }
    );
    expect(out.trim().split("\n"), mode).toEqual([
      "remote-classic.nc 10.0",
      "remote-offset.nc 10.0",
      "remote-netcdf4.nc 10.0",
    ]);
  }
});

it("interim48: the fallback's limit holds under python -O and only transport errors fall back", () => {
  const script = exampleScript();
  expect(script).not.toMatch(/#\s+assert /);
  expect(script).not.toContain("except Exception");
  expect(script).toContain("except (OSError, ValueError):");
});

// A server whose file is republished after the first reply: "same" keeps
// it, "drop" stops naming its ETag, "swap" names another one and answers
// 412 to an If-Match for the old one, "weak" changes a weak ETag (no If-Match
// pins it), "late" names one only from the second reply on.
const REPUBLISH = String.raw`
import io, sys, threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
block, mode = sys.argv[1], sys.argv[2]
data, state = bytes(range(64)), {"replies": 0}
class H(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def send_head(self):
        first = state["replies"] == 0
        state["replies"] += 1
        tags = {"same": ('"A"', '"A"'), "drop": ('"A"', None), "swap": ('"A"', '"B"'),
                "weak": ('W/"A"', 'W/"B"'), "late": (None, '"A"')}[mode]
        tag = tags[0] if first else tags[1]
        wanted = self.headers.get("If-Match")
        if wanted and tag != wanted:
            self.send_response(412)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return io.BytesIO(b"")
        a, b = (int(x) for x in self.headers["Range"].split("=")[1].split("-"))
        self.send_response(206)
        self.send_header("Content-Range", f"bytes {a}-{b}/{len(data)}")
        if tag:
            self.send_header("ETag", tag)
        self.send_header("Content-Length", str(b - a + 1))
        self.end_headers()
        return io.BytesIO(data[a:b + 1])
s = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=s.serve_forever, daemon=True).start()
env = {}
exec("\n".join(l.removeprefix("# ") for l in block.split("\n")), env)
ranges = env["Ranges"](f"http://127.0.0.1:{s.server_port}/f.nc")
try:
    print("read", list(ranges.get(1, 4)[0]))
except ValueError as error:
    print("refused", error)
`;

it("binds the recipe's later range reads to the first reply's validator", () => {
  const lines = exampleScript().split("\n");
  const from = lines.findIndex((l) => l.startsWith("# import io, re"));
  const to = lines.findIndex((l) => l.startsWith("# url = "));
  const block = lines.slice(from, to).join("\n");
  const run = (mode: string) =>
    execFileSync("python3", ["-I", "-c", REPUBLISH, block, mode], {
      encoding: "utf8",
    }).trim();
  expect(run("same")).toBe("read [1, 2, 3, 4]");
  expect(run("drop")).toBe("refused the file changed while it was read");
  expect(run("swap")).toBe("refused the file changed while it was read");
  expect(run("weak")).toBe("refused the file changed while it was read");
  expect(run("late")).toBe("refused the file changed while it was read");
});

// Serves a NetCDF-4 fixture by ranges, republished after the first reply
// (another strong ETag; 412 to an If-Match for the first).
const SWAP_DURING_OPEN = String.raw`
import io, sys, threading, xarray as xr
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
data, block = Path(sys.argv[1]).read_bytes(), sys.argv[2]
state, seen = {"replies": 0}, []
class H(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def send_head(self):
        tag = '"A"' if state["replies"] == 0 else '"B"'
        state["replies"] += 1
        rng, wanted = self.headers.get("Range"), self.headers.get("If-Match")
        seen.append(rng or "whole")
        if wanted and wanted != tag:
            self.send_response(412)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return io.BytesIO(b"")
        a, b = (int(x) for x in rng.split("=")[1].split("-")) if rng else (0, len(data) - 1)
        self.send_response(206 if rng else 200)
        if rng:
            self.send_header("Content-Range", f"bytes {a}-{b}/{len(data)}")
        self.send_header("ETag", tag)
        self.send_header("Content-Length", str(b - a + 1))
        self.end_headers()
        return io.BytesIO(data[a:b + 1])
s = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=s.serve_forever, daemon=True).start()
code = "\n".join(l.removeprefix("# ") for l in block.split("\n"))
url = f"http://127.0.0.1:{s.server_port}/f.nc"
try:
    exec(code.replace(${JSON.stringify(JSON.stringify(URL))}, repr(url)), {"xr": xr})
    print("opened")
except RuntimeError as error:
    print("refused", error)
print("whole" in seen)
sys.stdout.flush()
import os; os._exit(0)
`;

it("refuses a file republished while the recipe opens it, without reading it whole", ({
  skip,
}) => {
  const lines = exampleScript().split("\n");
  const from = lines.findIndex((l) => l.startsWith("# import io, re"));
  const to = lines.findIndex((l) => l.includes("ds = xr.open_dataset(whole"));
  const block = lines.slice(from, to + 1).join("\n");
  if (!HAS_READERS) {
    skip();
  }
  const out = execFileSync(
    "python3",
    [
      "-I",
      "-c",
      SWAP_DURING_OPEN,
      path.join(FIXTURES, "remote-netcdf4.nc"),
      block,
    ],
    { encoding: "utf8" }
  );
  expect(out.trim().split("\n")).toEqual([
    "refused the file was republished while it was opened; open it again",
    "False",
  ]);
});
