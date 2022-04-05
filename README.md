# gridlook

Javascript based viewer for ICON model output on native grid.

## note

When deployed, this website will do CORS requests towards the DKRZ swift server. These requests must be allowed on the server side.
According to [the docs](https://docs.openstack.org/swift/latest/cors.html) this is possible using container metadata.
Using the `swift` tool, you can set the required configuration using:
```
swift post nextGEMS -m "X-Container-Meta-Access-Control-Allow-Origin:*"
```
for the `nextGEMS` container.

This template should help get you started developing with Vue 3 in Vite.

## vue & npm

this project uses vue.js and npm

## Customize configuration

See [Vite Configuration Reference](https://vitejs.dev/config/).

## Project Setup

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
