/**
 * Grab Maps Routes / ETA (single key via grabMapsConfig).
 * Docs: https://maps.grab.com/developer/documentation/routes
 *
 * Primary: GET `{base}/api/v1/maps/eta/v1/direction?coordinates=...&profile=...`
 * Optional last resort (same host/key): `/api/v1/maps/eta/v1/navigation` when direction rejects all variants.
 *
 * Internal gateways: REACT_APP_GRAB_NAVIGATION_B2C_TRACING=true + requestID / tracing headers.
 */

import { applyB2cRequestTracing, urlNeedsGrabB2cTracing } from '../utils/grabB2cRequestId';
import { GRAB_MAPS_API_BASE, GRAB_MAPS_API_KEY, isGrabApiConfigured } from './grabMapsConfig';

const GRAB_NAVIGATION_API_BASE = GRAB_MAPS_API_BASE;
const GRAB_NAVIGATION_API_KEY = GRAB_MAPS_API_KEY;

/**
 * Decode encoded polyline to array of [lng, lat] (GeoJSON order).
 * Supports both standard polyline (1e5) and polyline6 (1e6) - MCP default.
 */
function decodePolyline(encoded, precision = 5) {
  if (!encoded || typeof encoded !== 'string') return [];
  const precisionFactor = precision === 6 ? 1e6 : 1e5;
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let b; let shift = 0; let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : result >> 1;
    lng += dlng;

    points.push([lng / precisionFactor, lat / precisionFactor]);
  }
  return points;
}

/**
 * Extract [lng,lat][] from route object — handles encoded polyline, GeoJSON object (b2c-map-service),
 * and overview_polyline string / points.
 */
function extractRouteCoordinates(route) {
  if (!route) return [];

  let geom = route.geometry;
  if (geom && typeof geom === 'object' && geom.type === 'Feature' && geom.geometry) {
    geom = geom.geometry;
  }
  if (geom && typeof geom === 'object' && geom.type === 'LineString' && Array.isArray(geom.coordinates)) {
    const coords = geom.coordinates.filter(
      (c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])
    );
    if (coords.length >= 2) return coords;
  }

  if (geom && typeof geom === 'object' && geom.type === 'MultiLineString' && Array.isArray(geom.coordinates)) {
    const merged = geom.coordinates.flat().filter(
      (c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])
    );
    if (merged.length >= 2) return merged;
  }

  if (typeof geom === 'string' && geom.length > 0) {
    let pts = decodePolyline(geom, 6);
    if (pts.length === 0) pts = decodePolyline(geom, 5);
    if (pts.length >= 2) return pts;
  }

  const op = route.overview_polyline;
  if (typeof op === 'string' && op.length > 0) {
    let pts = decodePolyline(op, 6);
    if (pts.length === 0) pts = decodePolyline(op, 5);
    if (pts.length >= 2) return pts;
  }
  if (op && typeof op === 'object') {
    if (typeof op.points === 'string' && op.points.length > 0) {
      let pts = decodePolyline(op.points, 6);
      if (pts.length === 0) pts = decodePolyline(op.points, 5);
      if (pts.length >= 2) return pts;
    }
    if (Array.isArray(op.coordinates)) {
      const coords = op.coordinates.map((c) =>
        Array.isArray(c) ? c : [c.longitude ?? c.lng, c.latitude ?? c.lat]
      ).filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
      if (coords.length >= 2) return coords;
    }
    // Some backends expose sparse waypoints only — need 3+ points to be a path, not a chord.
    if (Array.isArray(op.steps) && op.steps.length >= 3) {
      const coords = op.steps
        .map((s) => [s.longitude ?? s.lng, s.latitude ?? s.lat])
        .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
      if (coords.length >= 3) return coords;
    }
  }

  if (route.legs?.length > 0) {
    let pts = buildCoordinatesFromSteps(route.legs, 6);
    if (pts.length < 2) pts = buildCoordinatesFromSteps(route.legs, 5);
    if (pts.length >= 2) return pts;
  }

  return [];
}

/**
 * If the direction API returns metrics but no polyline/geometry, connect waypoints with a straight
 * LineString so the map can still render (last resort — not a second routing provider).
 */
function ensureDrawableGeometry(routeResult, coordsArray) {
  const r0 = routeResult?.routes?.[0];
  const coords = r0?.geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) return routeResult;
  if (coordsArray.length >= 2 && r0) {
    r0.geometry = {
      type: 'LineString',
      coordinates: coordsArray.map((pt) => [pt.longitude, pt.latitude])
    };
    console.warn('[Grab direction] Response had no drawable path; drawing straight segment between waypoints');
  }
  return routeResult;
}

/** [lng, lat] from maneuver.location (array or object) */
function maneuverLocationToLngLat(loc) {
  if (!loc) return null;
  if (Array.isArray(loc) && loc.length >= 2 && Number.isFinite(loc[0]) && Number.isFinite(loc[1])) {
    return [loc[0], loc[1]];
  }
  const lng = loc.longitude ?? loc.lng ?? loc[0];
  const lat = loc.latitude ?? loc.lat ?? loc[1];
  if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
  return null;
}

/** Points from step.geometry: encoded polyline, GeoJSON, or short string */
function stepGeometryToPoints(stepGeometry, precision = 5) {
  if (!stepGeometry) return [];
  let g = stepGeometry;
  if (typeof g === 'object' && g.type === 'Feature' && g.geometry) {
    g = g.geometry;
  }
  if (typeof g === 'string' && g.length > 0) {
    let pts = decodePolyline(g, 6);
    if (pts.length === 0) pts = decodePolyline(g, 5);
    return pts;
  }
  if (typeof g === 'object' && g.type === 'LineString' && Array.isArray(g.coordinates)) {
    return g.coordinates.filter(
      (c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])
    );
  }
  return [];
}

/** Encoded line or GeoJSON on a step (field names differ by gateway). */
function stepGeometryPayload(step) {
  if (!step) return null;
  return step.geometry ?? step.polyline ?? step.encoded_polyline ?? step.overview_polyline;
}

/** Build full route coordinates from step geometries when route-level geometry is empty (Grab spec) */
function buildCoordinatesFromSteps(legs, precision = 5) {
  const allCoords = [];
  let lastPoint = null;
  const pushPoint = (p) => {
    if (!p || p.length < 2) return;
    const key = `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
    const lastKey = lastPoint ? `${lastPoint[0].toFixed(6)},${lastPoint[1].toFixed(6)}` : null;
    if (key !== lastKey) {
      allCoords.push(p);
      lastPoint = p;
    }
  };

  legs?.forEach((leg) => {
    (leg.steps || []).forEach((step) => {
      const geom = stepGeometryPayload(step);
      if (geom) {
        stepGeometryToPoints(geom, precision).forEach(pushPoint);
      } else {
        const p = maneuverLocationToLngLat(step.maneuver?.location);
        if (p) pushPoint(p);
      }
    });
  });
  return allCoords;
}

/** How many drawable vertices we can extract (Grab may return metrics without polylines). */
function routePolylinePointCount(route) {
  if (!route) return 0;
  return extractRouteCoordinates(route).length;
}

function unwrapRoutesPayload(data) {
  if (!data) return data;
  if (data.route && !data.routes) {
    return { ...data, routes: [data.route] };
  }
  return data;
}

/**
 * Extract distance (meters) - Grab API can use flat route.distance or nested legs[0].distance.value
 */
function extractDistance(route) {
  const d = route.distance;
  if (typeof d === 'number' && !Number.isNaN(d) && d >= 0) return d;
  if (route.legs?.length > 0) {
    let total = 0;
    for (const leg of route.legs) {
      const ld = leg.distance;
      const v = typeof ld === 'number' ? ld : ld?.value;
      if (typeof v === 'number' && v >= 0) total += v;
    }
    if (total > 0) return total;
  }
  return 0;
}

/**
 * Extract duration (seconds) - Grab API can use flat route.duration or nested legs[0].duration.value
 */
function extractDuration(route) {
  const d = route.duration;
  if (typeof d === 'number' && !Number.isNaN(d) && d >= 0) return d;
  if (route.legs?.length > 0) {
    let total = 0;
    for (const leg of route.legs) {
      const ld = leg.duration;
      const v = typeof ld === 'number' ? ld : ld?.value;
      if (typeof v === 'number' && v >= 0) total += v;
    }
    if (total > 0) return total;
  }
  return 0;
}

/**
 * Normalize Grab direction/navigation response into a single route with GeoJSON LineString.
 * Handles: flat (route.distance), nested (legs[0].distance.value), empty geometry (build from steps)
 */
function normalizeGrabDirectionResponse(grabResponse) {
  const routes = grabResponse?.routes || [];
  if (routes.length === 0) {
    throw new Error(grabResponse?.message || 'Grab direction API error: no routes');
  }
  const route = routes[0];
  const distance = extractDistance(route);
  const duration = extractDuration(route);

  let coordinates = extractRouteCoordinates(route);

  return {
    routes: [{
      distance,
      duration,
      geometry: {
        type: 'LineString',
        coordinates
      },
      legs: route.legs || [{
        distance,
        duration,
        steps: []
      }]
    }]
  };
}

/**
 * Route between points via Grab Maps ETA direction (and optional navigation fallback).
 * Coordinates: array of [lng, lat] (GeoJSON) or { longitude, latitude }.
 * App profile: 'driving' | 'walking' | 'cycling' | 'motorcycle' | 'tricycle'
 * Returns { routes: [{ distance, duration, geometry, legs }] } for the map layer.
 */
export async function getGrabNavigationRoute(coordinates, profile = 'driving') {
  const coordsArray = coordinates.map(c => {
    if (Array.isArray(c)) {
      return { latitude: c[1], longitude: c[0] };
    }
    return { latitude: c.latitude ?? c.lat, longitude: c.longitude ?? c.lng };
  });

  if (coordsArray.length < 2) {
    throw new Error('At least 2 coordinates required for routing');
  }

  if (!isGrabApiConfigured()) {
    throw new Error(
      'Grab Maps not configured: set REACT_APP_GRAB_MAPS_API_KEY for local builds, or REACT_APP_API_PROXY_URL for public deploys (see README)'
    );
  }

  /** Grab route profile strings to try (public docs use driving-car; MCP samples use driving). */
  const profileMap = {
    driving: ['driving-car', 'driving'],
    walking: ['foot-walking', 'walking'],
    cycling: ['bicycle-regular', 'cycling'],
    motorcycle: ['driving-car', 'driving'],
    tricycle: ['driving-car', 'driving']
  };
  const grabProfiles = profileMap[profile] || ['driving-car', 'driving'];

  const useB2c = urlNeedsGrabB2cTracing(GRAB_NAVIGATION_API_BASE);

  const avoidFeatures = String(process.env.REACT_APP_GRAB_DIRECTION_AVOID_FEATURES || '').trim();

  const roundCoord = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(6));
  };

  const appendCoordinates = (p, order) => {
    coordsArray.forEach((c) => {
      const lat = roundCoord(c.latitude);
      const lng = roundCoord(c.longitude);
      p.append('coordinates', order === 'lnglat' ? `${lng},${lat}` : `${lat},${lng}`);
    });
  };

  /** @param {'latlng' | 'lnglat'} order @param {string} grabProfile */
  const buildParams = (order, grabProfile, extras = {}) => {
    const p = new URLSearchParams();
    appendCoordinates(p, order);
    p.set('profile', grabProfile);
    if (avoidFeatures) {
      p.set('preferences.avoid_features', avoidFeatures);
    }
    if (useB2c && order === 'latlng') {
      p.set('lat_first', 'true');
    }
    Object.entries(extras).forEach(([k, v]) => {
      if (v != null && v !== '') p.set(k, String(v));
    });
    return p;
  };

  const headers = { Accept: 'application/json' };
  if (GRAB_NAVIGATION_API_KEY) {
    headers.Authorization = `Bearer ${GRAB_NAVIGATION_API_KEY}`;
  }

  const baseTrim = GRAB_NAVIGATION_API_BASE.replace(/\/$/, '');
  const directionPath = `${baseTrim}/api/v1/maps/eta/v1/direction`;
  const navigationPath = `${baseTrim}/api/v1/maps/eta/v1/navigation`;

  const tryFetch = async (url, params) => {
    const res = await fetch(`${url}?${params.toString()}`, { method: 'GET', headers });
    const body = res.ok ? await res.json().catch(() => null) : null;
    return { response: res, data: body };
  };

  let response = null;
  let data = null;
  /** Public direction often returns 200 + distance/duration with no polylines unless overview/steps/geometries are set — do not stop at the first "OK". */
  const MIN_POLYLINE_VERTICES = 3;

  const directionExtrasVariants = [
    { overview: 'full', details: 'steps', geometries: 'polyline6' },
    { overview: 'full', details: 'steps', geometries: 'polyline' },
    { overview: 'full', details: 'steps', geometries: 'geojson' },
    { overview: 'full', details: 'steps' },
    { overview: 'full', steps: 'true', geometries: 'polyline6' },
    { overview: 'full', steps: 'true', geometries: 'polyline' },
    { overview: 'simplified', steps: 'true', geometries: 'polyline6' }
  ];
  if (!useB2c) {
    directionExtrasVariants.push({});
  }

  const tryDirection = (params) => tryFetch(directionPath, params);

  let lastDirection = { response: null, data: null };
  let bestDirection = { response: null, data: null, n: -1 };
  const recordDirectionAttempt = (res, body) => {
    lastDirection = { response: res, data: body };
    if (!res?.ok || !body?.routes?.length) return;
    const n = routePolylinePointCount(body.routes[0]);
    if (n > bestDirection.n) {
      bestDirection = { response: res, data: body, n };
    }
  };

  if (useB2c) {
    outerB2c: for (const grabProfile of grabProfiles) {
      for (const extras of directionExtrasVariants) {
        for (const order of ['latlng', 'lnglat']) {
          const dirParams = buildParams(order, grabProfile, extras);
          applyB2cRequestTracing(dirParams, headers);
          const { response: r, data: d } = await tryDirection(dirParams);
          recordDirectionAttempt(r, d);
          if (bestDirection.n >= MIN_POLYLINE_VERTICES) break outerB2c;
        }
      }
    }
  } else {
    outer: for (const grabProfile of grabProfiles) {
      for (const order of ['lnglat', 'latlng']) {
        for (const extras of directionExtrasVariants) {
          const p = buildParams(order, grabProfile, extras);
          if (order === 'latlng' && Object.keys(extras).length > 0) {
            p.set('lat_first', 'true');
          }
          const { response: r, data: d } = await tryDirection(p);
          recordDirectionAttempt(r, d);
          if (bestDirection.n >= MIN_POLYLINE_VERTICES) break outer;
        }
      }
    }
  }

  if (bestDirection.response && bestDirection.data) {
    response = bestDirection.response;
    data = bestDirection.data;
  } else {
    response = lastDirection.response;
    data = lastDirection.data;
  }

  const directionVertexCount = data?.routes?.length ? routePolylinePointCount(data.routes[0]) : 0;

  if (!response?.ok || !data?.routes?.length || directionVertexCount < MIN_POLYLINE_VERTICES) {
    const navOrders = useB2c ? ['latlng'] : ['lnglat', 'latlng'];
    const navExtrasVariants = [
      { overview: 'full', steps: 'true', geometries: 'polyline6' },
      { overview: 'full', steps: 'true', geometries: 'polyline' },
      { overview: 'full', details: 'steps', geometries: 'polyline6' },
      { overview: 'full', details: 'steps', geometries: 'polyline' },
      { overview: 'full', details: 'steps' },
      {}
    ];
    let bestNav = { response: null, data: null, n: -1 };
    navOuter: for (const order of navOrders) {
      for (const extras of navExtrasVariants) {
        const navParams = new URLSearchParams();
        appendCoordinates(navParams, order);
        navParams.set('profile', grabProfiles.includes('driving') ? 'driving' : grabProfiles[0]);
        if (order === 'latlng') navParams.set('lat_first', 'true');
        Object.entries(extras).forEach(([k, v]) => {
          if (v != null && v !== '') navParams.set(k, String(v));
        });
        if (useB2c) applyB2cRequestTracing(navParams, headers);
        const { response: r, data: d0 } = await tryFetch(navigationPath, navParams);
        const d = unwrapRoutesPayload(d0);
        if (r.ok && d?.routes?.length) {
          const n = routePolylinePointCount(d.routes[0]);
          if (n > bestNav.n) {
            bestNav = { response: r, data: d, n };
          }
          if (n >= MIN_POLYLINE_VERTICES) break navOuter;
        }
      }
    }
    const pickNav =
      bestNav.response &&
      bestNav.data &&
      bestNav.n > (data?.routes?.length ? routePolylinePointCount(data.routes[0]) : -1);
    if (pickNav) {
      response = bestNav.response;
      data = bestNav.data;
    }
  }

  data = unwrapRoutesPayload(data);

  if (!response?.ok || !data?.routes?.length) {
    const errorText = !response?.ok
      ? await (response && typeof response.text === 'function'
        ? response.text().catch(() => response.statusText || '')
        : Promise.resolve(''))
      : JSON.stringify(data);
    throw new Error(
      `Grab routes API error: ${response?.status || 500} - ${errorText || response?.statusText || ''}`
    );
  }

  // Do not use overview_polyline.steps alone as the route line: it is often only 2 high-level
  // waypoints (straight chord) while the real path lives in route.geometry / overview_polyline.points
  // or legs[].steps[].geometry — normalizeGrabDirectionResponse + extractRouteCoordinates handle those.
  return ensureDrawableGeometry(normalizeGrabDirectionResponse(data), coordsArray);
}

export { decodePolyline, GRAB_NAVIGATION_API_BASE };
