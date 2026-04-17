/**
 * Distance from a point to a polyline (GeoJSON [lng, lat] vertices) in meters.
 * Uses a local ENU plane per segment (adequate for short corridor checks).
 */

const R = 6371000;

function enOffset(lat0, lng0, lat, lng) {
  const rad = Math.PI / 180;
  return {
    x: R * (lng - lng0) * rad * Math.cos(lat0 * rad),
    y: R * (lat - lat0) * rad
  };
}

function pointToSegmentDistance2D(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  if (ab2 < 1e-6) return Math.hypot(apx, apy);
  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

/**
 * @param {Array<[number, number]>} routeCoords [lng, lat][]
 * @param {number} lng
 * @param {number} lat
 */
export function minDistanceToPolylineMeters(routeCoords, lng, lat) {
  if (!Array.isArray(routeCoords) || routeCoords.length < 2) return Infinity;
  let min = Infinity;
  const step = routeCoords.length > 2500 ? Math.ceil(routeCoords.length / 2000) : 1;
  for (let i = 0; i < routeCoords.length - 1; i += step) {
    const [lng1, lat1] = routeCoords[i];
    const [lng2, lat2] = routeCoords[i + 1];
    if (![lng1, lat1, lng2, lat2].every(Number.isFinite)) continue;
    const lat0 = (lat1 + lat2) / 2;
    const lng0 = (lng1 + lng2) / 2;
    const p = enOffset(lat0, lng0, lat, lng);
    const a = enOffset(lat0, lng0, lat1, lng1);
    const b = enOffset(lat0, lng0, lat2, lng2);
    const d = pointToSegmentDistance2D(p.x, p.y, a.x, a.y, b.x, b.y);
    if (d < min) min = d;
  }
  return min;
}

/**
 * @param {Array<[number, number]>} routeCoords [lng, lat][]
 * @param {Array<object>} landmarks POIs with .location.latitude / .longitude
 * @param {number} maxMeters max perpendicular distance to polyline
 */
export function filterLandmarksNearRoute(routeCoords, landmarks, maxMeters = 220) {
  if (!Array.isArray(landmarks) || !landmarks.length) return [];
  return landmarks.filter((lm) => {
    const lat = lm.location?.latitude ?? lm.location?.lat;
    const lng = lm.location?.longitude ?? lm.location?.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    return minDistanceToPolylineMeters(routeCoords, lng, lat) <= maxMeters;
  });
}

export function sortLandmarksByPolylineDistance(routeCoords, landmarks) {
  return [...landmarks].sort((a, b) => {
    const la = a.location?.latitude ?? a.location?.lat;
    const lna = a.location?.longitude ?? a.location?.lng;
    const lb = b.location?.latitude ?? b.location?.lat;
    const lnb = b.location?.longitude ?? b.location?.lng;
    const da = minDistanceToPolylineMeters(routeCoords, lna, la);
    const db = minDistanceToPolylineMeters(routeCoords, lnb, lb);
    return da - db;
  });
}
