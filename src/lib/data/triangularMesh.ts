import type * as zarr from "zarrita";

import { isLatitudeName, isLongitudeName } from "./coordinateVariables.ts";
import { decodeVariableChunkInPlace } from "./variableDecoding.ts";
import { ZarrDataManager } from "./ZarrDataManager.ts";

import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";

const MeshLocation = { NODE: "node", FACE: "face" } as const;

type TArray = zarr.Array<zarr.DataType, zarr.AsyncReadable>;

export type TTriangularMesh = {
  connectivity: TArray;
  latitude: TArray;
  longitude: TArray;
  faceAxis: number;
  startIndex: number;
  spatialDimension: string;
  nodeData: boolean;
};

async function getNodeCoordinates(
  names: string[],
  read: (name: string) => Promise<TArray>
) {
  const coordinates = await Promise.all(names.map(read));
  const latitude = coordinates.find(
    (array, i) =>
      array.attrs.standard_name === "latitude" ||
      /degrees?_?(N|north)/.test(String(array.attrs.units)) ||
      isLatitudeName(names[i])
  );
  const longitude = coordinates.find(
    (array, i) =>
      array.attrs.standard_name === "longitude" ||
      /degrees?_?(E|east)/.test(String(array.attrs.units)) ||
      isLongitudeName(names[i])
  );
  if (
    !latitude ||
    !longitude ||
    latitude.shape.length !== 1 ||
    longitude.shape.length !== 1 ||
    latitude.shape[0] !== longitude.shape[0] ||
    latitude.dimensionNames?.[0] !== longitude.dimensionNames?.[0]
  ) {
    return null;
  }
  return { latitude, longitude };
}

export async function getTriangularMesh(
  sources: TSources,
  variable: string
): Promise<TTriangularMesh | null> {
  const data = await ZarrDataManager.getVariableInfoByDatasetSources(
    sources,
    variable
  );
  let context = variable;
  const read = (name: string) =>
    ZarrDataManager.getVariableInfo(
      sources.levels[0].grid,
      ZarrDataManager.resolveVariablePath(context, name),
      sources.zarr_format
    );
  const mesh =
    typeof data.attrs.mesh === "string" ? await read(data.attrs.mesh) : null;
  if (
    mesh &&
    (mesh.attrs.cf_role !== "mesh_topology" ||
      mesh.attrs.topology_dimension !== 2)
  ) {
    return null;
  }
  context = mesh
    ? ZarrDataManager.resolveVariablePath(variable, String(data.attrs.mesh))
    : variable;
  const topology = await getConnectivity(mesh, read);
  if (!topology) {
    return null;
  }
  const { connectivity, faceAxis, faceDimension } = topology;
  const coordinates = await getNodeCoordinates(
    String(mesh ? (mesh.attrs.node_coordinates ?? "") : "lon lat")
      .trim()
      .split(/\s+/),
    read
  );
  if (!coordinates) {
    return null;
  }
  return describeMesh(
    data,
    mesh,
    connectivity,
    coordinates,
    faceAxis,
    String(faceDimension)
  );
}

async function getConnectivity(
  mesh: TArray | null,
  read: (name: string) => Promise<TArray>
) {
  const connectivityName = mesh ? mesh.attrs.face_node_connectivity : "nv";
  if (typeof connectivityName !== "string") {
    return null;
  }
  const connectivity = await read(connectivityName);
  const faceDimension =
    mesh?.attrs.face_dimension ??
    (mesh ? connectivity.dimensionNames?.[0] : "nele");
  const faceAxis =
    connectivity.dimensionNames?.indexOf(String(faceDimension)) ?? -1;
  // ponytail: only triangular 2D meshes; polygons need triangulation and a face mapping.
  if (
    connectivity.shape.length !== 2 ||
    faceAxis < 0 ||
    connectivity.shape[1 - faceAxis] !== 3
  ) {
    return null;
  }
  return { connectivity, faceAxis, faceDimension };
}

function describeMesh(
  data: TArray,
  mesh: TArray | null,
  connectivity: TArray,
  coordinates: { latitude: TArray; longitude: TArray },
  faceAxis: number,
  faceDimension: string
): TTriangularMesh | null {
  const nodeDimension = coordinates.latitude.dimensionNames?.[0];
  const nodeData = mesh
    ? data.attrs.location === MeshLocation.NODE
    : data.dimensionNames?.includes(nodeDimension!) === true;
  if (
    mesh &&
    data.attrs.location !== MeshLocation.NODE &&
    data.attrs.location !== MeshLocation.FACE
  ) {
    return null;
  }
  const spatialDimension = nodeData ? nodeDimension : String(faceDimension);
  if (!spatialDimension || !data.dimensionNames?.includes(spatialDimension)) {
    return null;
  }
  const startIndex = Number(connectivity.attrs.start_index ?? (mesh ? 0 : 1));
  if (startIndex !== 0 && startIndex !== 1) {
    throw new Error("Mesh connectivity start_index must be 0 or 1.");
  }
  return {
    connectivity,
    ...coordinates,
    faceAxis,
    startIndex,
    spatialDimension,
    nodeData,
  };
}

export async function loadTriangularMesh(mesh: TTriangularMesh) {
  const [connectivity, latitude, longitude] = await Promise.all(
    [mesh.connectivity, mesh.latitude, mesh.longitude].map((array) =>
      ZarrDataManager.getVariableDataFromArray(array)
    )
  );
  decodeVariableChunkInPlace(latitude, mesh.latitude.attrs);
  decodeVariableChunkInPlace(longitude, mesh.longitude.attrs);
  const nodeCount = mesh.latitude.shape[0];
  const faceCount = connectivity.shape[mesh.faceAxis];
  const vertexOfCell = new Int32Array(faceCount * 3);
  for (let corner = 0; corner < 3; corner++) {
    for (let face = 0; face < faceCount; face++) {
      const offset =
        face * connectivity.stride[mesh.faceAxis] +
        corner * connectivity.stride[1 - mesh.faceAxis];
      const value = Number((connectivity.data as ArrayLike<number>)[offset]);
      const index = value - mesh.startIndex;
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= nodeCount ||
        value === mesh.connectivity.attrs._FillValue
      ) {
        throw new Error(`Invalid triangular mesh node index: ${value}.`);
      }
      vertexOfCell[corner * faceCount + face] = index + 1;
    }
  }
  const vertexX = new Float64Array(nodeCount);
  const vertexY = new Float64Array(nodeCount);
  const vertexZ = new Float64Array(nodeCount);
  const projection = new ProjectionHelper(
    PROJECTION_TYPES.NEARSIDE_PERSPECTIVE,
    { lat: 0, lon: 0 }
  );
  for (let node = 0; node < nodeCount; node++) {
    const lat = Number((latitude.data as ArrayLike<number>)[node]);
    const lon = Number((longitude.data as ArrayLike<number>)[node]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) {
      throw new Error(`Invalid mesh coordinates at node ${node}.`);
    }
    [vertexX[node], vertexY[node], vertexZ[node]] = projection.project(
      lat,
      lon
    );
  }
  return { vertexOfCell, vertexX, vertexY, vertexZ, nodeData: mesh.nodeData };
}
