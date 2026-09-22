import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export type TBasemap = {
  map: maplibregl.Map;
  containerId: string;
};

function entryToStyle(basemap: TBasemapEntry): StyleSpecification {
  return {
    version: 8,
    sources: {
      basemap: {
        type: basemap.type,
        tiles: basemap.tiles,
        tileSize: basemap.tileSize,
        attribution: basemap.attribution,
      },
    },
    layers: [
      {
        id: "basemap",
        type: basemap.type,
        source: "basemap",
        layout: { visibility: "visible" },
      },
    ],
  };
}

function lookupBasemapStyle(
  basemaps: TBasemapEntry[],
  id: string
): StyleSpecification {
  const entry = basemaps.find((entry) => entry.id === id);
  if (entry === undefined) {
    // should never be raised
    console.log("undefined basemap:", id);
    console.log("basemaps:", basemaps);
    throw new Error(`unknown basemap: {id}`);
  }
  return entryToStyle(entry);
}

function createBasemap(
  style: StyleSpecification,
  containerId: string
): maplibregl.Map {
  return new maplibregl.Map({
    container: containerId,
    style: style,
    // sync center / zoom with the current view?
  });
}

function setBasemapVisibility(style: StyleSpecification, visible: bool) {
  let visibility: "none" | "visible";
  if (visible) {
    visibility = "visible";
  } else {
    visibility = "none";
  }

  console.log("style:", style);

  style.layers[0].layout.visibility = visibility;
}

export function toggleBasemapVisibility(map: maplibregl.Map) {
  const style = map.getStyle();

  const visibility = style.layers[0].layout.visibility;
  const visible = visibility === "visible";

  setBasemapVisibility(style, !visible);

  map.setStyle(style);
}

export function useBasemapLayer(
  basemaps: TBasemapEntry[],
  containerId: string,
  basemapId: string,
  visible: bool
): TBasemap {
  const style = lookupBasemapStyle(basemaps, basemapId);
  setBasemapVisibility(style, visible);

  const map = createBasemap(style, containerId);

  return new TBasemap(map, containerId);
}
