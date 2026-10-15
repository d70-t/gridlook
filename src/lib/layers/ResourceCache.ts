type GeoJSONData = GeoJSON.FeatureCollection<
  GeoJSON.Geometry,
  GeoJSON.GeoJsonProperties
>;

/** Utility class for caching and loading resources like JSON data */
export class ResourceCache {
  // Private constructor to prevent instantiation of this static-only utility class
  private constructor() {}
  private static jsonCache = new Map<string, Promise<GeoJSONData>>();

  static async loadGeoJSON(url: string): Promise<GeoJSONData> {
    const existing = this.jsonCache.get(url);
    if (existing) {
      return existing;
    }

    const promise = fetch(url).then(async (r) => {
      if (!r.ok) {
        throw new Error(`Failed to fetch ${url}: ${r.status}`);
      }
      return (await r.json()) as GeoJSONData;
    });

    promise.catch(() => this.jsonCache.delete(url));
    this.jsonCache.set(url, promise);
    return promise;
  }

  static async loadLandGeoJSON(): Promise<GeoJSONData> {
    return this.loadGeoJSON("static/ne_50m_land.geojson");
  }
}
