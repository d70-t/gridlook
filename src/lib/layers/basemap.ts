// Raster XYZ basemap, sampled per fragment so it follows every projection.
// A low-zoom texture covers the world; sharper tiles are uploaded one by one
// into fixed slots of an atlas texture, and a small page table tells the
// shader which slot holds each tile of the current view.

import { useThrottleFn } from "@vueuse/core";
import axios from "axios";
import QuickLRU from "quick-lru";
import * as THREE from "three";

import {
  drawLabelImage,
  prepareLabels,
  type TBasemapLabel,
} from "./basemapLabels.ts";
import {
  BasemapZoom,
  buildPageTable,
  getAtlasLayout,
  EXPANSION_VIEW_RADIUS,
  getFlatMercatorExpansion,
  getTileSource,
  getWindowReference,
  getWindowTiles,
  isSameTileWindow,
  latToMercatorY,
  lonToMercatorX,
  mercatorYToLat,
  replaceMissingTiles,
  TILE_SIZE,
  type TGeoPoint,
  type TTileRequest,
  type TTileWindow,
} from "./basemapTiles.ts";
import {
  applyLandSeaCutout,
  configureEquirectangularTexture,
  copyAntimeridianEdge,
  createLayerCanvas,
  LAND_SEA_MASK_MODES,
} from "./equirectLayer.ts";
import basemapFragmentShader from "./glsl/basemap.frag.glsl";
import basemapScreenVertexShader from "./glsl/basemapScreen.vert.glsl";
import { drawVectorTile, type TVectorDrawOptions } from "./vectorTiles.ts";

import { getProjectionTypeFromMode } from "@/lib/projection/projectionShaders.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  BasemapTileSize,
  BasemapTileType,
  DEFAULT_BASEMAP_OPTIONS,
  type TBasemapEntry,
  type TBasemapOptions,
} from "@/utils/basemap.ts";

const BASE_WINDOW: TTileWindow = {
  zoom: BasemapZoom.BASE,
  x: 0,
  y: 0,
  width: 2 ** BasemapZoom.BASE,
  height: 2 ** BasemapZoom.BASE,
};

// Screen samples along the longer canvas side when choosing tiles.
const VIEW_SAMPLE_STEPS = 16;

// Decoding for the atlas; tiles of any size fit the slot.
const ATLAS_IMAGE_OPTIONS: ImageBitmapOptions = {
  resizeWidth: TILE_SIZE,
  resizeHeight: TILE_SIZE,
  premultiplyAlpha: "none",
  colorSpaceConversion: "none",
};

// The label image is redrawn at most this often, e.g. while tiles arrive.
const LABEL_IMAGE_INTERVAL_MS = 200;
// View zoom changes below this step keep the label image.
const VIEW_ZOOM_STEP = 0.05;

// Each upload is a 256 KB texSubImage2D; this bounds the work per frame.
const UPLOADS_PER_FRAME = 8;

// Tile downloads in flight at once. The rest wait in priority order, so
// tiles that leave the view before their turn never reach the server.
const MAX_DOWNLOADS = 6;
// A failed tile (e.g. rate-limited) is retried after this delay, doubling
// with each further failure up to the maximum.
const RETRY_DELAY = { FIRST_MS: 30_000, MAX_MS: 600_000 } as const;

type TTileFailure = { at: number; count: number };

function getRetryTime(failure: TTileFailure) {
  return (
    failure.at +
    Math.min(
      RETRY_DELAY.FIRST_MS * 2 ** (failure.count - 1),
      RETRY_DELAY.MAX_MS
    )
  );
}

// Compressed tiles are small, so caching blobs and decoding on reuse keeps
// memory low when tiles come back after leaving the atlas.
const tileCache = new QuickLRU<string, Blob>({ maxSize: 1024 });

// Downloads in flight, so the quadrants of a 512 px tile share one. Each is
// aborted once every tile waiting for it is.
const pendingDownloads = new Map<
  string,
  { blob: Promise<Blob>; request: AbortController; waiting: number }
>();

const EMPTY_TEXTURE = new THREE.DataTexture(new Uint8Array(4), 1, 1);
EMPTY_TEXTURE.needsUpdate = true;

let landMask: Promise<THREE.Texture> | undefined;

/**
 * Land in alpha, from the Natural Earth land polygons, at 4096 x 2048:
 * larger canvases can exceed the browser's limits for path fills.
 */
function loadLandMask() {
  landMask ??= (async () => {
    const { canvas, ctx, width, height } = createLayerCanvas(4096, 2048);
    ctx.fillRect(0, 0, width, height);
    await applyLandSeaCutout(ctx, width, height, LAND_SEA_MASK_MODES.LAND);
    copyAntimeridianEdge(ctx, width);
    return configureEquirectangularTexture(new THREE.CanvasTexture(canvas));
  })().catch((error: unknown) => {
    landMask = undefined;
    throw error;
  });
  return landMask;
}

const UNIT_SPHERE = new THREE.Sphere(new THREE.Vector3(), 1);
const cameraPosition = new THREE.Vector3();
const cornerRaycaster = new THREE.Raycaster();
const corner = new THREE.Vector2();
const cornerHit = new THREE.Vector3();
const referencePoint = new THREE.Vector3();
const FLAT_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function fetchTile(url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const cached = tileCache.get(url);
  if (cached) {
    return Promise.resolve(cached);
  }
  let pending = pendingDownloads.get(url);
  if (!pending) {
    const request = new AbortController();
    const blob = axios
      .get<Blob>(url, { responseType: "blob", signal: request.signal })
      .then((response) => {
        tileCache.set(url, response.data);
        return response.data;
      })
      .finally(() => pendingDownloads.delete(url));
    pending = { blob, request, waiting: 0 };
    pendingDownloads.set(url, pending);
  }
  const download = pending;
  download.waiting++;
  signal.addEventListener(
    "abort",
    () => {
      if (--download.waiting === 0) {
        download.request.abort();
      }
    },
    { once: true }
  );
  return download.blob;
}

/**
 * Downloads a 256 px tile and decodes it, off the main thread for raster
 * tiles; vector tiles are drawn here and also return their labels.
 */
async function decodeTile(
  provider: TBasemapEntry,
  drawOptions: TVectorDrawOptions,
  tile: { z: number; x: number; y: number },
  signal: AbortSignal,
  options?: ImageBitmapOptions
): Promise<{ image: ImageBitmap; labels: TBasemapLabel[] }> {
  const source = getTileSource(provider, tile.z, tile.x, tile.y);
  const blob = await fetchTile(source.url, signal);
  if (provider.type === BasemapTileType.VECTOR) {
    // ponytail: parses the tile again for each tile cut from it and draws on
    // the main thread; a Web Worker could take this over if it stutters.
    const { canvas, labels } = drawVectorTile(
      await blob.arrayBuffer(),
      source,
      drawOptions
    );
    return { image: await createImageBitmap(canvas, options), labels };
  }
  const { x, y, size } = source.region;
  if (size === 1) {
    return { image: await createImageBitmap(blob, options), labels: [] };
  }
  const pixels = provider.tileSize ?? BasemapTileSize.STANDARD;
  const image = await createImageBitmap(
    blob,
    x * pixels,
    y * pixels,
    size * pixels,
    size * pixels,
    options
  );
  return { image, labels: [] };
}

/** Identifies what the tiles show: the source, and how vector tiles look. */
function getSourceKey(
  provider: TBasemapEntry | undefined,
  drawOptions: TVectorDrawOptions
) {
  if (provider?.type !== BasemapTileType.VECTOR) {
    return provider?.url;
  }
  return `${provider.url} ${drawOptions.water} ${drawOptions.land}`;
}

/**
 * Draws a window's tiles into a new canvas; tiles that fail stay transparent.
 * Returns undefined when aborted and throws only if every tile failed.
 */
async function drawTiles(
  provider: TBasemapEntry,
  drawOptions: TVectorDrawOptions,
  window: TTileWindow,
  signal: AbortSignal
) {
  const canvas = document.createElement("canvas");
  canvas.width = window.width * TILE_SIZE;
  canvas.height = window.height * TILE_SIZE;
  const ctx = canvas.getContext("2d")!;
  const labels: TBasemapLabel[] = [];
  const results = await Promise.allSettled(
    getWindowTiles(window).map(async (tile) => {
      const decoded = await decodeTile(provider, drawOptions, tile, signal);
      const image = decoded.image;
      labels.push(...decoded.labels);
      ctx.drawImage(
        image,
        tile.column * TILE_SIZE,
        tile.row * TILE_SIZE,
        TILE_SIZE,
        TILE_SIZE
      );
      image.close();
    })
  );
  if (signal.aborted) {
    return undefined;
  }
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure && results.every((result) => result.status === "rejected")) {
    throw failure.reason;
  }
  return { canvas, labels };
}

function createLabelTexture(canvas: HTMLCanvasElement) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function createBaseTexture(canvas: HTMLCanvasElement): THREE.Texture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

/** Allocates GPU storage only; tiles are uploaded into it region by region. */
function createAtlasTexture(
  renderer: THREE.WebGLRenderer,
  columns: number,
  rows: number
) {
  const atlas = new THREE.DataTexture(
    null,
    columns * TILE_SIZE,
    rows * TILE_SIZE
  );
  atlas.source.dataReady = false;
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.generateMipmaps = false;
  atlas.minFilter = THREE.LinearFilter;
  atlas.magFilter = THREE.LinearFilter;
  atlas.needsUpdate = true;
  renderer.initTexture(atlas);
  return atlas;
}

function createPageTableTexture(data: Uint8Array, window: TTileWindow) {
  const texture = new THREE.DataTexture(data, window.width, window.height);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function invertFlat(point: THREE.Vector3, projectionHelper: ProjectionHelper) {
  const inverted = projectionHelper
    .getD3Projection()
    ?.invert?.([point.x, -point.y]);
  if (!inverted || !inverted.every(Number.isFinite)) {
    return null;
  }
  const [lon, lat] = inverted;
  // Inverses return points for positions outside the map; reject those.
  const [x, y] = projectionHelper.project(lat, lon);
  if (Math.abs(x - point.x) > 1e-3 || Math.abs(y - point.y) > 1e-3) {
    return null;
  }
  return { lat, lon };
}

/** Largest distance from (x, y) to a screen corner on the flat map plane. */
function getFlatViewRadius(camera: THREE.Camera, x: number, y: number) {
  let radius = 0;
  for (const [cornerX, cornerY] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    corner.set(cornerX, cornerY);
    cornerRaycaster.setFromCamera(corner, camera);
    const hit = cornerRaycaster.ray.intersectPlane(FLAT_PLANE, cornerHit);
    if (!hit) {
      return Infinity;
    }
    radius = Math.max(radius, Math.hypot(hit.x - x, hit.y - y));
  }
  return radius;
}

/**
 * Geographic points on a square grid of screen positions (null where the
 * screen shows no Earth), for `chooseTileWindow`.
 */
export function sampleViewGeoPoints(
  camera: THREE.Camera,
  projectionHelper: ProjectionHelper,
  width: number,
  height: number
) {
  const pixelStep = Math.max(width, height) / VIEW_SAMPLE_STEPS;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hit = new THREE.Vector3();
  const grid: (TGeoPoint | null)[][] = [];
  for (let row = 0; row <= Math.ceil(height / pixelStep); row++) {
    const line: (TGeoPoint | null)[] = [];
    for (let column = 0; column <= Math.ceil(width / pixelStep); column++) {
      pointer.set(
        ((column * pixelStep) / width) * 2 - 1,
        1 - ((row * pixelStep) / height) * 2
      );
      raycaster.setFromCamera(pointer, camera);
      if (projectionHelper.isFlat) {
        const point = raycaster.ray.intersectPlane(FLAT_PLANE, hit);
        line.push(point && invertFlat(point, projectionHelper));
      } else {
        const point = raycaster.ray.intersectSphere(UNIT_SPHERE, hit);
        line.push(
          point && ProjectionHelper.cartesianToLatLon(point.x, point.y, point.z)
        );
      }
    }
    grid.push(line);
  }
  return { grid, pixelStep };
}

export class BasemapLayer {
  // Shared by every mesh this layer creates, so updates reach all of them.
  private readonly uniforms = {
    baseTexture: { value: EMPTY_TEXTURE as THREE.Texture },
    atlasTexture: { value: EMPTY_TEXTURE as THREE.Texture },
    atlasSlots: { value: new THREE.Vector2(1, 1) },
    pageTable: { value: EMPTY_TEXTURE as THREE.Texture },
    detailWindow: { value: new THREE.Vector4() },
    detailTiles: { value: 0 },
    referenceMercator: { value: new THREE.Vector2() },
    referenceTile: { value: new THREE.Vector2() },
    referenceTrig: { value: new THREE.Vector4() },
    referencePsi: { value: 0 },
    cameraOffset: { value: new THREE.Vector3() },
    cameraHeightTerm: { value: 0 },
    referenceProjected: { value: new THREE.Vector2() },
    expansionJacobian: { value: new THREE.Vector4() },
    expansionCurvatureX: { value: new THREE.Vector3() },
    expansionCurvatureY: { value: new THREE.Vector3() },
    useExpansion: { value: false },
    landMask: { value: EMPTY_TEXTURE as THREE.Texture },
    showLand: { value: true },
    showWater: { value: true },
    labelImage: { value: EMPTY_TEXTURE as THREE.Texture },
    labelTiles: { value: 0 },
    labelSize: { value: new THREE.Vector2() },
    labelReferenceTile: { value: new THREE.Vector2() },
  };
  private readonly onChange: () => void;
  private readonly onError: (error: unknown) => void;
  private provider: TBasemapEntry | undefined;
  private drawOptions: TVectorDrawOptions = DEFAULT_BASEMAP_OPTIONS;
  // What raster basemaps show of land and water, applied with the land mask.
  private maskOptions: TVectorDrawOptions = DEFAULT_BASEMAP_OPTIONS;
  // What the tiles show (see getSourceKey), and what the base texture shows
  // once it is complete.
  private sourceKey: string | undefined;
  private baseKey: string | undefined;
  private baseLabels: TBasemapLabel[] = [];
  // Labels of the tiles in the atlas, and of those shown with the base's.
  private readonly tileLabels = new Map<string, TBasemapLabel[]>();
  private shownLabels: TBasemapLabel[] = [];
  private showLabels = false;
  // Zoom of the finest detail in view (see getViewZoom), rounded.
  private viewZoom: number = BasemapZoom.BASE;
  private labelCanvas: HTMLCanvasElement | undefined;
  // What the label image shows.
  private labelImage:
    | { window: TTileWindow; displayRatio: number; labels: TBasemapLabel[] }
    | undefined;
  private readonly scheduleLabelImage = useThrottleFn(
    () => this.updateLabelImage(),
    LABEL_IMAGE_INTERVAL_MS,
    true
  );
  // Aborts the base download when the source changes.
  private baseRequest = new AbortController();
  // Bumped on every source change so late tiles of the old one are dropped.
  private generation = 0;
  private reportedTileError = false;
  private window: TTileWindow | undefined;
  // Tiles the window needs, in loading order.
  private requests: TTileRequest[] = [];

  private atlas: THREE.DataTexture | undefined;
  private pageTable: THREE.DataTexture | undefined;
  private atlasColumns = 1;
  private freeSlots: number[] = [];
  // Tile key -> atlas slot, least recently shown first.
  private readonly slots = new Map<string, number>();
  // Tiles the page table points to; never evicted.
  private shownKeys = new Set<string>();
  private readonly downloads = new Map<string, AbortController>();
  private queue: TTileRequest[] = [];
  private readonly failures = new Map<string, TTileFailure>();
  // Tiles the provider answered with 404.
  private readonly missing = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTime = Infinity;
  private readonly uploads = new Map<
    string,
    { image: ImageBitmap; labels: TBasemapLabel[] }
  >();
  private readonly uploadSource = new THREE.Texture();
  private uploadFrame = 0;

  constructor(onChange: () => void, onError: (error: unknown) => void) {
    this.onChange = onChange;
    this.onError = onError;
  }

  /** Builds a mesh for the projection; the caller disposes it. */
  createMesh(projectionHelper: ProjectionHelper): THREE.Mesh {
    const isFlat = projectionHelper.isFlat;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...this.uniforms,
        opacity: { value: 1.0 },
        projectionType: {
          value: getProjectionTypeFromMode(projectionHelper.type),
        },
        centerLon: { value: projectionHelper.center.lon },
        centerLat: { value: projectionHelper.center.lat },
      },
      defines: isFlat ? { FLAT: "" } : {},
      vertexShader: basemapScreenVertexShader,
      fragmentShader: basemapFragmentShader,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    // A full-screen quad that ray-casts the sphere or map plane per pixel.
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.name = "basemap";
    mesh.frustumCulled = false;
    return mesh;
  }

  /**
   * Switches the tile source, or how vector tiles are drawn. The old base
   * stays visible until the new one is complete, and sharper tiles only load
   * on top of a base of the same source, so two sources never mix.
   */
  async setProvider(
    provider: TBasemapEntry | undefined,
    drawOptions: TBasemapOptions
  ) {
    this.applyOptions(provider, drawOptions);
    const sourceKey = getSourceKey(provider, drawOptions);
    if (sourceKey === this.sourceKey) {
      return;
    }
    this.provider = provider;
    this.drawOptions = drawOptions;
    this.sourceKey = sourceKey;
    this.baseKey = undefined;
    this.baseRequest.abort();
    this.baseRequest = new AbortController();
    this.generation++;
    this.reportedTileError = false;
    this.clearTiles();
    this.updatePageTable();
    if (!provider) {
      this.baseLabels = [];
      this.updatePageTable();
      this.setBase(EMPTY_TEXTURE);
      this.onChange();
      return;
    }
    let base: Awaited<ReturnType<typeof drawTiles>>;
    try {
      base = await drawTiles(
        provider,
        drawOptions,
        BASE_WINDOW,
        this.baseRequest.signal
      );
    } catch (error) {
      this.onError(error);
      return;
    }
    if (!base) {
      return;
    }
    this.baseKey = sourceKey;
    this.baseLabels = base.labels;
    this.updatePageTable();
    this.setBase(createBaseTexture(base.canvas));
    this.onChange();
    this.requestTiles();
  }

  /**
   * Hides the land or water of raster basemaps once the mask is loaded;
   * vector basemaps leave them out of their tiles.
   */
  private async setMaskOptions(
    provider: TBasemapEntry | undefined,
    options: TVectorDrawOptions
  ) {
    this.maskOptions =
      provider?.type === BasemapTileType.VECTOR
        ? DEFAULT_BASEMAP_OPTIONS
        : options;
    if (!this.maskOptions.land || !this.maskOptions.water) {
      try {
        this.uniforms.landMask.value = await loadLandMask();
      } catch (error) {
        this.onError(error);
        return;
      }
    }
    // The latest options, should they have changed while loading.
    this.uniforms.showLand.value = this.maskOptions.land;
    this.uniforms.showWater.value = this.maskOptions.water;
    this.onChange();
  }

  /** Applies what does not change the tiles: masks and labels. */
  private applyOptions(
    provider: TBasemapEntry | undefined,
    options: TBasemapOptions
  ) {
    void this.setMaskOptions(provider, options);
    this.showLabels =
      provider?.type === BasemapTileType.VECTOR && options.labels;
    void this.scheduleLabelImage();
  }

  /** Sizes the labels for the view's zoom (see getViewZoom). */
  setViewZoom(zoom: number) {
    const rounded = Math.round(zoom / VIEW_ZOOM_STEP) * VIEW_ZOOM_STEP;
    if (rounded !== this.viewZoom) {
      this.viewZoom = rounded;
      void this.scheduleLabelImage();
    }
  }

  private isLabelImageCurrent(
    labels: TBasemapLabel[],
    window: TTileWindow,
    displayRatio: number
  ) {
    const image = this.labelImage;
    if (!image || labels.length === 0) {
      return !image && labels.length === 0;
    }
    return (
      isSameTileWindow(image.window, window) &&
      image.displayRatio === displayRatio &&
      image.labels.length === labels.length &&
      image.labels.every((label, index) => label === labels[index])
    );
  }

  /** Redraws the label image if the window, zoom or shown labels changed. */
  private updateLabelImage() {
    const labels = this.showLabels ? this.shownLabels : [];
    const window = this.window ?? BASE_WINDOW;
    const displayRatio = 2 ** (this.viewZoom - window.zoom);
    if (this.isLabelImageCurrent(labels, window, displayRatio)) {
      return;
    }
    const uniforms = this.uniforms;
    this.labelImage = labels.length
      ? { window, displayRatio, labels }
      : undefined;
    uniforms.labelTiles.value = labels.length ? 2 ** window.zoom : 0;
    if (labels.length) {
      this.labelCanvas ??= document.createElement("canvas");
      const { width, height } = this.labelCanvas;
      drawLabelImage(this.labelCanvas, labels, window, displayRatio);
      const texture = uniforms.labelImage.value;
      // A texture keeps the size it was first uploaded with.
      if (
        texture === EMPTY_TEXTURE ||
        width !== this.labelCanvas.width ||
        height !== this.labelCanvas.height
      ) {
        if (texture !== EMPTY_TEXTURE) {
          texture.dispose();
        }
        uniforms.labelImage.value = createLabelTexture(this.labelCanvas);
      } else {
        texture.needsUpdate = true;
      }
      uniforms.labelSize.value.set(window.width, window.height);
    }
    this.onChange();
  }

  /** Zoom of the current window; undefined while the base is shown. */
  get windowZoom() {
    return this.window?.zoom;
  }

  /**
   * Shows the tiles of `window` as `requests` (from `getTileRequests`)
   * arrive; undefined shows the base.
   */
  setWindow(window: TTileWindow | undefined, requests: TTileRequest[]) {
    const keys = new Set(requests.map((request) => request.key));
    if (
      isSameTileWindow(window, this.window) &&
      keys.size === this.requests.length &&
      this.requests.every((request) => keys.has(request.key))
    ) {
      return;
    }
    this.window = window;
    this.requests = requests;
    const wanted = new Set(
      replaceMissingTiles(requests, this.missing).map((request) => request.key)
    );
    for (const [key, request] of this.downloads) {
      if (!wanted.has(key)) {
        request.abort();
        this.downloads.delete(key);
      }
    }
    this.requestTiles();
    this.updatePageTable();
    this.onChange();
  }

  /** Call right before the basemap is rendered with `camera`. */
  update(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    projectionHelper: ProjectionHelper
  ) {
    this.updateReference(camera, projectionHelper);
    if (this.uploads.size > 0) {
      this.uploadTiles(renderer);
    }
  }

  /**
   * Moves the shader's reference point to the window centre (or below the
   * camera without a window) and passes the camera relative to it. Doubles
   * here keep the shader's small offsets precise at any zoom.
   */
  private updateReference(
    camera: THREE.Camera,
    projectionHelper: ProjectionHelper
  ) {
    cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    let mercatorX = 0.5;
    let mercatorY = 0.5;
    if (this.window) {
      const reference = getWindowReference(this.window);
      mercatorX = reference.mercatorX;
      mercatorY = reference.mercatorY;
      this.uniforms.referenceTile.value.set(reference.tileX, reference.tileY);
    } else {
      const below = projectionHelper.isFlat
        ? invertFlat(cameraPosition, projectionHelper)
        : ProjectionHelper.cartesianToLatLon(
            cameraPosition.x,
            cameraPosition.y,
            cameraPosition.z
          );
      if (below) {
        mercatorX = lonToMercatorX(below.lon);
        mercatorY = latToMercatorY(below.lat);
      }
      this.uniforms.referenceTile.value.set(0, 0);
    }
    this.uniforms.referenceMercator.value.set(mercatorX, mercatorY);
    const labelWindow = this.labelImage?.window;
    if (labelWindow) {
      // Relative to the label window, wrapped close to it, for precision.
      const tiles = 2 ** labelWindow.zoom;
      const column = mercatorX * tiles - labelWindow.x;
      this.uniforms.labelReferenceTile.value.set(
        column - Math.round(column / tiles) * tiles,
        mercatorY * tiles - labelWindow.y
      );
    }
    if (projectionHelper.isFlat) {
      this.updateFlatReference(camera, projectionHelper, mercatorX, mercatorY);
    } else {
      this.updateGlobeReference(mercatorX, mercatorY);
    }
  }

  private updateGlobeReference(mercatorX: number, mercatorY: number) {
    const uniforms = this.uniforms;
    const lon = (mercatorX * 2 - 1) * Math.PI;
    const lat = THREE.MathUtils.degToRad(mercatorYToLat(mercatorY));
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    uniforms.referenceTrig.value.set(
      sinLat,
      cosLat,
      Math.sin(lon),
      Math.cos(lon)
    );
    uniforms.referencePsi.value = Math.atanh(sinLat);
    referencePoint.set(cosLat * Math.cos(lon), cosLat * Math.sin(lon), sinLat);
    const offset = uniforms.cameraOffset.value
      .copy(cameraPosition)
      .sub(referencePoint);
    uniforms.cameraHeightTerm.value =
      2 * referencePoint.dot(offset) + offset.lengthSq();
  }

  private updateFlatReference(
    camera: THREE.Camera,
    projectionHelper: ProjectionHelper,
    mercatorX: number,
    mercatorY: number
  ) {
    const uniforms = this.uniforms;
    const expansion = getFlatMercatorExpansion(
      (lat, lon) => projectionHelper.project(lat, lon),
      mercatorX,
      mercatorY
    );
    if (expansion) {
      uniforms.expansionJacobian.value.fromArray(expansion.jacobian);
      uniforms.expansionCurvatureX.value.fromArray(expansion.curvatureX);
      uniforms.expansionCurvatureY.value.fromArray(expansion.curvatureY);
    }
    // Without an expansion, any consistent point works for the ray offsets.
    const [x, y] =
      expansion?.projected ??
      projectionHelper.project(
        mercatorYToLat(mercatorY),
        mercatorX * 360 - 180
      );
    uniforms.useExpansion.value =
      expansion !== undefined &&
      getFlatViewRadius(camera, x, y) <= EXPANSION_VIEW_RADIUS;
    uniforms.referenceProjected.value.set(x, y);
    uniforms.cameraOffset.value.set(
      cameraPosition.x - x,
      cameraPosition.y - y,
      cameraPosition.z
    );
  }

  private uploadTiles(renderer: THREE.WebGLRenderer) {
    const atlas = this.getAtlas(renderer);
    let count = 0;
    for (const [key, { image, labels }] of this.uploads) {
      if (count++ === UPLOADS_PER_FRAME) {
        break;
      }
      this.uploads.delete(key);
      const slot = this.takeSlot();
      if (slot !== undefined) {
        this.uploadSource.image = image;
        renderer.copyTextureToTexture(
          this.uploadSource,
          atlas,
          null,
          new THREE.Vector2(
            (slot % this.atlasColumns) * TILE_SIZE,
            Math.floor(slot / this.atlasColumns) * TILE_SIZE
          )
        );
        this.slots.set(key, slot);
        this.tileLabels.set(key, labels);
      }
      image.close();
    }
    this.updatePageTable();
    if (this.uploads.size > 0) {
      cancelAnimationFrame(this.uploadFrame);
      this.uploadFrame = requestAnimationFrame(() => this.onChange());
    }
  }

  private getAtlas(renderer: THREE.WebGLRenderer) {
    if (!this.atlas) {
      const { columns, rows } = getAtlasLayout(
        renderer.capabilities.maxTextureSize
      );
      this.atlas = createAtlasTexture(renderer, columns, rows);
      this.atlasColumns = columns;
      this.freeSlots = Array.from({ length: columns * rows }, (_, i) => i);
      this.uniforms.atlasTexture.value = this.atlas;
      this.uniforms.atlasSlots.value.set(columns, rows);
    }
    return this.atlas;
  }

  /** A free slot, else the least recently shown tile's slot. */
  private takeSlot() {
    const free = this.freeSlots.pop();
    if (free !== undefined) {
      return free;
    }
    for (const [key, slot] of this.slots) {
      if (!this.shownKeys.has(key)) {
        this.slots.delete(key);
        this.tileLabels.delete(key);
        return slot;
      }
    }
    return undefined;
  }

  private requestTiles() {
    const window = this.window;
    const provider = this.provider;
    if (!window || !provider || this.baseKey !== this.sourceKey) {
      // setProvider requests the tiles once its base is in.
      this.queue = [];
      return;
    }
    const now = Date.now();
    this.queue = replaceMissingTiles(this.requests, this.missing).filter(
      (tile) => {
        if (
          this.slots.has(tile.key) ||
          this.downloads.has(tile.key) ||
          this.uploads.has(tile.key)
        ) {
          return false;
        }
        const failure = this.failures.get(tile.key);
        if (failure && getRetryTime(failure) > now) {
          this.scheduleRetry(getRetryTime(failure));
          return false;
        }
        return true;
      }
    );
    this.startDownloads();
  }

  /** Requests the view's tiles again at `time`, unless already due sooner. */
  private scheduleRetry(time: number) {
    if (time >= this.retryTime) {
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTime = time;
    this.retryTimer = setTimeout(() => {
      this.retryTime = Infinity;
      this.requestTiles();
    }, time - Date.now());
  }

  private startDownloads() {
    const provider = this.provider;
    while (
      provider &&
      this.downloads.size < MAX_DOWNLOADS &&
      this.queue.length > 0
    ) {
      void this.loadTile(provider, this.queue.shift()!);
    }
  }

  private async loadTile(provider: TBasemapEntry, tile: TTileRequest) {
    const key = tile.key;
    const request = new AbortController();
    this.downloads.set(key, request);
    const generation = this.generation;
    try {
      const { image, labels } = await decodeTile(
        provider,
        this.drawOptions,
        tile,
        request.signal,
        ATLAS_IMAGE_OPTIONS
      );
      if (request.signal.aborted || generation !== this.generation) {
        image.close();
        return;
      }
      this.failures.delete(key);
      this.uploads.set(key, { image, labels });
      this.onChange();
    } catch (error) {
      if (request.signal.aborted) {
        return;
      }
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        // E.g. imagery beyond its coverage: load the parent instead.
        this.missing.add(key);
        this.requestTiles();
      } else {
        const failure = {
          at: Date.now(),
          count: (this.failures.get(key)?.count ?? 0) + 1,
        };
        this.failures.set(key, failure);
        this.scheduleRetry(getRetryTime(failure));
        if (!this.reportedTileError) {
          this.reportedTileError = true;
          this.onError(error);
        }
      }
    } finally {
      if (this.downloads.get(key) === request) {
        this.downloads.delete(key);
      }
      this.startDownloads();
    }
  }

  private updatePageTable() {
    const window = this.window;
    if (!window || !this.atlas) {
      this.uniforms.detailTiles.value = 0;
      this.shownKeys = new Set();
      this.shownLabels = prepareLabels(this.baseLabels, BasemapZoom.BASE);
      void this.scheduleLabelImage();
      return;
    }
    const { data, used } = buildPageTable(
      window,
      (key) => this.slots.get(key),
      this.atlasColumns
    );
    // Re-insert shown tiles so the map stays in least-recently-shown order.
    for (const key of used) {
      const slot = this.slots.get(key)!;
      this.slots.delete(key);
      this.slots.set(key, slot);
    }
    this.shownKeys = used;
    this.shownLabels = prepareLabels(
      [
        ...this.baseLabels,
        ...[...used].flatMap((key) => this.tileLabels.get(key) ?? []),
      ],
      window.zoom
    );
    void this.scheduleLabelImage();

    if (
      this.pageTable?.image.width === window.width &&
      this.pageTable.image.height === window.height
    ) {
      this.pageTable.image.data = data;
      this.pageTable.needsUpdate = true;
    } else {
      this.pageTable?.dispose();
      this.pageTable = createPageTableTexture(data, window);
      this.uniforms.pageTable.value = this.pageTable;
    }
    this.uniforms.detailWindow.value.set(
      window.x,
      window.y,
      window.width,
      window.height
    );
    this.uniforms.detailTiles.value = 2 ** window.zoom;
  }

  /** Forgets every tile; the atlas memory is reused for the next source. */
  private clearTiles() {
    this.queue = [];
    this.failures.clear();
    this.missing.clear();
    clearTimeout(this.retryTimer);
    this.retryTime = Infinity;
    for (const request of this.downloads.values()) {
      request.abort();
    }
    this.downloads.clear();
    for (const { image } of this.uploads.values()) {
      image.close();
    }
    this.uploads.clear();
    this.tileLabels.clear();
    for (const slot of this.slots.values()) {
      this.freeSlots.push(slot);
    }
    this.slots.clear();
  }

  private setBase(texture: THREE.Texture) {
    const previous = this.uniforms.baseTexture.value;
    if (previous !== EMPTY_TEXTURE && previous !== texture) {
      previous.dispose();
    }
    this.uniforms.baseTexture.value = texture;
  }

  dispose() {
    this.baseRequest.abort();
    this.generation++;
    cancelAnimationFrame(this.uploadFrame);
    // A late throttled redraw then finds nothing to show.
    this.showLabels = false;
    this.clearTiles();
    this.window = undefined;
    this.requests = [];
    this.updatePageTable();
    this.setBase(EMPTY_TEXTURE);
    this.pageTable?.dispose();
    this.pageTable = undefined;
    this.uniforms.pageTable.value = EMPTY_TEXTURE;
    if (this.uniforms.labelImage.value !== EMPTY_TEXTURE) {
      this.uniforms.labelImage.value.dispose();
      this.uniforms.labelImage.value = EMPTY_TEXTURE;
    }
    this.labelImage = undefined;
    this.atlas?.dispose();
    this.atlas = undefined;
  }
}
