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
