import * as THREE from "three";
import type { Group, NestedArray, TypedArray, ZarrArray } from "zarr";
import type { RawArray } from "zarr/types/rawArray";

export async function grid2buffer(grid: Group<RequestInit>) {
  const [voc, vx, vy, vz] = await Promise.all([
    grid
      .getItem("vertex_of_cell")
      .then(
        (a) =>
          (a as ZarrArray<RequestInit>).get() as Promise<
            NestedArray<TypedArray>
          >
      ),
    grid
      .getItem("cartesian_x_vertices")
      .then((a) => (a as ZarrArray<RequestInit>).get())
      .then((a) => (a as NestedArray<TypedArray>).data),
    grid
      .getItem("cartesian_y_vertices")
      .then((a) => (a as ZarrArray<RequestInit>).get())
      .then((a) => (a as NestedArray<TypedArray>).data),
    grid
      .getItem("cartesian_z_vertices")
      .then((a) => (a as ZarrArray<RequestInit>).get())
      .then((a) => (a as NestedArray<TypedArray>).data),
  ]);

  const ncells = voc.shape[1];

  const verts = new Float32Array(ncells * 3 * 3);

  const vs0 = (voc.get(0) as NestedArray<Float32Array>).data as Float32Array;
  const vs1 = (voc.get(1) as NestedArray<Float32Array>).data as Float32Array;
  const vs2 = (voc.get(2) as NestedArray<Float32Array>).data as Float32Array;

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
    const v0x = vx[v0] as number,
      v0y = vy[v0] as number,
      v0z = vz[v0] as number;
    let v1x = vx[v1] as number,
      v1y = vy[v1] as number,
      v1z = vz[v1] as number;
    let v2x = vx[v2] as number,
      v2y = vy[v2] as number,
      v2z = vz[v2] as number;

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

export function data2valueBuffer(data: RawArray) {
  const awaitedData = data;
  const ncells = awaitedData.shape[0];
  const plotdata = awaitedData.data;

  let dataMin = Number.POSITIVE_INFINITY;
  let dataMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < ncells; i++) {
    const v = plotdata[i];
    if (v < dataMin) dataMin = v;
    if (v > dataMax) dataMax = v;
  }

  const dataValues = new Float32Array(ncells * 3);

  for (let i = 0; i < ncells; i++) {
    const v = plotdata[i];
    const baseIndex = 3 * i;
    dataValues[baseIndex + 0] = v;
    dataValues[baseIndex + 1] = v;
    dataValues[baseIndex + 2] = v;
  }
  return { dataValues: dataValues, dataMin: dataMin, dataMax: dataMax };
}

/*
async function data2color_buffer(data, colormap) {
  data = await data;
  const ncells = data.shape[0];
  const plotdata = await data.data;

  let data_min = Number.POSITIVE_INFINITY;
  let data_max = Number.NEGATIVE_INFINITY;
  for (var i = 0; i < ncells; i++) {
    const v = plotdata[i];
    if (v < data_min) data_min = v;
    if (v > data_max) data_max = v;
  }

  let norm;
  if (colormap.endsWith("_r")) {
    colormap = colormap.substring(0, colormap.length - 2);
    norm = (d) => 1 - (d - data_min) / (data_max - data_min);
  } else {
    norm = (d) => (d - data_min) / (data_max - data_min);
  }

  const colors = cm_data[colormap]["colors"];

  let color = new Float32Array(ncells * 3 * 3);

  for (var i = 0; i < ncells; i++) {
    const [r, g, b] = interpolated(norm(plotdata[i]), colors);

    color[9 * i + 0] = r;
    color[9 * i + 1] = g;
    color[9 * i + 2] = b;

    color[9 * i + 3] = r;
    color[9 * i + 4] = g;
    color[9 * i + 5] = b;

    color[9 * i + 6] = r;
    color[9 * i + 7] = g;
    color[9 * i + 8] = b;
  }

  return color;
}
*/
