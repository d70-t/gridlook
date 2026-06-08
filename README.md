# gridlook

Gridlook is a WebGL-based viewer for Earth system model (ESM) output. It supports cloud-hosted Zarr datasets.

![](docs/assets/showcase.webp)

## Try It Live

Try out the example dataset:

https://gridlook.pages.dev

You can view any CORS-enabled, public Zarr dataset with Gridlook:

```
https://gridlook.pages.dev/#<ZARR_URI>
```

Gridlook can also load catalog JSON files that list multiple datasets. The catalog format and deployment options are documented in [docs/catalogs.md](docs/catalogs.md).

A guide to the viewer keyboard, mouse, and touch interaction is available in [docs/Controls.md](docs/Controls.md).

## Project Setup

This project uses [Node.js](https://nodejs.org/en) and [vue.js](https://vuejs.org/)

```sh
npm install
```

### Compile and Hot-Reload for Development

```sh
npm run dev
```

### Type-Check, Compile and Minify for Production

```sh
npm run build
```

### Lint with [ESLint](https://eslint.org/)

```sh
npm run lint
```

## Usage

The project is served at http://localhost:3000/ when you run `npm run dev`.

## CORS & Hosting Notes

Gridlook loads datasets directly in the browser, so the server hosting the data must allow cross-origin browser requests with [CORS](https://developer.mozilla.org/de/docs/Web/HTTP/Guides/CORS).

To check whether CORS is enabled, open the dataset URL in Gridlook and inspect the browser's developer tools. If the request is blocked, the Console or Network tab usually shows a message such as "blocked by CORS policy" for the dataset metadata or chunk request.

You can also check the response headers with `curl` by sending an `Origin` header:

```sh
curl -I -H "Origin: https://gridlook.pages.dev" "https://s3.eu-dkrz-1.dkrz.cloud/wrcp-hackathon/data/ICON/d3hp003.zarr/P1D_mean_z7_atm"
```

If CORS is enabled for Gridlook, the response should include an `Access-Control-Allow-Origin` header that matches the origin or allows all origins with `*`:

```
access-control-allow-origin: https://gridlook.pages.dev
```

If you run the data server yourself, ask your server administrator before relaxing CORS settings, especially before allowing requests from every origin. Broad CORS permissions can expose data to untrusted websites and may conflict with your organization's security policy.
