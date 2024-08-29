import type { TBounds, TColorMap } from "../../types/GlobeTypes";
import * as THREE from "three";
function rad2deg(r: number) {
  return (r * 180) / Math.PI;
}

function norm(a: number[]) {
  return Math.sqrt(a.map((v) => v * v).reduce((acc, v) => acc + v, 0));
}

const cmoceanColormaps: TColorMap[] = [
  "coolwarm",
  "bwr",
  "seismic",
  "thermal",
  "haline",
  "solar",
  "ice",
  "gray",
  "deep",
  "dense",
  "algae",
  "matter",
  "turbid",
  "speed",
  "amp",
  "tempo",
  "rain",
  "phase",
  "balance",
  "delta",
  "curl",
  "diff",
  "tarn",
] as const;

export function datashaderExample(config: {
  cameraPosition: THREE.Vector3;
  datasrc: string;
  gridsrc: string;
  varname: string;
  timeIndex: number;
  varbounds: TBounds;
  colormap: TColorMap;
  invertColormap: boolean;
}) {
  const centralLongitude = rad2deg(
    Math.atan2(config.cameraPosition.y, config.cameraPosition.x)
  );
  const centralLatitude = rad2deg(
    Math.atan2(
      config.cameraPosition.z,
      Math.sqrt(
        Math.pow(config.cameraPosition.x, 2) +
          Math.pow(config.cameraPosition.y, 2)
      )
    )
  );
  const satelliteHeight = 6.371e6 * (norm(config.cameraPosition.toArray()) - 1);

  let colormap = config.colormap;
  if (config.invertColormap) {
    colormap = colormap + "_r";
  }

  let extraImports = "";
  if (cmoceanColormaps.includes(config.colormap)) {
    extraImports = extraImports + "import cmocean";
    colormap = "cmocean.cm." + colormap;
  } else {
    colormap = '"' + colormap + '"';
  }
  return `
import xarray as xr
import numpy as np
import pandas as pd

import matplotlib.pylab as plt
import datashader
from datashader.mpl_ext import dsshow

import cartopy.crs as ccrs
import cartopy.feature as cf
${extraImports}

data = xr.open_zarr("${config.datasrc}")
grid = xr.open_zarr("${config.gridsrc}")

central_longitude = ${centralLongitude}
central_latitude = ${centralLatitude}
satellite_height = ${satelliteHeight}

vmin = ${config.varbounds.low}
vmax = ${config.varbounds.high}
cmap = ${colormap}

variable = data["${config.varname}"].isel(time=${config.timeIndex})

projection = ccrs.NearsidePerspective(central_longitude=central_longitude, central_latitude=central_latitude, satellite_height=satellite_height)

coords = projection.transform_points(
    ccrs.Geodetic(),
    np.rad2deg(grid.clon),
    np.rad2deg(grid.clat),
)

fig, ax = plt.subplots(subplot_kw={"projection": projection})
fig.canvas.draw_idle()
ax.add_feature(cf.COASTLINE, linewidth=0.8)

artist = dsshow(
    pd.DataFrame({
        "val": variable.values,
        "x": coords[:, 0],
        "y": coords[:, 1],
    }),
    datashader.Point('x', 'y'),
    datashader.mean('val'),
    vmin=vmin,
    vmax=vmax,
    cmap=cmap,
    ax=ax,
)

fig.colorbar(artist, label=f"{variable.long_name} / {variable.units}")
`;
}
