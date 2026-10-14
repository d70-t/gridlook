/**
 * Adds Jupyter's `_xsrf` token to a same-origin dataset URL.
 *
 * Served by gridlook-jupyter on JupyterHub, the viewer's `fetch()` calls are
 * not cookie-authenticated unless they carry an XSRF token, so stores under
 * the user's own server (`/files/`, the S3 proxy) fail to load. The token is
 * in the `_xsrf` cookie; it is added as a query parameter rather than a header
 * because chunk reads run in web workers, which cannot read cookies, and
 * zarrita's FetchStore copies the query onto every key it requests.
 *
 * Only a page served by gridlook-jupyter (at `<base_url>gridlook/`) adds it,
 * and only to URLs under that same Jupyter server: cookies ignore the port, so
 * a dev server next to a JupyterLab sees Lab's `_xsrf` too, and on a hub
 * another user's server shares the origin. Without the cookie, or for any
 * other URL, the URL is returned unchanged.
 */
export function withXsrfToken(
  url: string,
  cookie: string,
  pageHref: string
): string {
  const page = new URL(pageHref);
  // ponytail: recognises gridlook-jupyter by its route; a plain deployment
  // under a `/gridlook/` path on a host that also runs Jupyter would match too.
  if (!/\/gridlook\/(index\.html)?$/.test(page.pathname)) {
    return url;
  }
  const match = /(?:^|;\s*)_xsrf=([^;]+)/.exec(cookie);
  if (!match) {
    return url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url, page);
  } catch {
    return url;
  }
  const jupyterBase = new URL("..", page);
  if (
    parsed.origin !== page.origin ||
    !parsed.pathname.startsWith(jupyterBase.pathname) ||
    parsed.searchParams.has("_xsrf")
  ) {
    return url;
  }
  // The raw cookie value is the token the server compares against.
  const token = encodeURIComponent(match[1]);
  return `${url}${url.includes("?") ? "&" : "?"}_xsrf=${token}`;
}
