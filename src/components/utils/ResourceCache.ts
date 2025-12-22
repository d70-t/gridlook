import albedo from "../../assets/earth.jpg";

type GeoJSONData = GeoJSON.FeatureCollection<
  GeoJSON.Geometry,
  GeoJSON.GeoJsonProperties
>;

/** Utility class for caching and loading resources like images and JSON data */
export class ResourceCache {
  // Private constructor to prevent instantiation of this static-only utility class
  private constructor() {}
  private static imageCache = new Map<string, Promise<HTMLImageElement>>();
  private static jsonCache = new Map<string, Promise<GeoJSONData>>();

  static async loadImage(url: string): Promise<HTMLImageElement> {
    const existing = this.imageCache.get(url);
    if (existing) return existing;

    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = url;
      img.onload = () => resolve(img);
      img.onerror = (e) => {
        this.imageCache.delete(url);
        reject(e);
      };
    });

    this.imageCache.set(url, promise);
    return promise;
  }

  static async loadGeoJSON(url: string): Promise<GeoJSONData> {
    const existing = this.jsonCache.get(url);
    if (existing) return existing;

    const promise = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
      return (await r.json()) as GeoJSONData;
    });

    promise.catch(() => this.jsonCache.delete(url));
    this.jsonCache.set(url, promise);
    return promise;
  }

  static async loadLandGeoJSON(): Promise<GeoJSONData> {
    return this.loadGeoJSON("static/ne_50m_land.geojson");
  }

  static async loadEarthTexture(): Promise<HTMLImageElement> {
    return this.loadImage(albedo);
  }
}
