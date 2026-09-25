/**
 * URL construction for the viewer tab, kept free of JupyterLab imports so it
 * can be unit-tested on its own.
 *
 * The viewer is the SPA served by the gridlook-jupyter server extension at
 * `<baseUrl>/gridlook/`; a dataset is handed to it in the hash as the URL the
 * SPA should fetch it from — here jupyter's own `/files/` handler, which
 * serves the user's files with their session.
 */

/**
 * `<base>/<parts...>`. The base is whatever `ServerConnection.makeSettings()`
 * reports: an absolute URL (`http://host:8888/`) or a path (`/user/x/`); a
 * scheme+host prefix is kept and the path part's surrounding slashes are
 * normalized away.
 */
function underBase(baseUrl: string, ...parts: string[]): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)?(.*)$/i.exec(baseUrl);
  const origin = m?.[1] ?? "";
  const base = (m?.[2] ?? "").replace(/^\/+|\/+$/g, "");
  return origin + "/" + [base, ...parts].filter((p) => p.length > 0).join("/");
}

/** `<baseUrl>/gridlook/` — the extension-served SPA. */
export function viewerUrl(baseUrl: string): string {
  return underBase(baseUrl, "gridlook") + "/";
}

/**
 * `<baseUrl>/files/<path>` with every path segment passed through
 * `encodeURIComponent`, which escapes spaces, `#`, `?` and `:`, so a `::` in a
 * name cannot forge the SPA's hash parameter separator.
 */
export function dataUrl(baseUrl: string, path: string): string {
  const segments = path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s));
  return underBase(baseUrl, "files", ...segments);
}

/**
 * The iframe src: the viewer, plus `#<data url>` when a path is given. With
 * no path (the launcher card) the viewer opens on its own start page.
 */
export function viewerSrc(baseUrl: string, path?: string): string {
  const viewer = viewerUrl(baseUrl);
  return path ? `${viewer}#${dataUrl(baseUrl, path)}` : viewer;
}
