import * as d3 from "d3-geo";
import { geoRobinson, geoMollweide } from "d3-geo-projection";
import * as THREE from "three";

import albedo from "../../assets/earth.jpg";
import { LAND_SEA_MASK_MODES, type TLandSeaMaskMode } from "../store/store";

import { PROJECTION_TYPES, ProjectionHelper } from "./projectionUtils";

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

function determineEffectiveMode(
  choice: TLandSeaMaskMode,
  useTexture: boolean
): TLandSeaMaskMode {
  if (choice === LAND_SEA_MASK_MODES.OFF) {
    return LAND_SEA_MASK_MODES.OFF;
  }

  const modeMap: Record<
    string,
    { textured: TLandSeaMaskMode; plain: TLandSeaMaskMode }
  > = {
    [LAND_SEA_MASK_MODES.SEA]: {
      textured: LAND_SEA_MASK_MODES.SEA,
      plain: LAND_SEA_MASK_MODES.SEA_GREY,
    },
    [LAND_SEA_MASK_MODES.LAND]: {
      textured: LAND_SEA_MASK_MODES.LAND,
      plain: LAND_SEA_MASK_MODES.LAND_GREY,
    },
    [LAND_SEA_MASK_MODES.GLOBE]: {
      textured: LAND_SEA_MASK_MODES.GLOBE,
      plain: LAND_SEA_MASK_MODES.GLOBE_COLORED,
    },
  };

  const mapping = modeMap[choice];
  return mapping ? (useTexture ? mapping.textured : mapping.plain) : choice;
}

export type TProjectedBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

function computeProjectedGeoBounds(
  geojson:
    | GeoJSON.FeatureCollection<GeoJSON.Geometry, GeoJSON.GeoJsonProperties>
    | GeoJSON.GeometryCollection
    | GeoJSON.Geometry,
  helper: ProjectionHelper
): TProjectedBounds | undefined {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const update = (lon: number, lat: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const normalizedLon = helper.normalizeLongitude(lon);
    const [x, y] = helper.project(lat, normalizedLon);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };

  const walkCoords = (coords: unknown) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number") {
      const [lon, lat] = coords as number[];
      update(lon, lat);
    } else {
      for (const c of coords) {
        walkCoords(c);
      }
    }
  };

  const walkGeometry = (geom: GeoJSON.Geometry) => {
    switch (geom.type) {
      case "Point":
        walkCoords(geom.coordinates);
        break;
      case "MultiPoint":
      case "LineString":
      case "MultiLineString":
      case "Polygon":
      case "MultiPolygon":
        walkCoords(geom.coordinates);
        break;
      case "GeometryCollection":
        for (const g of geom.geometries) {
          walkGeometry(g);
        }
        break;
    }
  };

  if ("type" in geojson && geojson.type === "FeatureCollection") {
    for (const f of geojson.features) {
      if (f.geometry) {
        walkGeometry(f.geometry);
      }
    }
  } else if ("type" in geojson && geojson.type === "GeometryCollection") {
    for (const g of geojson.geometries) {
      walkGeometry(g);
    }
  } else if ("type" in geojson) {
    walkGeometry(geojson as GeoJSON.Geometry);
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxY)
  ) {
    return undefined;
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  return {
    minX,
    maxX,
    minY,
    maxY,
    width,
    height,
    centerX,
    centerY,
  };
}

// Utility function to create canvas with standard dimensions
function createStandardCanvas(width = 4096, height = 2048) {
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

// Create a d3 projection matching our projection helper type exactly.
// This must use the same scale(1), translate([0,0]) setup as projectionUtils.ts
// to ensure the mask aligns perfectly with the data.
function createD3Projection(helper: ProjectionHelper): d3.GeoProjection {
  let projection: d3.GeoProjection;

  switch (helper.type) {
    case PROJECTION_TYPES.MERCATOR:
      projection = d3.geoMercator();
      break;
    case PROJECTION_TYPES.ROBINSON:
      projection = geoRobinson();
      break;
    case PROJECTION_TYPES.MOLLWEIDE:
      projection = geoMollweide();
      break;
    default:
      projection = d3.geoEquirectangular();
  }

  // Match projectionUtils.ts exactly: scale(1), translate([0,0]), then rotate
  // The data projection uses these parameters, so the mask must too.
  projection
    .translate([0, 0])
    .scale(1)
    .rotate([-helper.center.lon, -helper.center.lat]);

  // Now we need to transform from the projection's output coordinates
  // to canvas coordinates. The bounds are in Three.js coordinates where
  // y is negated from d3's output (see projectionUtils.ts: return [x * radius, -y * radius, 0])
  //
  // We'll apply a post-projection transform to map to canvas space:
  // - d3 outputs (x, y_d3)
  // - Three.js uses y_three = -y_d3
  // - bounds.minX/maxX/minY/maxY are in Three.js space
  // - Canvas y=0 is top, y=height is bottom
  //
  // Mapping:
  // canvasX = (x - bounds.minX) / bounds.width * canvasWidth
  // canvasY = (bounds.maxY - y_three) / bounds.height * canvasHeight
  //         = (bounds.maxY - (-y_d3)) / bounds.height * canvasHeight
  //         = (bounds.maxY + y_d3) / bounds.height * canvasHeight

  // Return the base projection - we'll apply the transform in the drawing functions
  // via createCanvasPath which uses a geoTransform to map projected coords to canvas
  return projection;
}

// Transform projected coordinates to canvas coordinates
function projectToCanvas(
  x: number,
  y: number,
  bounds: TProjectedBounds,
  canvasWidth: number,
  canvasHeight: number
): [number, number] {
  // x is as-is from d3 projection
  // y from d3 is negated in Three.js (y_three = -y_d3), so bounds are in Three.js space
  // Canvas y=0 is top, so we flip
  const canvasX = ((x - bounds.minX) / bounds.width) * canvasWidth;
  // y_d3 corresponds to -y_three, so: canvasY = (bounds.maxY - (-y_d3)) / height * canvasHeight
  const canvasY = ((bounds.maxY + y) / bounds.height) * canvasHeight;
  return [canvasX, canvasY];
}

// Create a d3 path generator that transforms coordinates to canvas space
function createCanvasPath(
  projection: d3.GeoProjection,
  ctx: CanvasRenderingContext2D,
  bounds: TProjectedBounds,
  canvasWidth: number,
  canvasHeight: number
): d3.GeoPath {
  // Create a custom stream transform that maps projected coords to canvas coords
  const transform = d3.geoTransform({
    point: function (lon: number, lat: number) {
      const projected = projection([lon, lat]);
      if (projected) {
        const [cx, cy] = projectToCanvas(
          projected[0],
          projected[1],
          bounds,
          canvasWidth,
          canvasHeight
        );
        this.stream.point(cx, cy);
      }
    },
  });

  return d3.geoPath(transform, ctx);
}

// Create a d3 projection that maps directly to canvas coordinates
// This is needed for drawing the sphere outline (which requires a proper projection, not geoTransform)
function createCanvasProjection(
  helper: ProjectionHelper,
  bounds: TProjectedBounds,
  canvasWidth: number,
  canvasHeight: number
): d3.GeoProjection {
  let projection: d3.GeoProjection;

  switch (helper.type) {
    case PROJECTION_TYPES.MERCATOR:
      projection = d3.geoMercator();
      break;
    case PROJECTION_TYPES.ROBINSON:
      projection = geoRobinson();
      break;
    case PROJECTION_TYPES.MOLLWEIDE:
      projection = geoMollweide();
      break;
    default:
      projection = d3.geoEquirectangular();
  }

  // Start with same parameters as data projection
  projection.rotate([-helper.center.lon, -helper.center.lat]);

  // Increase precision for smoother sphere outline (lower value = more segments)
  projection.precision(0.01);

  // Now apply scale and translate to map to canvas coordinates
  // The base projection (scale=1, translate=[0,0]) outputs (x, y_d3)
  // We need: canvasX = (x - bounds.minX) / bounds.width * canvasWidth
  //          canvasY = (bounds.maxY + y_d3) / bounds.height * canvasHeight
  //
  // d3 projection applies: output = project(input) * scale + translate
  // So: canvasX = x * scaleX + translateX
  //     canvasY = y * scaleY + translateY
  // Where: scaleX = canvasWidth / bounds.width
  //        translateX = -bounds.minX * scaleX
  //        scaleY = canvasHeight / bounds.height
  //        translateY = bounds.maxY * scaleY
  //
  // Since d3 uses uniform scale, we need to use a custom approach
  // by modifying the projection with a post-transform

  const scaleX = canvasWidth / bounds.width;
  const scaleY = canvasHeight / bounds.height;
  const translateX = -bounds.minX * scaleX;
  const translateY = bounds.maxY * scaleY;

  // Use scale(1) initially, then wrap with a stream transform
  projection.translate([0, 0]).scale(1);

  // Create a modified projection that applies our non-uniform transform
  const originalStream = projection.stream.bind(projection);

  // Override the stream to apply our transform
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (projection as any).stream = (s: d3.GeoStream) => {
    return originalStream({
      point(x: number, y: number) {
        s.point(x * scaleX + translateX, y * scaleY + translateY);
      },
      lineStart() {
        s.lineStart();
      },
      lineEnd() {
        s.lineEnd();
      },
      polygonStart() {
        s.polygonStart();
      },
      polygonEnd() {
        s.polygonEnd();
      },
      sphere() {
        s.sphere?.();
      },
    });
  };

  return projection;
}

// Rasterize land/sea mask for flat projections using canvas
async function createFlatMaskCanvas(
  helper: ProjectionHelper,
  mode: TLandSeaMaskMode,
  useTexture: boolean,
  canvasWidth: number,
  canvasHeight: number,
  bounds: TProjectedBounds
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d")!;

  // Create matching d3 projection with same parameters as data projection
  const projection = createD3Projection(helper);
  // Create path generator that transforms to canvas coordinates
  const path = createCanvasPath(
    projection,
    ctx,
    bounds,
    canvasWidth,
    canvasHeight
  );

  // Create a projection that maps directly to canvas coordinates for drawing the sphere outline
  const canvasProjection = createCanvasProjection(
    helper,
    bounds,
    canvasWidth,
    canvasHeight
  );
  const spherePath = d3.geoPath(canvasProjection, ctx);

  // Load land geojson
  const land = await loadJSON("static/ne_50m_land.geojson");

  // Define colors based on mode
  const isTextured = useTexture;
  const landColor = isTextured
    ? "rgba(196, 196, 196, 0.8)"
    : "rgba(136, 136, 136, 0.8)";
  const seaColor = "rgba(60, 120, 200, 0.7)";

  // Clear canvas (transparent background)
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  const showLand =
    mode === LAND_SEA_MASK_MODES.LAND ||
    mode === LAND_SEA_MASK_MODES.LAND_GREY ||
    mode === LAND_SEA_MASK_MODES.GLOBE ||
    mode === LAND_SEA_MASK_MODES.GLOBE_COLORED;

  const showSea =
    mode === LAND_SEA_MASK_MODES.SEA ||
    mode === LAND_SEA_MASK_MODES.SEA_GREY ||
    mode === LAND_SEA_MASK_MODES.GLOBE ||
    mode === LAND_SEA_MASK_MODES.GLOBE_COLORED;

  // Set up clipping to the projection outline (e.g., ellipse for Mollweide)
  const sphere: d3.GeoSphere = { type: "Sphere" };
  ctx.save();
  ctx.beginPath();
  spherePath(sphere);
  ctx.clip();

  // For flat projections, we fill the canvas as the background (clipped to projection shape)
  if (showSea) {
    // Fill entire canvas with sea color as background (will be clipped)
    ctx.fillStyle = seaColor;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // If sea-only mode, cut out the land areas
    if (!showLand) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      path(land);
      ctx.fillStyle = "black";
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    }
  }

  if (showLand) {
    // Draw land on top
    ctx.beginPath();
    path(land);
    ctx.fillStyle = landColor;
    ctx.fill();
  }

  // Restore context (removes clipping)
  ctx.restore();

  return canvas;
}

// Create a textured mask canvas for flat projections (with earth texture)
async function createFlatTexturedMaskCanvas(
  helper: ProjectionHelper,
  mode: TLandSeaMaskMode,
  canvasWidth: number,
  canvasHeight: number,
  bounds: TProjectedBounds
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d")!;

  // Create matching d3 projection with same parameters as data projection
  const projection = createD3Projection(helper);

  // Load resources
  const [land, img] = await Promise.all([
    loadJSON("static/ne_50m_land.geojson"),
    loadImage(albedo),
  ]);

  // Create a temporary canvas for the equirectangular texture at higher resolution
  const texWidth = 4096;
  const texHeight = 2048;
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = texWidth;
  tempCanvas.height = texHeight;
  const tempCtx = tempCanvas.getContext("2d")!;
  tempCtx.drawImage(img, 0, 0, texWidth, texHeight);

  // Clear main canvas
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // For textured mode, we need to sample from the texture for each pixel
  // within the projection bounds. We'll use a different approach:
  // Rasterize by sampling lat/lon for each pixel and looking up texture color

  const imageData = ctx.createImageData(canvasWidth, canvasHeight);
  const textureData = tempCtx.getImageData(0, 0, texWidth, texHeight);

  const showLand =
    mode === LAND_SEA_MASK_MODES.LAND || mode === LAND_SEA_MASK_MODES.GLOBE;

  const showSea =
    mode === LAND_SEA_MASK_MODES.SEA || mode === LAND_SEA_MASK_MODES.GLOBE;

  // Create a projection that maps directly to canvas coordinates for clipping
  const canvasProjection = createCanvasProjection(
    helper,
    bounds,
    canvasWidth,
    canvasHeight
  );
  const spherePath = d3.geoPath(canvasProjection);

  // Create a sphere mask canvas to determine which pixels are inside the projection
  const sphereCanvas = document.createElement("canvas");
  sphereCanvas.width = canvasWidth;
  sphereCanvas.height = canvasHeight;
  const sphereCtx = sphereCanvas.getContext("2d")!;
  sphereCtx.clearRect(0, 0, canvasWidth, canvasHeight);
  const sphere: d3.GeoSphere = { type: "Sphere" };
  sphereCtx.beginPath();
  spherePath.context(sphereCtx)(sphere);
  sphereCtx.fillStyle = "white";
  sphereCtx.fill();
  const sphereMaskData = sphereCtx.getImageData(
    0,
    0,
    canvasWidth,
    canvasHeight
  );

  // For determining if a point is on land, we'll use a simpler canvas-based approach
  // Use the properly transformed path for land mask
  const landCanvas = document.createElement("canvas");
  landCanvas.width = canvasWidth;
  landCanvas.height = canvasHeight;
  const landCtx = landCanvas.getContext("2d")!;
  landCtx.clearRect(0, 0, canvasWidth, canvasHeight);
  const landPath = createCanvasPath(
    projection,
    landCtx,
    bounds,
    canvasWidth,
    canvasHeight
  );
  landCtx.beginPath();
  landPath(land);
  landCtx.fillStyle = "white";
  landCtx.fill();
  const landMaskData = landCtx.getImageData(0, 0, canvasWidth, canvasHeight);

  // For each canvas pixel, we need to find the corresponding lon/lat
  // Canvas pixel (cx, cy) maps to projected coords, then we invert to get lon/lat
  for (let cy = 0; cy < canvasHeight; cy++) {
    for (let cx = 0; cx < canvasWidth; cx++) {
      const idx = (cy * canvasWidth + cx) * 4;

      // Check if pixel is inside the projection sphere (for smooth clipping)
      const insideSphere = sphereMaskData.data[idx + 3] > 128;
      if (!insideSphere) continue;

      // Convert canvas coordinates back to projected coordinates
      // This is the inverse of projectToCanvas:
      // cx = ((x - bounds.minX) / bounds.width) * canvasWidth
      // cy = ((bounds.maxY + y) / bounds.height) * canvasHeight
      // So:
      // x = (cx / canvasWidth) * bounds.width + bounds.minX
      // y = (cy / canvasHeight) * bounds.height - bounds.maxY
      const projX = (cx / canvasWidth) * bounds.width + bounds.minX;
      const projY = (cy / canvasHeight) * bounds.height - bounds.maxY;

      // Invert projection to get lon/lat
      // Note: projY here is the d3 projection output (before negation for Three.js)
      const coords = projection.invert?.([projX, projY]);
      if (!coords) {
        // Outside projection
        continue;
      }

      const [lon, lat] = coords;
      if (!isFinite(lon) || !isFinite(lat)) continue;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

      // Check if point is on land
      const isLand = landMaskData.data[idx + 3] > 128;

      // Determine if we should show this pixel
      const shouldShow = (isLand && showLand) || (!isLand && showSea);
      if (!shouldShow) continue;

      // Sample from equirectangular texture
      const texX = Math.floor(((lon + 180) / 360) * texWidth);
      const texY = Math.floor(((90 - lat) / 180) * texHeight);
      const texIdx = (texY * texWidth + texX) * 4;

      imageData.data[idx] = textureData.data[texIdx];
      imageData.data[idx + 1] = textureData.data[texIdx + 1];
      imageData.data[idx + 2] = textureData.data[texIdx + 2];
      imageData.data[idx + 3] = 200; // Semi-transparent
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

// Create flat mask mesh from canvas texture
async function getFlatLandSeaMask({
  mode,
  useTexture,
  helper,
  bounds,
}: {
  mode: TLandSeaMaskMode;
  useTexture: boolean;
  helper: ProjectionHelper;
  bounds: TProjectedBounds;
}): Promise<THREE.Object3D | undefined> {
  if (mode === LAND_SEA_MASK_MODES.OFF) {
    return undefined;
  }

  const land = await loadJSON("static/ne_50m_land.geojson");
  const landProjectedBounds = computeProjectedGeoBounds(land, helper);
  const effectiveBounds = landProjectedBounds ?? bounds;

  // Calculate canvas dimensions with same aspect ratio as the Three.js bounds
  const geoWidth = effectiveBounds.width || 1;
  const geoHeight = effectiveBounds.height || 1;
  const aspectRatio = geoWidth / geoHeight;

  // Use a base resolution and adjust for aspect ratio
  const baseResolution = 2048;
  let canvasWidth: number;
  let canvasHeight: number;

  if (aspectRatio >= 1) {
    canvasWidth = baseResolution;
    canvasHeight = Math.round(baseResolution / aspectRatio);
  } else {
    canvasHeight = baseResolution;
    canvasWidth = Math.round(baseResolution * aspectRatio);
  }

  // Create the mask canvas based on mode
  let canvas: HTMLCanvasElement;

  if (
    useTexture &&
    (mode === LAND_SEA_MASK_MODES.SEA ||
      mode === LAND_SEA_MASK_MODES.LAND ||
      mode === LAND_SEA_MASK_MODES.GLOBE)
  ) {
    canvas = await createFlatTexturedMaskCanvas(
      helper,
      mode,
      canvasWidth,
      canvasHeight,
      effectiveBounds
    );
  } else {
    canvas = await createFlatMaskCanvas(
      helper,
      mode,
      useTexture,
      canvasWidth,
      canvasHeight,
      effectiveBounds
    );
  }

  // Create texture from canvas
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  // Create a plane that covers the entire bounds area
  // The canvas was created with the same aspect ratio and the d3 projection
  // fills it completely, so we use simple 1:1 UV mapping
  const geometry = new THREE.PlaneGeometry(geoWidth, geoHeight);

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "mask";
  mesh.position.set(effectiveBounds.centerX, effectiveBounds.centerY, 0.01);
  mesh.renderOrder = 10;

  return mesh;
}

// Utility function to create sphere mesh
function createSphereMesh(
  texture: THREE.CanvasTexture,
  radius: number,
  transparent = true
) {
  const geometry = new THREE.SphereGeometry(radius, 64, 64);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent,
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "mask";
  mesh.renderOrder = 1;
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

/**
 * Get the land sea mask THREE.Mesh by using a texture (blue marble). If the mask does not exist, create it.
 * If invert is true, the land will be grey and the sea will be transparent.
 * If invert is false, the sea will be grey and the land will be transparent.
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

/**
 * Create a grey mask to be used with the globe.
 * If invert is true, the land will be grey and the sea will be transparent.
 * If invert is false, the sea will be grey and the land will be transparent.
 */
async function getSolidLandSeaMask({ invert = false } = {}) {
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

async function getSolidGlobe() {
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

  const geometry = new THREE.SphereGeometry(radius, 64, 64);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: false,
    side: THREE.FrontSide,
  });
  const landSeaMask = new THREE.Mesh(geometry, material);
  landSeaMask.name = "mask";
  landSeaMask.rotation.x = Math.PI / 2;
  landSeaMask.renderOrder = 1;
  return landSeaMask;
}

async function getTexturedGlobe() {
  // Show the full globe texture, no geojson masking, radius 0.9999
  const radius = 0.999;
  const geometry = new THREE.SphereGeometry(radius, 64, 64);
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
  landSeaMask.renderOrder = 1;
  return landSeaMask;
}

export async function getLandSeaMask(
  landSeaMaskChoice: TLandSeaMaskMode,
  landSeaMaskUseTexture: boolean,
  projectionHelper?: ProjectionHelper,
  bounds?: TProjectedBounds
) {
  let landSeaMask: THREE.Object3D | undefined = undefined;
  // Determine effective mode from simplified choice and texture flag
  const choice = landSeaMaskChoice ?? LAND_SEA_MASK_MODES.OFF;
  const useTexture = landSeaMaskUseTexture ?? true;
  let mode: TLandSeaMaskMode = LAND_SEA_MASK_MODES.OFF;

  mode = determineEffectiveMode(choice, useTexture);

  if (projectionHelper?.isFlat) {
    const helper = projectionHelper;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      console.warn("Missing or invalid bounds for flat mask rendering");
      return undefined;
    }
    return await getFlatLandSeaMask({ mode, useTexture, helper, bounds });
  }

  // Helper for grey mask
  try {
    const maskConfig = {
      [LAND_SEA_MASK_MODES.SEA]: () =>
        getTexturedLandSeaMask({ invert: false }),
      [LAND_SEA_MASK_MODES.LAND]: () =>
        getTexturedLandSeaMask({ invert: true }),
      [LAND_SEA_MASK_MODES.SEA_GREY]: () =>
        getSolidLandSeaMask({ invert: false }),
      [LAND_SEA_MASK_MODES.LAND_GREY]: () =>
        getSolidLandSeaMask({ invert: true }),
      [LAND_SEA_MASK_MODES.GLOBE]: () => getTexturedGlobe(),
      [LAND_SEA_MASK_MODES.GLOBE_COLORED]: () => getSolidGlobe(),
      [LAND_SEA_MASK_MODES.OFF]: () => undefined,
    } as const;

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
