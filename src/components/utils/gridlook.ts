import * as THREE from "three";
import * as zarr from "zarrita";
import { castDataVarToFloat32, getDataBounds } from "./zarrUtils";

export async function grid2buffer(grid: zarr.Group<zarr.FetchStore>) {
  const [voc, vx, vy, vz] = await Promise.all([
    zarr.open(grid.resolve("vertex_of_cell"), { kind: "array" }).then(zarr.get),
    zarr
      .open(grid.resolve("cartesian_x_vertices"), { kind: "array" })
      .then(zarr.get),
    zarr
      .open(grid.resolve("cartesian_y_vertices"), { kind: "array" })
      .then(zarr.get),
    zarr
      .open(grid.resolve("cartesian_z_vertices"), { kind: "array" })
      .then(zarr.get),
  ]);

  const ncells = voc.shape[1];

  const verts = new Float32Array(ncells * 3 * 3);

  const vs0 = (voc.data as Int32Array).slice(ncells * 0, ncells * 1);
  const vs1 = (voc.data as Int32Array).slice(ncells * 1, ncells * 2);
  const vs2 = (voc.data as Int32Array).slice(ncells * 2, ncells * 3);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();

  for (let i = 0; i < ncells; i++) {
    const v0 = vs0[i] - 1;
    const v1 = vs1[i] - 1;
    const v2 = vs2[i] - 1;

    // Cache vertex values
    const v0x = (vx.data as Float64Array)[v0],
      v0y = (vy.data as Float64Array)[v0],
      v0z = (vz.data as Float64Array)[v0];
    let v1x = (vx.data as Float64Array)[v1] as number,
      v1y = (vy.data as Float64Array)[v1] as number,
      v1z = (vz.data as Float64Array)[v1] as number;
    let v2x = (vx.data as Float64Array)[v2] as number,
      v2y = (vy.data as Float64Array)[v2] as number,
      v2z = (vz.data as Float64Array)[v2] as number;

    // Set vector values
    a.set(v0x, v0y, v0z);
    b.set(v1x, v1y, v1z);
    c.set(v2x, v2y, v2z);

    // Perform in-place operations
    ab.subVectors(b, a);
    ac.subVectors(c, a);

    if (ab.cross(ac).dot(a.add(b).add(c)) < 0) {
      [v1x, v2x] = [v2x, v1x];
      [v1y, v2y] = [v2y, v1y];
      [v1z, v2z] = [v2z, v1z];
    }

    // Set verts array values
    const baseIndex = 9 * i;
    verts[baseIndex + 0] = v0x;
    verts[baseIndex + 1] = v0y;
    verts[baseIndex + 2] = v0z;

    verts[baseIndex + 3] = v1x;
    verts[baseIndex + 4] = v1y;
    verts[baseIndex + 5] = v1z;

    verts[baseIndex + 6] = v2x;
    verts[baseIndex + 7] = v2y;
    verts[baseIndex + 8] = v2z;
  }

  return verts;
}

export function data2valueBuffer(
  data: zarr.Chunk<zarr.DataType>,
  datavar: zarr.Array<zarr.DataType, zarr.FetchStore>
) {
  const awaitedData = data;
  const ncells = awaitedData.shape[0];
  const plotdata = castDataVarToFloat32(awaitedData.data);

  const { min, max, missingValue, fillValue } = getDataBounds(
    datavar,
    plotdata
  );
  const dataValues = new Float32Array(ncells * 3);

  for (let i = 0; i < ncells; i++) {
    const v = plotdata[i];
    const baseIndex = 3 * i;
    dataValues[baseIndex + 0] = v;
    dataValues[baseIndex + 1] = v;
    dataValues[baseIndex + 2] = v;
  }
  return {
    dataValues: dataValues,
    dataMin: min,
    dataMax: max,
    missingValue,
    fillValue,
  };
}
