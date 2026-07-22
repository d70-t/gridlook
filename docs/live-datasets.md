# Live Datasets

Gridlook can follow a **live dataset**: a Zarr store whose time axis is fully
declared up front, but where only the currently-available timestep can actually
be fetched at any moment. This is useful for viewing a running simulation or a
rolling forecast as new output appears.

## Enabling live mode

Append the `live=true` parameter to the dataset hash:

```text
https://gridlook.pages.dev/#<ZARR_URI>::live=true
```

When live mode is active, Gridlook:

1. Fetches the currently-available timestep and jumps the time slider to it.
2. Long-polls for the next timestep and, whenever a newer one becomes available,
   re-fetches and re-renders that timestep automatically.
3. Locks the time slider to the live timestep (only one timestep is fetchable at
   a time) and shows a **LIVE** badge with a pause/resume control.

Pausing freezes the currently displayed frame; resuming jumps back to the newest
available timestep and continues following.

Live mode is only supported for datasets served over plain HTTP (Zarr
`FetchStore`), not for Icechunk stores.

## Server contract

The data server must expose two endpoints **next to the Zarr store root**, i.e.
as siblings of the store's metadata:

| Endpoint           | Behaviour                                                     |
| ------------------ | ------------------------------------------------------------- |
| `current-timestep` | Responds **immediately** with the index available right now.  |
| `next-timestep`    | **Long-polls**: responds only once a newer timestep is ready. |

For a store at `https://host/data.zarr`, Gridlook requests
`https://host/data.zarr/current-timestep` and
`https://host/data.zarr/next-timestep`.

Both endpoints must return JSON of the form:

```json
{ "timestep": 42 }
```

where `timestep` is a non-negative integer index into the store's (fixed) time
dimension. The chunk data for that timestep must be fetchable at the moment the
endpoint reports it; earlier/later timesteps may be unavailable.

### Assumptions

- The Zarr array's `shape` and the `time` coordinate values cover the whole run
  and are readable up front. Only the **data-variable chunks** lag — they become
  fetchable once their timestep is reported.
- The reported index is a valid index into that fixed time axis.

### Error handling

If `next-timestep` fails (network drop, `5xx`, missing endpoint), Gridlook
retries with exponential backoff (1s → 30s cap) and shows a subtle
"Reconnecting…" indicator until the connection recovers.

### CORS

As with any dataset, the store and both timestep endpoints must be reachable
from the browser and CORS-enabled when hosted on another origin. See the CORS
notes in the [README](../README.md).
