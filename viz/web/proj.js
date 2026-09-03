// Coordinate transforms in the browser (no library): Transverse Mercator inverse (Snyder) on GRS80
// for the Japanese Plane Rectangular systems (JGD2000 EPSG:2443-2461, JGD2011 EPSG:6669-6687),
// UTM (EPSG:326xx / 327xx, JGD2000 3097-3101, JGD2011 6688-6692), plus EPSG:4326 / 3857 passthrough.
// Output: Web Mercator (EPSG:3857) metres and lon/lat.

const A = 6378137, F = 1 / 298.257222101, E2 = 2 * F - F * F, R = 6378137;
const d2r = Math.PI / 180, r2d = 180 / Math.PI;
const JPR = [ // [lat0, lon0] of systems I..XIX
  [33, 129.5], [33, 131], [36, 132 + 10 / 60], [33, 133.5], [36, 134 + 20 / 60], [36, 136], [36, 137 + 10 / 60], [36, 138.5], [36, 139 + 50 / 60],
  [40, 140 + 50 / 60], [44, 140 + 15 / 60], [44, 142 + 15 / 60], [44, 144 + 15 / 60], [26, 142], [26, 127.5], [26, 124], [26, 131], [20, 136], [26, 154],
];

/** Returns { kind, lat0, lon0, k0, fe, fn } or null when the CRS is unknown. */
export function crsParams(crs) {
  if (!crs) return null;
  const m = /EPSG:(\d+)/i.exec(crs); if (!m) return null;
  const code = +m[1];
  if (code === 4326) return { kind: 'lonlat' };
  if (code === 3857 || code === 900913) return { kind: 'merc' };
  if (code >= 2443 && code <= 2461) { const [lat0, lon0] = JPR[code - 2443]; return { kind: 'tm', lat0, lon0, k0: 0.9999, fe: 0, fn: 0 }; }
  if (code >= 6669 && code <= 6687) { const [lat0, lon0] = JPR[code - 6669]; return { kind: 'tm', lat0, lon0, k0: 0.9999, fe: 0, fn: 0 }; }
  if (code >= 32601 && code <= 32660) return { kind: 'tm', lat0: 0, lon0: (code - 32600) * 6 - 183, k0: 0.9996, fe: 500000, fn: 0 };
  if (code >= 32701 && code <= 32760) return { kind: 'tm', lat0: 0, lon0: (code - 32700) * 6 - 183, k0: 0.9996, fe: 500000, fn: 10000000 };
  if (code >= 3097 && code <= 3101) return { kind: 'tm', lat0: 0, lon0: (code - 3097 + 51) * 6 - 183, k0: 0.9996, fe: 500000, fn: 0 };
  if (code >= 6688 && code <= 6692) return { kind: 'tm', lat0: 0, lon0: (code - 6688 + 51) * 6 - 183, k0: 0.9996, fe: 500000, fn: 0 };
  return null;
}

function meridianArc(phi) {
  const e4 = E2 * E2, e6 = e4 * E2;
  return A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
}

/** Transverse Mercator inverse (Snyder 1987, eqs. 8-17..8-25). Returns [lon, lat] in degrees. */
export function tmInverse(x, y, p) {
  const ep2 = E2 / (1 - E2), k0 = p.k0;
  const M0 = meridianArc(p.lat0 * d2r);
  const M = M0 + (y - p.fn) / k0;
  const mu = M / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sin1 = Math.sin(phi1), cos1 = Math.cos(phi1), tan1 = Math.tan(phi1);
  const C1 = ep2 * cos1 * cos1, T1 = tan1 * tan1;
  const N1 = A / Math.sqrt(1 - E2 * sin1 * sin1), R1 = A * (1 - E2) / Math.pow(1 - E2 * sin1 * sin1, 1.5);
  const D = (x - p.fe) / (N1 * k0);
  const lat = phi1 - (N1 * tan1 / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = p.lon0 * d2r + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / cos1;
  return [lon * r2d, lat * r2d];
}

export function lonlatToMerc(lon, lat) {
  return [R * lon * d2r, R * Math.log(Math.tan(Math.PI / 4 + lat * d2r / 2))];
}
export function mercToLonlat(x, y) {
  return [x / R * r2d, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * r2d];
}

/** Project arrays of (easting, northing) in `crs` to Web Mercator. Returns { mx, my, lon, lat } (Float64Array) or null. */
export function toMercator(xs, ys, crs) {
  const p = crsParams(crs); if (!p) return null;
  const n = xs.length, mx = new Float64Array(n), my = new Float64Array(n);
  let lonSum = 0, latSum = 0;
  for (let k = 0; k < n; k++) {
    let lon, lat;
    if (p.kind === 'lonlat') { lon = xs[k]; lat = ys[k]; }
    else if (p.kind === 'merc') { [lon, lat] = mercToLonlat(xs[k], ys[k]); }
    else { [lon, lat] = tmInverse(xs[k], ys[k], p); }
    const [x, y] = lonlatToMerc(lon, lat); mx[k] = x; my[k] = y; lonSum += lon; latSum += lat;
  }
  return { mx, my, lon: lonSum / n, lat: latSum / n };
}
