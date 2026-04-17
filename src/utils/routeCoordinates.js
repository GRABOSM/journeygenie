/**
 * Canonical GeoJSON [lng, lat] for Grab direction API and map geometry.
 * Handles `.location` objects and ambiguous `[lat, lng]` arrays from legacy payloads.
 */
export function locationToLngLatArray(loc) {
  if (!loc) return null;
  if (loc.location?.longitude != null && loc.location?.latitude != null) {
    const lng = Number(loc.location.longitude);
    const lat = Number(loc.location.latitude);
    if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
  }
  if (Array.isArray(loc.coordinates) && loc.coordinates.length >= 2) {
    const a = Number(loc.coordinates[0]);
    const b = Number(loc.coordinates[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const aAbs = Math.abs(a);
    const bAbs = Math.abs(b);
    if (aAbs <= 55 && bAbs >= 40 && bAbs <= 180) {
      if (aAbs < bAbs && b > a - 60) {
        return [b, a];
      }
    }
    return [a, b];
  }
  return null;
}
