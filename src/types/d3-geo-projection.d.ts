declare module "d3-geo-projection" {
  import { GeoProjection } from "d3";

  export function geoWinkel3(): GeoProjection;
  export function geoAitoff(): GeoProjection;
  export function geoArmadillo(): GeoProjection;
  export function geoAugust(): GeoProjection;
  export function geoBaker(): GeoProjection;
  export function geoBerghaus(): GeoProjection;
  export function geoBoggs(): GeoProjection;
  export function geoBonne(): GeoProjection;
  export function geoBottomley(): GeoProjection;
  export function geoBromley(): GeoProjection;
  export function geoChamberlin(
    point1: [number, number],
    point2: [number, number],
    point3: [number, number]
  ): GeoProjection;
  export function geoCollignon(): GeoProjection;
  export function geoCraig(): GeoProjection;
  export function geoCraster(): GeoProjection;
  export function geoCylindricalEqualArea(): GeoProjection;
  export function geoCylindricalStereographic(): GeoProjection;
  export function geoEckert1(): GeoProjection;
  export function geoEckert2(): GeoProjection;
  export function geoEckert3(): GeoProjection;
  export function geoEckert4(): GeoProjection;
  export function geoEckert5(): GeoProjection;
  export function geoEckert6(): GeoProjection;
  export function geoEisenlohr(): GeoProjection;
  export function geoFahey(): GeoProjection;
  export function geoFoucaut(): GeoProjection;
  export function geoGilbert(type?: string): GeoProjection;
  export function geoGingery(): GeoProjection;
  export function geoGinzburg4(): GeoProjection;
  export function geoGinzburg5(): GeoProjection;
  export function geoGinzburg6(): GeoProjection;
  export function geoGinzburg8(): GeoProjection;
  export function geoGinzburg9(): GeoProjection;
  export function geoGringorten(): GeoProjection;
  export function geoGuyou(): GeoProjection;
  export function geoHammer(): GeoProjection;
  export function geoHammerRetroazimuthal(): GeoProjection;
  export function geoHealpix(): GeoProjection;
  export function geoHill(): GeoProjection;
  export function geoHomolosine(): GeoProjection;
  export function geoKavrayskiy7(): GeoProjection;
  export function geoLagrange(): GeoProjection;
  export function geoLarrivee(): GeoProjection;
  export function geoLaskowski(): GeoProjection;
  export function geoLittrow(): GeoProjection;
  export function geoLoximuthal(): GeoProjection;
  export function geoMiller(): GeoProjection;
  export function geoModifiedStereographic(
    coefficients: number[][],
    rotate: [number, number]
  ): GeoProjection;
  export function geoModifiedStereographicAlaska(): GeoProjection;
  export function geoModifiedStereographicGs48(): GeoProjection;
  export function geoModifiedStereographicGs50(): GeoProjection;
  export function geoModifiedStereographicMiller(): GeoProjection;
  export function geoModifiedStereographicLee(): GeoProjection;
  export function geoMollweide(): GeoProjection;
  export function geoMtFlatPolarParabolic(): GeoProjection;
  export function geoMtFlatPolarQuartic(): GeoProjection;
  export function geoMtFlatPolarSinusoidal(): GeoProjection;
  export function geoNaturalEarth(): GeoProjection;
  export function geoNaturalEarth2(): GeoProjection;
  export function geoNellHammer(): GeoProjection;
  export function geoPatterson(): GeoProjection;
  export function geoPolyconic(): GeoProjection;
  export function geoRectangularPolyconic(): GeoProjection;
  export function geoRobinson(): GeoProjection;
  export function geoSatellite(): GeoProjection;
  export function geoSinusoidal(): GeoProjection;
  export function geoSinuMollweide(): GeoProjection;
  export function geoTimes(): GeoProjection;
  export function geoVanDerGrinten(): GeoProjection;
  export function geoVanDerGrinten2(): GeoProjection;
  export function geoVanDerGrinten3(): GeoProjection;
  export function geoVanDerGrinten4(): GeoProjection;
  export function geoWagner4(): GeoProjection;
  export function geoWagner6(): GeoProjection;
  export function geoWagner7(): GeoProjection;
  export function geoWiechel(): GeoProjection;
}
