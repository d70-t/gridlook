declare module "d3-geo-projection" {
  import { GeoProjection } from "d3-geo";

  export function geoRobinson(): GeoProjection;
  export function geoMollweide(): GeoProjection;
}
