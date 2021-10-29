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


## running locally

To test this locally, you'll need a development webserver. About any will do, but some are a little bit nicer than others.
If you prefer python, use
```
python -m http.server
```

If you like to have automatic reload capability build in, you can try `five-server`.
Install it using
```
npm -g i five-server
```

and run it using
```
five-server .
```
