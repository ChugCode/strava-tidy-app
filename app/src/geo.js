// Shared geometry helpers (pure, no platform APIs).
export const R_EARTH = 6371000.0;

const rad = (d) => (d * Math.PI) / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const f1 = rad(lat1);
  const f2 = rad(lat2);
  const a = Math.sin((f2 - f1) / 2) ** 2 +
    Math.cos(f1) * Math.cos(f2) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

/** Local equirectangular projection around a centre (metres). */
export class Frame {
  constructor(lat0, lon0) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.kx = rad(1) * R_EARTH * Math.cos(rad(lat0));
    this.ky = rad(1) * R_EARTH;
  }

  fwd(lat, lon) {
    return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky];
  }

  inv(x, y) {
    return [this.lat0 + y / this.ky, this.lon0 + x / this.kx];
  }
}

/** Id shared by every parser so ways meeting at one coordinate connect. */
export function coordId(lat, lon) {
  return `${lat.toFixed(7)},${lon.toFixed(7)}`;
}
