import { MapView, MapProvider, UnitsUtils } from "geo-three";

import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import { type TBasemapEntry } from "@/utils/basemap.ts";

function format(template: string, values: Record<string, number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    if (!(key in values)) {
      throw new Error(`Unknown template parameter: "${key}"`);
    }

    return String(values[key]);
  });
}

class TileMapProvider extends MapProvider {
  readonly address;
  readonly name;

  constructor(address: string, name: string) {
    super();

    this.address = address;
    this.name = name;
  }

  fetchTile(zoom: number, x: number, y: number): Promise<HTMLImageElement> {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const url = format(this.address, { z: zoom, y, x });

      const image = document.createElement("img");
      image.onload = function () {
        resolve(image);
      };

      image.onerror = function () {
        reject();
      };

      image.crossOrigin = "Anonymous";
      image.src = url;
    });
  }
}

function createBasemapProvider(
  basemaps: TBasemapEntry[],
  basemapId: string
): MapProvider {
  const entry = basemaps.find((entry) => entry.id === basemapId);
  if (entry === undefined) {
    throw new Error(`unknown basemap: ${basemapId}`);
  }

  return new TileMapProvider(entry.url, entry.name);
}

export class BasemapLayer {
  private basemap: MapView;

  readonly basemaps: TBasemapEntry[];
  private basemapId: string;

  constructor(basemaps: TBasemapEntry[], basemapId: string) {
    this.basemaps = basemaps;
    this.basemapId = basemapId;

    const provider = createBasemapProvider(basemaps, basemapId);

    // use a radius of 1 instead of the default 6371008
    UnitsUtils.EARTH_RADIUS = 1;
    this.basemap = new MapView(MapView.PLANAR, provider);
  }

  getBasemap() { return this.basemap; }

  setProjection(projection: ProjectionHelper) {
    let root: number;
    if(projection.isFlat) {
      root = MapView.PLANAR;
    } else {
      throw new Error("spherical view is unsupported");
      root = MapView.SPHERICAL;
    }

    if(root === this.basemap.root) {
      return;
    }

    this.basemap.setRoot(root);
  }

  setOpacity(opacity: number) {
    this.basemap.traverse((object) => {
      if(object.material && object.material.opacity !== opacity) {
        object.material.transparent = opacity < 1;
        object.material.opacity = opacity;
        object.material.needsUpdate = true;
      }
    });
    this.basemap.opacity = opacity;
  }

  setBasemap(id: string) {
    if (id === this.basemapId) {
      return;
    }
    this.basemapId = id;

    this.basemap.clear();
    this.basemap.setProvider(createBasemapProvider(this.basemaps, id));
  }

  setRenderOrder(renderOrder: number) {
    this.basemap.renderOrder = renderOrder;
  }

  toggleVisibility() {
    this.basemap.visible = !this.basemap.visible;
  }

  dispose() {
    this.basemap.dispose();
  }
}
