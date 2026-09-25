import {
  LODRaycast,
  MapView,
  MapProvider,
  MapSphereNode,
  UnitsUtils,
  type LODControl,
  type MapNode,
} from "geo-three";
import * as THREE from "three";

import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import { type TBasemapEntry } from "@/utils/basemap.ts";

// geo-three derives tile edges from the WGS84 Mercator extent but divides by
// the mean radius, shifting tiles ~4 km poleward. Make the two consistent.
UnitsUtils.EARTH_RADIUS = UnitsUtils.EARTH_RADIUS_A;

function format(template: string, values: Record<string, number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    if (!(key in values)) {
      throw new Error(`Unknown template parameter: "${key}"`);
    }

    return String(values[key]);
  });
}

// geo-three works in metres with y up; gridlook's globe has radius 1 and z up.
const GLOBE_TRANSFORM = new THREE.Matrix4()
  .makeRotationX(Math.PI / 2)
  .multiply(
    new THREE.Matrix4().makeScale(
      1 / UnitsUtils.EARTH_RADIUS_A,
      1 / UnitsUtils.EARTH_RADIUS_A,
      1 / UnitsUtils.EARTH_RADIUS_A
    )
  );

// ponytail: OSM's limit; move into the catalog once a provider needs more.
const MAX_TILE_ZOOM = 19;

const MERCATOR_LAT_LIMIT = Math.atan(Math.sinh(Math.PI));

// Clamped so the polar caps reuse the outermost texture row.
function mercatorY(latitude: number) {
  const clamped = THREE.MathUtils.clamp(
    latitude,
    -MERCATOR_LAT_LIMIT,
    MERCATOR_LAT_LIMIT
  );
  return Math.log(Math.tan(Math.PI / 4 + clamped / 2));
}

/**
 * geo-three's sphere nodes ignore their parent's transform, so the globe
 * transform is baked into every node's world matrix instead.
 */
class GlobeSphereNode extends MapSphereNode {
  /**
   * The stock shader derives Web-Mercator coordinates per fragment with
   * float32 trig on metre-sized values, which stripes at high zoom. Compute
   * them per vertex in double precision instead and use a plain material.
   */
  constructor(
    parentNode?: MapNode,
    mapView?: MapView,
    location?: number,
    level?: number,
    x?: number,
    y?: number
  ) {
    super(parentNode, mapView, location, level, x, y);
    const range = 2 ** this.level;
    // Same edges as MapSphereNode.createGeometry; outer rows reach the poles.
    const top =
      this.y > 0
        ? UnitsUtils.webMercatorToLatitude(this.level, this.y)
        : Math.PI / 2;
    const bottom =
      this.y < range - 1
        ? UnitsUtils.webMercatorToLatitude(this.level, this.y + 1)
        : -Math.PI / 2;
    const mercatorTop = mercatorY(top);
    const mercatorBottom = mercatorY(bottom);
    const uv = this.geometry.getAttribute("uv");
    for (let index = 0; index < uv.count; index++) {
      const latitude = bottom + uv.getY(index) * (top - bottom);
      uv.setY(
        index,
        (mercatorY(latitude) - mercatorBottom) / (mercatorTop - mercatorBottom)
      );
    }
    (this.material as THREE.Material).dispose();
    this.material = new THREE.MeshBasicMaterial();
  }

  updateMatrixWorld(force = false) {
    if (this.matrixWorldNeedsUpdate || force) {
      this.matrixWorld.multiplyMatrices(GLOBE_TRANSFORM, this.matrix);
      this.matrixWorldNeedsUpdate = false;
    }
  }

  // The stock version re-downloads image.src and misses our redraw.
  async applyTexture(image: HTMLImageElement) {
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    const material = this.material as THREE.MeshBasicMaterial;
    material.map = texture;
    material.needsUpdate = true;
  }
}

const GLOBE_MODE = 100;
MapView.mapModes.set(GLOBE_MODE, GlobeSphereNode);

/**
 * Subdivides tiles by their size on screen. The stock LODRaycast compares
 * node scale to distance, which is meaningless for sphere nodes.
 */
class ScreenSizeLOD implements LODControl {
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly size = new THREE.Vector3();

  updateLOD(
    view: MapView,
    camera: THREE.Camera,
    renderer: THREE.WebGLRenderer
  ) {
    if (!(camera instanceof THREE.PerspectiveCamera)) {
      return;
    }
    const pixelsPerUnit =
      renderer.domElement.height /
      (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    for (let ray = 0; ray < 8; ray++) {
      this.pointer.set(Math.random() * 2 - 1, Math.random() * 2 - 1);
      this.raycaster.setFromCamera(this.pointer, camera);
      const hit = this.raycaster.intersectObjects(view.children, true)[0];
      if (!hit) {
        continue;
      }
      const node = hit.object as MapNode;
      node.geometry.boundingBox!.getSize(this.size);
      const tilePixels =
        ((this.size.length() / UnitsUtils.EARTH_RADIUS) * pixelsPerUnit) /
        hit.distance;
      if (tilePixels > 512) {
        node.subdivide();
      } else if (tilePixels < 128 && node.parentNode) {
        node.parentNode.simplify();
      }
    }
  }
}

class TileMapProvider extends MapProvider {
  readonly address;
  readonly name;
  readonly onTileLoad?: () => void;

  constructor(address: string, name: string, onTileLoad?: () => void) {
    super();

    this.address = address;
    this.name = name;
    this.onTileLoad = onTileLoad;
    this.maxZoom = MAX_TILE_ZOOM;
  }

  fetchTile(zoom: number, x: number, y: number): Promise<HTMLImageElement> {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const url = format(this.address, { z: zoom, y, x });

      const image = document.createElement("img");
      // geo-three applies the tile in later microtasks; render after those.
      image.onload = () => {
        resolve(image);
        setTimeout(() => this.onTileLoad?.());
      };

      image.onerror = () => {
        reject();
        setTimeout(() => this.onTileLoad?.());
      };

      image.crossOrigin = "Anonymous";
      image.src = url;
    });
  }
}

function createBasemapProvider(
  basemaps: TBasemapEntry[],
  basemapId: string,
  onTileLoad?: () => void
): MapProvider {
  const entry = basemaps.find((entry) => entry.id === basemapId);
  if (entry === undefined) {
    throw new Error(`unknown basemap: ${basemapId}`);
  }

  return new TileMapProvider(entry.url, entry.name, onTileLoad);
}

export class BasemapLayer {
  private basemap: MapView;

  readonly basemaps: TBasemapEntry[];
  private basemapId: string;
  private readonly onTileLoad: () => void;
  private opacity = 1;
  private renderOrder = 0;

  constructor(
    basemaps: TBasemapEntry[],
    basemapId: string,
    onTileLoad?: () => void
  ) {
    this.basemaps = basemaps;
    this.basemapId = basemapId;
    // Tiles are created lazily by the LOD, so style them as they arrive.
    this.onTileLoad = () => {
      this.applyMaterials();
      onTileLoad?.();
    };

    const provider = createBasemapProvider(
      basemaps,
      basemapId,
      this.onTileLoad
    );

    this.basemap = new MapView(GLOBE_MODE, provider);
    this.basemap.lod = new ScreenSizeLOD();
  }

  getBasemap() {
    return this.basemap;
  }

  setProjection(projection: ProjectionHelper) {
    let root: number;
    if (projection.isFlat) {
      root = MapView.PLANAR;
      this.basemap.lod = new LODRaycast();
    } else {
      root = GLOBE_MODE;
      this.basemap.lod = new ScreenSizeLOD();
    }

    this.basemap.setRoot(root);
  }

  /**
   * Like the other radius-1 layers, tiles skip the depth buffer and are
   * stacked via renderOrder only; otherwise they z-fight with the grid.
   * renderOrder is not inherited, so it has to be set on every tile.
   */
  private applyMaterials() {
    this.basemap.traverse((object) => {
      if (object === this.basemap || !(object instanceof THREE.Mesh)) {
        return;
      }
      object.renderOrder = this.renderOrder;
      const material = object.material as THREE.Material;
      if (material.depthTest || material.opacity !== this.opacity) {
        material.depthTest = false;
        material.depthWrite = false;
        material.transparent = this.opacity < 1;
        material.opacity = this.opacity;
        material.needsUpdate = true;
      }
    });
  }

  setOpacity(opacity: number) {
    this.opacity = opacity;
    this.applyMaterials();
  }

  setProvider(id: string) {
    if (id === this.basemapId) {
      return;
    }
    this.basemapId = id;

    this.basemap.setProvider(
      createBasemapProvider(this.basemaps, id, this.onTileLoad)
    );
  }

  setRenderOrder(renderOrder: number) {
    this.basemap.renderOrder = renderOrder;
    this.renderOrder = renderOrder;
    this.applyMaterials();
  }

  toggleVisibility() {
    this.basemap.visible = !this.basemap.visible;
  }

  dispose() {
    this.basemap.dispose();
  }
}
