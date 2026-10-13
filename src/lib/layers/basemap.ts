// Raster XYZ basemap, sampled per fragment so it follows every projection.
// A low-zoom texture covers the world; sharper tiles are uploaded one by one
// into fixed slots of an atlas texture, and a small page table tells the
// shader which slot holds each tile of the current view.

import axios from "axios";
import QuickLRU from "quick-lru";
import * as THREE from "three";

import {
  BasemapZoom,
  buildPageTable,
  formatTileUrl,
  getAtlasLayout,
  getTileRequests,
  getWindowReference,
  getWindowTiles,
  isSameTileWindow,
  latToMercatorY,
  lonToMercatorX,
  mercatorYToLat,
  TILE_SIZE,
  type TGeoPoint,
  type TTileRequest,
  type TTileWindow,
} from "./basemapTiles.ts";
import { createFlatQuadGeometry } from "./equirectLayer.ts";
import basemapFragmentShader from "./glsl/basemap.frag.glsl";
import basemapGlobeVertexShader from "./glsl/basemapGlobe.vert.glsl";
import flatInverseVertexShader from "./glsl/flatInverse.vert.glsl";

import { getProjectionTypeFromMode } from "@/lib/projection/projectionShaders.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import type { TBasemapEntry } from "@/utils/basemap.ts";

const BASE_WINDOW: TTileWindow = {
  zoom: BasemapZoom.BASE,
  x: 0,
  y: 0,
  width: 2 ** BasemapZoom.BASE,
  height: 2 ** BasemapZoom.BASE,
};

// Screen samples along the longer canvas side when choosing tiles.
const VIEW_SAMPLE_STEPS = 16;

// Each upload is a 256 KB texSubImage2D; this bounds the work per frame.
const UPLOADS_PER_FRAME = 8;

// Tile downloads in flight at once. The rest wait in priority order, so
// tiles that leave the view before their turn never reach the server.
const MAX_DOWNLOADS = 6;
// A tile that failed (e.g. rate-limited) is not requested again for this long.
const RETRY_DELAY_MS = 30_000;

// Compressed tiles are small, so caching blobs and decoding on reuse keeps
// memory low when tiles come back after leaving the atlas.
const tileCache = new QuickLRU<string, Blob>({ maxSize: 1024 });

const EMPTY_TEXTURE = new THREE.DataTexture(new Uint8Array(4), 1, 1);
EMPTY_TEXTURE.needsUpdate = true;

const UNIT_SPHERE = new THREE.Sphere(new THREE.Vector3(), 1);
const cameraPosition = new THREE.Vector3();
const referencePoint = new THREE.Vector3();
const FLAT_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

async function fetchTile(url: string, signal: AbortSignal) {
  const cached = tileCache.get(url);
  if (cached) {
    return cached;
  }
  const response = await axios.get<Blob>(url, {
    responseType: "blob",
    signal,
  });
  tileCache.set(url, response.data);
  return response.data;
}

/**
 * Draws a window's tiles into a new canvas; tiles that fail stay transparent.
 * Returns undefined when aborted and throws only if every tile failed.
 */
async function drawTiles(
  template: string,
  window: TTileWindow,
  signal: AbortSignal
) {
  const canvas = document.createElement("canvas");
  canvas.width = window.width * TILE_SIZE;
  canvas.height = window.height * TILE_SIZE;
  const ctx = canvas.getContext("2d")!;
  const results = await Promise.allSettled(
    getWindowTiles(window).map(async (tile) => {
      const url = formatTileUrl(template, tile.z, tile.x, tile.y);
      const image = await createImageBitmap(await fetchTile(url, signal));
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
  return canvas;
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
  };
  private readonly onChange: () => void;
  private readonly onError: (error: unknown) => void;
  private provider: TBasemapEntry | undefined;
  // Source of the current base texture, once it is complete.
  private baseUrl: string | undefined;
  // Aborts the base download when the source changes.
  private baseRequest = new AbortController();
  // Bumped on every source change so late tiles of the old one are dropped.
  private generation = 0;
  private reportedTileError = false;
  private window: TTileWindow | undefined;

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
  // Tile key -> time of its last failed download.
  private readonly failedAt = new Map<string, number>();
  private readonly uploads = new Map<string, ImageBitmap>();
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
      vertexShader: isFlat ? flatInverseVertexShader : basemapGlobeVertexShader,
      fragmentShader: basemapFragmentShader,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    // The globe is a full-screen quad that ray-casts the sphere per pixel.
    const mesh = new THREE.Mesh(
      isFlat ? createFlatQuadGeometry() : new THREE.PlaneGeometry(2, 2),
      material
    );
    mesh.name = "basemap";
    mesh.frustumCulled = false;
    return mesh;
  }

  /**
   * Switches the tile source. The old base stays visible until the new one is
   * complete, and sharper tiles only load on top of a base of the same
   * source, so two sources never mix.
   */
  async setProvider(provider: TBasemapEntry | undefined) {
    if (provider?.url === this.provider?.url) {
      return;
    }
    this.provider = provider;
    this.baseUrl = undefined;
    this.baseRequest.abort();
    this.baseRequest = new AbortController();
    this.generation++;
    this.reportedTileError = false;
    this.clearTiles();
    this.updatePageTable();
    if (!provider) {
      this.setBase(EMPTY_TEXTURE);
      this.onChange();
      return;
    }
    let canvas: HTMLCanvasElement | undefined;
    try {
      canvas = await drawTiles(
        provider.url,
        BASE_WINDOW,
        this.baseRequest.signal
      );
    } catch (error) {
      this.onError(error);
      return;
    }
    if (!canvas) {
      return;
    }
    this.baseUrl = provider.url;
    this.setBase(createBaseTexture(canvas));
    this.onChange();
    this.requestTiles();
  }

  /** Shows the tiles of `window` as they arrive; undefined shows the base. */
  setWindow(window: TTileWindow | undefined) {
    if (isSameTileWindow(window, this.window)) {
      return;
    }
    this.window = window;
    const wanted = new Set(
      window ? getTileRequests(window).map((request) => request.key) : []
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
  update(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    this.updateReference(camera);
    if (this.uploads.size > 0) {
      this.uploadTiles(renderer);
    }
  }

  /**
   * Moves the shader's reference point to the window centre (or below the
   * camera without a window) and passes the camera relative to it. Doubles
   * here keep the shader's small offsets precise at any zoom.
   */
  private updateReference(camera: THREE.Camera) {
    const uniforms = this.uniforms;
    cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    let mercatorX: number;
    let mercatorY: number;
    if (this.window) {
      const reference = getWindowReference(this.window);
      mercatorX = reference.mercatorX;
      mercatorY = reference.mercatorY;
      uniforms.referenceTile.value.set(reference.tileX, reference.tileY);
    } else {
      const { lat, lon } = ProjectionHelper.cartesianToLatLon(
        cameraPosition.x,
        cameraPosition.y,
        cameraPosition.z
      );
      mercatorX = lonToMercatorX(lon);
      mercatorY = latToMercatorY(lat);
      uniforms.referenceTile.value.set(0, 0);
    }
    const lon = (mercatorX * 2 - 1) * Math.PI;
    const lat = THREE.MathUtils.degToRad(mercatorYToLat(mercatorY));
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    uniforms.referenceMercator.value.set(mercatorX, mercatorY);
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

  private uploadTiles(renderer: THREE.WebGLRenderer) {
    const atlas = this.getAtlas(renderer);
    let count = 0;
    for (const [key, image] of this.uploads) {
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
        return slot;
      }
    }
    return undefined;
  }

  private requestTiles() {
    const window = this.window;
    const provider = this.provider;
    if (!window || !provider || this.baseUrl !== provider.url) {
      // setProvider requests the tiles once its base is in.
      this.queue = [];
      return;
    }
    const now = Date.now();
    this.queue = getTileRequests(window).filter(
      (tile) =>
        !this.slots.has(tile.key) &&
        !this.downloads.has(tile.key) &&
        !this.uploads.has(tile.key) &&
        !(now - (this.failedAt.get(tile.key) ?? -Infinity) < RETRY_DELAY_MS)
    );
    this.startDownloads();
  }

  private startDownloads() {
    const provider = this.provider;
    while (
      provider &&
      this.downloads.size < MAX_DOWNLOADS &&
      this.queue.length > 0
    ) {
      void this.loadTile(provider.url, this.queue.shift()!);
    }
  }

  private async loadTile(template: string, tile: TTileRequest) {
    const key = tile.key;
    const request = new AbortController();
    this.downloads.set(key, request);
    const generation = this.generation;
    try {
      const url = formatTileUrl(template, tile.z, tile.x, tile.y);
      const blob = await fetchTile(url, request.signal);
      // Decodes off the main thread; tiles of any size fit the slot.
      const image = await createImageBitmap(blob, {
        resizeWidth: TILE_SIZE,
        resizeHeight: TILE_SIZE,
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
      if (request.signal.aborted || generation !== this.generation) {
        image.close();
        return;
      }
      this.failedAt.delete(key);
      this.uploads.set(key, image);
      this.onChange();
    } catch (error) {
      if (!request.signal.aborted) {
        this.failedAt.set(key, Date.now());
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
    this.failedAt.clear();
    for (const request of this.downloads.values()) {
      request.abort();
    }
    this.downloads.clear();
    for (const image of this.uploads.values()) {
      image.close();
    }
    this.uploads.clear();
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
    this.clearTiles();
    this.window = undefined;
    this.updatePageTable();
    this.setBase(EMPTY_TEXTURE);
    this.pageTable?.dispose();
    this.pageTable = undefined;
    this.uniforms.pageTable.value = EMPTY_TEXTURE;
    this.atlas?.dispose();
    this.atlas = undefined;
  }
}
