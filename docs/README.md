# Gridlook 2025-07-22

**ESM data viewer on a 3D sphere using WebGL**

Andrej Fast¹, Tobi Kölling², Fabian Wachsmann¹, Lukas Kluft²

¹DKRZ, ²MPI-M

🔗 [Github](https://github.com/d70-t/gridlook) - 🔗 [Deployed](https://gridlook.pages.dev/)

---

## 🌍 Motivation

Build an easy-to-use **visualisation tool** to:

- 👀 show plotting without HPC
- 🔎 *Simply and Interactively explore*
    **native grid** Earth System Model (ESM) output
- 🔗 Share *any dataset view* via URL
- 🚅💨 no installation or compute server required

----

**🌍 Motivation**

for developers: interesting technology!

🎨 *client-side* rendering and color mapping
**no image pregeneration**


----

## ☁️ Set-up

Support and leverage **any Zarr dataset** stored in cloud environments.

📌 **Recipe**:  
`https://gridlook.pages.dev/#` + `ZARR_URI`

Where `ZARR_URI`:

- ✅ Is **openly accessible**
- 🌐 Allows **Cross-Origin Requests (CORS)**


----

## Gridlook is *Not*

- ❌ A competitor to high-end visualization suites
- ❌ A tool for generating publication-quality graphics<br>
👉 It’s built for intuitive, efficient, interoperable **exploration**.

---

## 🛠 Technical Details

- 🧠 Built with **TypeScript**
- 🌱 Frontend: **Vue.js** + **Bulma**
- 🔺 Rendering: **Three.js (WebGL)**
- 📦 Zarr handling via **Zarrita**

----

## Supported Grids

- 🌐 Regular Grids
- 🧭 Rotated Regular Grids
- 💠 HEALPix
- 🔺 Triangular (ICON)
- 🪢 * Irregular Grids
- 🌐 * Gaussian Reduced (e.g., ERA5)
<br/>
<div style="font-size:10pt;">
* Not upstreamed yet
</div>

----

## Limitations (yet)

- 🕳️ No multi-dimensional arrays
     No Model-levels enabled
- 🔒 No scale shown
- 🕳️ Python example does not work
- 🌱 Code is not consolidated yet

----

## 📊 Examples

**💠 Healpix**

Support for all datasets in the [WCRP Global Hackathon HK25 catalog](https://digital-earths-global-hackathon.github.io/catalog/).
Get to know the gridtype *healpix* 
with this ICON amip Dyamond3 simulation PT6h_inst dataset:

- [Level 0](https://s3.eu-dkrz-1.dkrz.cloud/bm1344/gridlook/index.html#https://s3.eu-dkrz-1.dkrz.cloud/wrcp-hackathon/data/ICON/d3hp003.zarr/PT6H_inst_z0_atm)
- [Level 4](https://s3.eu-dkrz-1.dkrz.cloud/bm1344/gridlook/index.html#https://s3.eu-dkrz-1.dkrz.cloud/wrcp-hackathon/data/ICON/d3hp003.zarr/PT6H_inst_z4_atm)
- [Level 7](https://s3.eu-dkrz-1.dkrz.cloud/bm1344/gridlook/index.html#https://s3.eu-dkrz-1.dkrz.cloud/wrcp-hackathon/data/ICON/d3hp003.zarr/PT6H_inst_z7_atm)
- [Level 11](https://s3.eu-dkrz-1.dkrz.cloud/bm1344/gridlook/index.html#https://s3.eu-dkrz-1.dkrz.cloud/wrcp-hackathon/data/ICON/d3hp003.zarr/PT6H_inst_z11_atm) (downloads much data!)

----

👀 Many of the following datasets have large chunks (~100MB). 

Mind that when you are on mobile network or using a mobile device.

----

2. [🔺 Triangular](https://s3.eu-dkrz-1.dkrz.cloud/bm1344/gridlook/index.html#https://eerie.cloud.dkrz.de/datasets/icon-esm-er.hist-1950.v20240618.atmos.native.2d_monthly_mean/stac) 
    Dataset: EERIE ICON hist-1950 tas on R2B8 (10km)
1. [🌐 Regular (lat x lon)](https://s3.eu-dkrz-1.dkrz.cloud/bm1344/gridlook/index.html#https://storage.googleapis.com/cmip6/CMIP6/HighResMIP/EC-Earth-Consortium/EC-Earth3P-HR/highresSST-present/r1i1p1f1/Amon/pr/gr/v20170811/)
    Dataset: CMIP6 EC-Earth3P-HR highresSST-present pr, 30km.
    -> Support for CMIP
1. [🧭 Rotated lat x lon](https://s3.eu-dkrz-1.dkrz.cloud/bm1344/gridlook/index.html#https://euro-cordex.s3.amazonaws.com/CMIP5/cordex/output/EUR-11/GERICS/MPI-M-MPI-ESM-LR/historical/r3i1p1/REMO2015/v1/mon/tas/v20190925/)
    Dataset: CORDEX REMO2015 historical tas on EUR11(11km)
    -> Support for CORDEX

----

5. [🌐 Gaussian reduced (decreasing no of longitudes towards poles)](https://s3.eu-dkrz-1.dkrz.cloud/bm1344/gridlook/index.html#https://eerie.cloud.dkrz.de/datasets/ifs-amip-tco1279.hist.v20240901.atmos.native.2D_monthly/stac)
    Dataset: EERIE IFS hist 10fg on TCO1279 (10km)    
    --> Support for ERA5
1. [🪢 Irregular](https://s3.eu-dkrz-1.dkrz.cloud/bm1344/gridlook/index.html#https://cmip6-pds.s3.amazonaws.com/CMIP6/CMIP/AWI/AWI-CM-1-1-MR/historical/r1i1p1f1/Oday/tos/gn/v20181218/)
    Dataset: CMIP6 AWI-CM-1-1-MR historical tos, 25km.

---

## 💡 Use Cases

- 📱 Embed in web apps — even works on mobile
- 🧬 Understand model internals 
    (e.g., [ring-shaped precipitation in IFS](https://s3.eu-dkrz-1.dkrz.cloud/bm1344/gridlook/index.html#https://s3.eu-dkrz-1.dkrz.cloud/wrcp-hackathon/data/IFS-FESOM/hourly_healpix2048.zarr))
- 🐛 Find bugs or diagnose outputs 
    (e.g., [Amazon River temperature anomaly in CMIP6 MPI-ESM1-2](https://s3.eu-dkrz-1.dkrz.cloud/bm1344/gridlook/index.html#https://storage.googleapis.com/cmip6/CMIP6/ScenarioMIP/DKRZ/MPI-ESM1-2-HR/ssp370/r1i1p1f1/Amon/tas/gn/v20190710/))

----

Precipitation rate in IFS Dyamond3 over the indian ocean

![](https://pad.gwdg.de/uploads/12615a0f-7e9d-4788-9886-094ccac44702.png)

----

Cloud coverage in IFS Dyamond3 over the Pacific

![](https://pad.gwdg.de/uploads/1efde248-0c73-4e14-94ed-06cabd65a2b4.png)


---

## ☁️ Gridlook collections

**🧊 DKRZ support for S3 and Swift datasets**

STAC Integration as a DM test service:
Buttons as Assets in STAC Items

- [Dyamond3 Healpix](https://discover.dkrz.de/external/stac2.cloud.dkrz.de/fastapi/collections/dyamond)

----

**🧊 DKRZ support for S3 and Swift datasets**

works well for the HK25 data stored at DKRZ because of

1.

**a performant institutional s3 cloud storage**

----

**🧊 DKRZ test support for S3 and Swift datasets**

works well for the HK25 data stored at DKRZ because we

2. 
 
**prepared datasets**

- rechunked datasets
- enriched datasets (`crs`, attributes)
- brought it to cloud
- embedded links in catalogs

----

![](https://pad.gwdg.de/uploads/8d793e32-aefd-40de-a664-af0b696e29ec.png)

----

### ☁️ Other Cloud Providers

For CORS-enabled locations:

💡 Right-click `.zmetadata` to get the URL
→ append to Gridlook URL and remove `.zmetadata`
→ submit

----

- **Google Cloud**  
  [CMIP6 Dataset](https://console.cloud.google.com/marketplace/product/noaa-public/cmip6)

- **AWS**  
  [EURO-CORDEX Dataset](https://registry.opendata.aws/euro-cordex/)

- (**Azure**  
  ❌ Not supported (e.g., [Planetary Computer](https://planetarycomputer.microsoft.com/dataset/gridmet)))

---

## BYODataset

*A minimal guide for DKRZ users:*

1. Make your dataset [CF](https://cfconventions.org/) conform for gridtype identification. Add

    - `grid_mapping` attribute used for *"rotated_lat_lon"* and *"healpix"*
    - coordinates: `lat` and `lon` values
    - better not encode `time` as *"INT64"*
    - (`long_name` attribute to variables)

----

2. Store zarr datasets in DKRZ cloud storage: [swift](https://docs.dkrz.de/doc/datastorage/swift/index.html) (until 2026) and [s3](https://docs.dkrz.de/doc/datastorage/minio/index.html) soon.

```shell
cdo -f nc4c copy INPUT OUTPUT #reformat to zarr
module load swift #login
swift upload BUCKET OUTPUT
```

----

Without temporary output in Python with [swiftspec](https://github.com/fsspec/swiftspec)

```python
import xarray as xr
ds = xr.open_dataset(YOUR_DS_URI)
ds.to_zarr("swift://BUCKET/DS_NAME")
```

Example: [Fsspec intro](https://github.com/eerie-project/EERIE_hackathon_2023/blob/main/nereus/tutorial_cloud_fsspec.ipynb)(EERIE Hackathon 2023)

----

3. Bucket setting: Publish and allow CORS

```bash
swift post BUCKET -r .r:* #publish 
swift post BUCKET -m \
  "X-Container-Meta-Access-Control-Allow-Origin:*" #set CORS
```

----

**Optimal Zarr-datasets for Web-Apps**:

Reduce the amount of transferred data.

- Chunks!
  - aim for 1-5 MB
  - are loaded in parallel (it's ok to load a few)
  - are *cached* (on client-side usually only if smaller than 50MB)

- Compress it!
  - [zarrita supports common algorithms](https://github.com/manzt/zarrita.js/blob/c0dd684dc4da79a6f42ab2a591246947bde8d143/packages/zarrita/src/codecs.ts#L26)


---


## 🔭 Outlook

We have ideas...

![](https://pad.gwdg.de/uploads/2eafff8e-1c3e-4bd4-acc4-09979b749545.png)

----

🎯 **Low-hanging fruits**:

- Sliders for additional dimensions
- URL-based config: default variable, color map, etc.

----

<span style="color: red; font-weight: bold;">-- NEED SUPPORT ** NEED SUPPORT --</span>

✨ Wouldn’t it be cool if Gridlook, the afternoon hack, …

- 🌍 could generate snapshots in python for reproducability?
- ▶️ had a play button for animation of time series for small datasets?
- 🌍 could plot not just data stored in cloud, but also your grid and data, too?
    - Make it a tool including data serving mechanism
    - Support for more complex grid types

----

<span style="color: red; font-weight: bold;">-- NEED SUPPORT ** NEED SUPPORT --</span>

✨ Wouldn’t it be cool if Gridlook, the afternoon hack, …

- 🧵 could be even more efficient?
    - Dynamic level-of-detail rendering depending on scale
    - Improve caching mechanism to load data faster and smarter
    - Parallelize with web-worker

---

## Thank you

Contribute, leave issues or discuss in:

🔗 [https://github.com/d70-t/gridlook](https://github.com/d70-t/gridlook)


🎯 makes **climate science more explorable and tangible**.

