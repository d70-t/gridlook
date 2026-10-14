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
 * Without the cookie (any non-Jupyter deployment) or for another origin, the
 * URL is returned unchanged, so the token never leaves the server it came from.
 */
export function withXsrfToken(
  url: string,
  cookie: string,
  pageHref: string
): string {
  const match = /(?:^|;\s*)_xsrf=([^;]+)/.exec(cookie);
  if (!match) {
    return url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url, pageHref);
  } catch {
    return url;
  }
  if (
    parsed.origin !== new URL(pageHref).origin ||
    parsed.searchParams.has("_xsrf")
  ) {
    return url;
  }
  const token = encodeURIComponent(decodeURIComponent(match[1]));
  return `${url}${url.includes("?") ? "&" : "?"}_xsrf=${token}`;
}
