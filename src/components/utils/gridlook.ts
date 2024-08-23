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

  const vs0 = (voc.get(0) as NestedArray<TypedArray>).data;
  const vs1 = (voc.get(1) as NestedArray<TypedArray>).data;
  const vs2 = (voc.get(2) as NestedArray<TypedArray>).data;

  for (let i = 0; i < ncells; i++) {
    const v0 = (vs0[i] as number) - 1;
    let v1 = (vs1[i] as number) - 1;
    let v2 = (vs2[i] as number) - 1;

    const a = new THREE.Vector3(
      vx[v0] as number,
      vy[v0] as number,
      vz[v0] as number
    );
    const b = new THREE.Vector3(
      vx[v1] as number,
      vy[v1] as number,
      vz[v1] as number
    );
    const c = new THREE.Vector3(
      vx[v2] as number,
      vy[v2] as number,
      vz[v2] as number
    );

    if (b.sub(a).cross(c.sub(a)).dot(a.add(b).add(c)) < 0) {
      [v1, v2] = [v2, v1];
    }

    verts[9 * i + 0] = vx[v0] as number;
    verts[9 * i + 1] = vy[v0] as number;
    verts[9 * i + 2] = vz[v0] as number;

    verts[9 * i + 3] = vx[v1] as number;
    verts[9 * i + 4] = vy[v1] as number;
    verts[9 * i + 5] = vz[v1] as number;

    verts[9 * i + 6] = vx[v2] as number;
    verts[9 * i + 7] = vy[v2] as number;
    verts[9 * i + 8] = vz[v2] as number;
  }

  return verts;
}

export function data2valueBuffer(data: RawArray) {
  const awaitedData = data;
  const ncells = awaitedData.shape[0];
  const plotdata = awaitedData.data;

  let data_min = Number.POSITIVE_INFINITY;
  let data_max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < ncells; i++) {
    const v = plotdata[i];
    if (v < data_min) data_min = v;
    if (v > data_max) data_max = v;
  }

  const data_values = new Float32Array(ncells * 3);

  for (let i = 0; i < ncells; i++) {
    const v = plotdata[i];
    data_values[3 * i + 0] = v;
    data_values[3 * i + 1] = v;
    data_values[3 * i + 2] = v;
  }
  return { data_values, data_min, data_max };
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
