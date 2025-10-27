import * as THREE from "three";
import * as d3 from "d3-geo";
import albedo from "../../assets/earth.jpg";
import { LAND_SEA_MASK_MODES, type TLandSeaMaskMode } from "../store/store";

// Simple in-memory cache for loaded images. Stores the load Promise so
// concurrent requests for the same URL share the same network request.
const imageCache: Map<string, Promise<HTMLImageElement>> = new Map();

async function loadImage(url: string): Promise<HTMLImageElement> {
  const existing = imageCache.get(url);
  if (existing) return existing;

  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const loader = new Image();
    // avoid tainting canvases when possible
    loader.crossOrigin = "anonymous";
    loader.src = url;
    loader.onload = () => resolve(loader);
    loader.onerror = (e) => {
      // remove from cache on error so future attempts can retry
      imageCache.delete(url);
      reject(e);
    };
  });

  imageCache.set(url, p);
  return p;
}

// Simple cache for fetched JSON (geojson) resources. Stores the fetch+json
// Promise so concurrent requests for the same URL share a single network
// request and parse.
const jsonCache: Map<
  string,
  Promise<
    GeoJSON.FeatureCollection<GeoJSON.Geometry, GeoJSON.GeoJsonProperties>
  >
> = new Map();

export async function loadJSON(
  url: string
): Promise<
  GeoJSON.FeatureCollection<GeoJSON.Geometry, GeoJSON.GeoJsonProperties>
> {
  const existing = jsonCache.get(url);
  if (existing) return existing;

  const p = fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
    return (await r.json()) as GeoJSON.FeatureCollection<
      GeoJSON.Geometry,
      GeoJSON.GeoJsonProperties
    >;
  });

  // if the promise rejects, remove from cache so retries are possible
  p.catch(() => jsonCache.delete(url));
  jsonCache.set(url, p);
  return p;
}

// Utility function to create canvas with standard dimensions
function createStandardCanvas() {
  //const width = 8192;
  //const height = 4096;
  const width = 4096;
  const height = 2048;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, width, height);
  return { canvas, ctx, width, height };
}

// Utility function to load land GeoJSON and create projection
async function createLandProjection(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
) {
  const land = await loadJSON("static/ne_50m_land.geojson");
  const projection = d3
    .geoEquirectangular()
    .translate([width / 2, height / 2])
    .scale(width / (2 * Math.PI));
  const path = d3.geoPath(projection, ctx);
  return { land, path };
}

// Utility function to create sphere mesh
function createSphereMesh(
  texture: THREE.CanvasTexture,
  radius: number,
  transparent = true
) {
  const geometry = new THREE.SphereGeometry(radius, 128, 64);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent,
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "mask";
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

/**
 * Get the land sea mask THREE.Mesh by using a texture (blue marble). If the mask does not exist, create it.
 * If invert is true, the land will be grey and the sea will be transparent.
 * If invert is false, the sea will be grey and the land will be transparent.
 * @returns {Promise<THREE.Mesh>} - A promise resolving to a THREE.Mesh containing the land sea mask
 */
async function getTexturedLandSeaMask({ invert = false } = {}) {
  const { canvas, ctx, width, height } = createStandardCanvas();

  // Load and draw base JPG (cached)
  const img = await loadImage(albedo);
  ctx.drawImage(img, 0, 0, width, height);

  // Setup land projection and masking
  const { land, path } = await createLandProjection(ctx, width, height);
  ctx.beginPath();
  path(land);
  ctx.globalCompositeOperation = invert ? "destination-in" : "destination-out";
  ctx.fill();

  // Create texture and mesh
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  return createSphereMesh(texture, 1.002);
}

async function getGlobeTexture() {
  // Show the full globe texture, no geojson masking, radius 0.9999
  const radius = 0.99;
  const geometry = new THREE.SphereGeometry(radius, 128, 64);
  const img = await loadImage(albedo);
  const texture = new THREE.Texture(img);
  texture.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: false,
    side: THREE.FrontSide,
  });
  const landSeaMask = new THREE.Mesh(geometry, material);
  landSeaMask.name = "globe_texture";
  landSeaMask.rotation.x = Math.PI / 2;
  return landSeaMask;
}

/**
 * Create a grey mask to be used with the globe.
 * If invert is true, the land will be grey and the sea will be transparent.
 * If invert is false, the sea will be grey and the land will be transparent.
 *
 * @param {Object} [options] - Options to be passed to the function
 * @param {boolean} [options.invert=false] - Whether to invert the mask
 * @returns {Promise<THREE.Mesh>} - A promise resolving to a THREE.Mesh containing the grey mask
 */
async function getSolidMask({ invert = false } = {}) {
  const { canvas, ctx, width, height } = createStandardCanvas();
  const { land, path } = await createLandProjection(ctx, width, height);

  ctx.globalAlpha = 1;
  if (!invert) {
    // Sea grey: fill all, then cut out land
    ctx.fillStyle = "#3c78c8ff"; // solid blue
    ctx.fillRect(0, 0, width, height);
  }
  {
    ctx.fillStyle = "#888";
  }
  ctx.save();
  ctx.beginPath();
  path(land);
  ctx.globalCompositeOperation = invert ? "source-over" : "destination-out";
  ctx.fill();
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 16;
  texture.needsUpdate = true;

  return createSphereMesh(texture, 1.002);
}

async function getSolidColoredGlobe() {
  // Globe colored: solid blue ocean, grey land. Use radius 0.9999
  const radius = 0.999;
  const width = 4096;
  const height = 2048;

  // prepare canvas (no base texture)
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, width, height);

  // fill ocean with solid blue
  ctx.fillStyle = "#3c78c8ff"; // solid blue
  ctx.fillRect(0, 0, width, height);

  // load land geojson and draw land as grey on top
  const land = await loadJSON("static/ne_50m_land.geojson");
  const projection = d3
    .geoEquirectangular()
    .translate([width / 2, height / 2])
    .scale(width / (2 * Math.PI));
  const path = d3.geoPath(projection, ctx);
  ctx.beginPath();
  path(land);
  ctx.fillStyle = "#888";
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 16;
  texture.needsUpdate = true;

  const geometry = new THREE.SphereGeometry(radius, 128, 64);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: false,
    side: THREE.FrontSide,
  });
  const landSeaMask = new THREE.Mesh(geometry, material);
  landSeaMask.name = "mask";
  landSeaMask.rotation.x = Math.PI / 2;
  return landSeaMask;
}

export async function getLandSeaMask(
  landSeaMaskChoice: TLandSeaMaskMode,
  landSeaMaskUseTexture: boolean
) {
  let landSeaMask: THREE.Mesh | undefined = undefined;
  // Determine effective mode from simplified choice and texture flag
  const choice = landSeaMaskChoice ?? LAND_SEA_MASK_MODES.OFF;
  const useTexture = landSeaMaskUseTexture ?? true;
  let mode: TLandSeaMaskMode = LAND_SEA_MASK_MODES.OFF;

  if (choice === LAND_SEA_MASK_MODES.OFF) {
    mode = LAND_SEA_MASK_MODES.OFF;
  } else if (choice === LAND_SEA_MASK_MODES.SEA) {
    mode = useTexture ? LAND_SEA_MASK_MODES.SEA : LAND_SEA_MASK_MODES.SEA_GREY;
  } else if (choice === LAND_SEA_MASK_MODES.LAND) {
    mode = useTexture
      ? LAND_SEA_MASK_MODES.LAND
      : LAND_SEA_MASK_MODES.LAND_GREY;
  } else if (choice === LAND_SEA_MASK_MODES.GLOBE) {
    mode = useTexture
      ? LAND_SEA_MASK_MODES.GLOBE
      : LAND_SEA_MASK_MODES.GLOBE_COLORED;
  }
  if (mode === LAND_SEA_MASK_MODES.OFF) {
    return undefined;
  }

  // Helper for grey mask
  try {
    const maskConfig = {
      [LAND_SEA_MASK_MODES.SEA]: () =>
        getTexturedLandSeaMask({ invert: false }),
      [LAND_SEA_MASK_MODES.LAND]: () =>
        getTexturedLandSeaMask({ invert: true }),
      [LAND_SEA_MASK_MODES.SEA_GREY]: () => getSolidMask({ invert: false }),
      [LAND_SEA_MASK_MODES.LAND_GREY]: () => getSolidMask({ invert: true }),
      [LAND_SEA_MASK_MODES.GLOBE]: () => getGlobeTexture(),
      [LAND_SEA_MASK_MODES.GLOBE_COLORED]: () => getSolidColoredGlobe(),
    };

    const maskFactory = maskConfig[mode];
    if (maskFactory) {
      landSeaMask = await maskFactory();
      return landSeaMask;
    }
  } catch (e) {
    console.error("Failed to update land/sea mask:", e);
  }
  return undefined;
}
