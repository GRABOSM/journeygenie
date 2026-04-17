import { applyB2cRequestTracing, urlNeedsGrabB2cTracing } from '../utils/grabB2cRequestId';
import { minDistanceToPolylineMeters } from '../utils/landmarkRouteProximity';
import { locationToLngLatArray } from '../utils/routeCoordinates';
import { GRAB_MAPS_API_BASE, GRAB_MAPS_API_KEY } from './grabMapsConfig';

/**
 * Grab traffic along a route corridor (real-time segments + incidents).
 * @see https://maps.grab.com/developer/documentation/traffic
 *
 * GET `/api/v1/traffic/real-time/bbox?lat1&lat2&lon1&lon2`
 * GET `/api/v1/traffic/incidents/bbox?lat1&lat2&lon1&lon2&linkReference=GRAB_WAY` (no `types` filter on API)
 */

const TRAFFIC_API_BASE = GRAB_MAPS_API_BASE;
const TRAFFIC_API_KEY = GRAB_MAPS_API_KEY;

const REALTIME_PATH = '/api/v1/traffic/real-time/bbox';
const INCIDENTS_PATH = '/api/v1/traffic/incidents/bbox';

/** Max lat/lon span per incidents request (~5 km; API rejects much larger boxes with 400). */
const INCIDENT_BBOX_MAX_SIDE_DEG = 0.04;
/** Cap parallel incident tile fetches for very large corridors. */
const MAX_INCIDENT_FETCH_TILES = 24;

const DEFAULT_LINK_REFERENCE = String(
  process.env.REACT_APP_GRAB_TRAFFIC_LINK_REFERENCE || 'GRAB_WAY'
).trim() || 'GRAB_WAY';

/** Default CSV for client-side filtering only (API does not accept `types`). */
const DEFAULT_INCIDENT_TYPES = String(
  process.env.REACT_APP_GRAB_TRAFFIC_INCIDENT_TYPES ||
    'accident,construction,roadwork,road_closure,traffic,obstacle,flooding,map_issue,road_condition,other'
).trim();

function isPoliceIncident(incident) {
  if (!incident || typeof incident !== 'object') return false;
  const blob = [
    incident.type,
    incident.incidentType,
    incident.category,
    incident.subtype,
    incident.sub_type,
    incident.title,
    incident.description
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /\bpolice\b|police_activity|police_report|police_check/.test(blob);
}

function severityRank(severity) {
  const s = String(severity || '').toLowerCase();
  if (s === 'critical') return 4;
  if (s === 'high') return 3;
  if (s === 'medium' || s === 'moderate') return 2;
  if (s === 'low') return 1;
  return 0;
}

/** Normalize pickup/dropoff (or [lng,lat]) to { lat, lng } */
function toLatLng(point) {
  if (!point) return null;
  if (Array.isArray(point)) {
    const arr = locationToLngLatArray({ coordinates: point });
    return arr ? { lng: arr[0], lat: arr[1] } : null;
  }
  const arr = locationToLngLatArray(point);
  if (arr) return { lng: arr[0], lat: arr[1] };
  const lat = point.latitude ?? point.lat;
  const lng = point.longitude ?? point.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return { lat, lng };
}

/**
 * Bounding box for traffic APIs: lat1 = south, lat2 = north, lon1 = west, lon2 = east.
 */
export function buildTrafficBoundingBox(pickup, dropoff, routeCoordinates = null, paddingDeg = 0.012) {
  const pts = [];
  [pickup, dropoff].forEach((p) => {
    const ll = toLatLng(p);
    if (ll) pts.push(ll);
  });
  if (Array.isArray(routeCoordinates) && routeCoordinates.length > 0) {
    const step = Math.max(1, Math.floor(routeCoordinates.length / 12));
    for (let i = 0; i < routeCoordinates.length; i += step) {
      const ll = toLatLng(routeCoordinates[i]);
      if (ll) pts.push(ll);
    }
  }
  if (pts.length === 0) return null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  pts.forEach(({ lat, lng }) => {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  });

  const pad = paddingDeg;
  const southLat = Math.max(minLat - pad, -90);
  const northLat = Math.min(maxLat + pad, 90);
  const westLng = Math.max(minLng - pad, -180);
  const eastLng = Math.min(maxLng + pad, 180);

  if (southLat >= northLat || westLng >= eastLng) {
    const eps = 0.001;
    return {
      lat1: Math.max(minLat - eps, -90),
      lat2: Math.min(maxLat + eps, 90),
      lon1: Math.max(minLng - eps, -180),
      lon2: Math.min(maxLng + eps, 180)
    };
  }
  return { lat1: southLat, lat2: northLat, lon1: westLng, lon2: eastLng };
}

function bboxQueryParams(bbox) {
  return {
    lat1: String(Number(bbox.lat1).toFixed(6)),
    lat2: String(Number(bbox.lat2).toFixed(6)),
    lon1: String(Number(bbox.lon1).toFixed(6)),
    lon2: String(Number(bbox.lon2).toFixed(6))
  };
}

function incidentsBboxQueryParams(bbox) {
  return { ...bboxQueryParams(bbox), linkReference: DEFAULT_LINK_REFERENCE };
}

/**
 * Split a bbox into tiles each with lat span and lon span ≤ {@link INCIDENT_BBOX_MAX_SIDE_DEG}.
 * If the grid would exceed {@link MAX_INCIDENT_FETCH_TILES}, shrinks toward the bbox center.
 */
function incidentFetchTiles(bbox) {
  let lat1 = Number(bbox.lat1);
  let lat2 = Number(bbox.lat2);
  let lon1 = Number(bbox.lon1);
  let lon2 = Number(bbox.lon2);
  let dLat = lat2 - lat1;
  let dLon = lon2 - lon1;
  if (!(dLat > 0 && dLon > 0)) {
    return [bbox];
  }

  const S = INCIDENT_BBOX_MAX_SIDE_DEG;
  let nLat = Math.max(1, Math.ceil(dLat / S));
  let nLon = Math.max(1, Math.ceil(dLon / S));
  while (nLat * nLon > MAX_INCIDENT_FETCH_TILES) {
    const factor = Math.sqrt((nLat * nLon) / MAX_INCIDENT_FETCH_TILES);
    const cx = (lat1 + lat2) / 2;
    const cy = (lon1 + lon2) / 2;
    dLat = Math.max(S, dLat / factor);
    dLon = Math.max(S, dLon / factor);
    lat1 = cx - dLat / 2;
    lat2 = cx + dLat / 2;
    lon1 = cy - dLon / 2;
    lon2 = cy + dLon / 2;
    nLat = Math.max(1, Math.ceil(dLat / S));
    nLon = Math.max(1, Math.ceil(dLon / S));
  }

  const tiles = [];
  for (let i = 0; i < nLat; i += 1) {
    const la1 = lat1 + (i * dLat) / nLat;
    const la2 = lat1 + ((i + 1) * dLat) / nLat;
    for (let j = 0; j < nLon; j += 1) {
      const lo1 = lon1 + (j * dLon) / nLon;
      const lo2 = lon1 + ((j + 1) * dLon) / nLon;
      tiles.push({ lat1: la1, lat2: la2, lon1: lo1, lon2: lo2 });
    }
  }
  return tiles;
}

function mergeIncidentLists(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const key =
        item.id != null && item.id !== ''
          ? `id:${item.id}`
          : `${item.startLat}_${item.startLon}_${item.incidentType ?? item.type ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/** Client-side filter when callers pass `incidentTypes` (API returns all types). */
function incidentMatchesTypesCsv(incident, typesCsv) {
  if (typesCsv == null || String(typesCsv).trim() === '') return true;
  const allowed = new Set(
    String(typesCsv)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  if (allowed.size === 0) return true;
  const t = String(incident.type ?? incident.incidentType ?? '')
    .trim()
    .toLowerCase();
  return allowed.has(t);
}

async function trafficGet(path, queryRecord) {
  const params = new URLSearchParams(queryRecord);
  const headers = { Accept: 'application/json' };
  if (TRAFFIC_API_KEY) {
    headers.Authorization = `Bearer ${TRAFFIC_API_KEY}`;
  }
  if (urlNeedsGrabB2cTracing(TRAFFIC_API_BASE)) {
    applyB2cRequestTracing(params, headers);
  }
  const base = TRAFFIC_API_BASE.replace(/\/$/, '');
  const url = `${base}${path}?${params.toString()}`;
  const response = await fetch(url, { method: 'GET', headers });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

/**
 * Real-time traffic segments in bbox (Grab public contract: lat1, lat2, lon1, lon2 only).
 */
export async function fetchTrafficRealTimeBbox(bbox) {
  if (!bbox) return { ok: false, data: null, error: 'no_bbox' };
  try {
    const { response, data } = await trafficGet(REALTIME_PATH, bboxQueryParams(bbox));
    if (!response.ok) {
      return { ok: false, data, error: `http_${response.status}` };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, data: null, error: e?.message || 'fetch_failed' };
  }
}

/**
 * Traffic incidents in bbox (accidents, construction, etc.).
 * Uses `/api/v1/traffic/incidents/bbox` with `linkReference=GRAB_WAY`. Large bboxes are tiled
 * (each side ≤ ~0.04°) because the API rejects oversized boxes. There is no server-side `types` filter.
 */
export async function fetchTrafficIncidentsBbox(bbox) {
  if (!bbox) return { ok: false, data: null, error: 'no_bbox' };
  try {
    const tiles = incidentFetchTiles(bbox);
    const results = await Promise.all(
      tiles.map((tile) => trafficGet(INCIDENTS_PATH, incidentsBboxQueryParams(tile)))
    );

    const mergedLists = [];
    let lastError = 'http_unknown';
    let anyOk = false;
    for (const { response, data } of results) {
      if (response.ok) {
        anyOk = true;
        mergedLists.push(Array.isArray(data?.data) ? data.data : []);
      } else {
        lastError = `http_${response.status}`;
      }
    }

    if (!anyOk) {
      const first = results[0];
      return { ok: false, data: first?.data ?? null, error: lastError };
    }

    return { ok: true, data: { data: mergeIncidentLists(mergedLists) } };
  } catch (e) {
    return { ok: false, data: null, error: e?.message || 'fetch_failed' };
  }
}

/** @deprecated use fetchTrafficRealTimeBbox */
export async function fetchTrafficBbox(bbox) {
  return fetchTrafficRealTimeBbox(bbox);
}

function congestionBucket(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' && !Number.isNaN(raw)) {
    if (raw >= 5) return 'critical';
    if (raw >= 4) return 'high';
    if (raw >= 2) return 'medium';
    return 'low';
  }
  const s = String(raw).toLowerCase();
  if (s.includes('critical') || s === '5') return 'critical';
  if (s.includes('high') || s.includes('severe') || s === '4' || s === '3') return 'high';
  if (s.includes('medium') || s.includes('moderate') || s === '2') return 'medium';
  if (s.includes('low') || s.includes('free') || s === '1' || s === '0') return 'low';
  return null;
}

/** Collect segment-like objects from real-time bbox response */
function extractTrafficSegments(payload) {
  if (!payload || typeof payload !== 'object') return [];

  const out = [];
  const pushObj = (o) => {
    if (o && typeof o === 'object') out.push(o);
  };

  if (payload.traffic_data && typeof payload.traffic_data === 'object') {
    Object.values(payload.traffic_data).forEach(pushObj);
  }
  if (Array.isArray(payload.segments)) payload.segments.forEach(pushObj);
  if (Array.isArray(payload.features)) {
    payload.features.forEach((f) => {
      const p = f?.properties || f;
      pushObj(p);
    });
  }
  if (payload.data && typeof payload.data === 'object') {
    out.push(...extractTrafficSegments(payload.data));
  }
  return out;
}

/** Maps traffic v1 incidents (`data.data[]`: startLat/startLon/incidentType) into the shape used downstream. */
function normalizeTrafficIncidentItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const slat = raw.startLat;
  const slon = raw.startLon;
  if (slat == null || slon == null || slat === '' || slon === '') return raw;
  const lat = Number(slat);
  const lng = Number(slon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return raw;
  return {
    ...raw,
    type: raw.type ?? raw.incidentType,
    location: { lat, lng, latitude: lat, longitude: lng }
  };
}

function extractIncidents(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const list = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.incidents)
      ? payload.incidents
      : [];
  return list.map(normalizeTrafficIncidentItem).filter((i) => i && typeof i === 'object');
}

function segmentCongestion(seg) {
  if (seg?.level != null) {
    const b = congestionBucket(seg.level);
    if (b) return b;
  }
  const candidates = [
    seg.congestion,
    seg.congestion_level,
    seg.congestionLevel,
    seg.level,
    seg.traffic_congestion,
    seg.roadCongestion,
    seg.congestion_index,
    seg.speed_category
  ];
  for (const c of candidates) {
    const b = congestionBucket(c);
    if (b) return b;
  }
  return null;
}

/**
 * One short sentence from real-time segment aggregates.
 */
export function trafficSummaryToRecommendation(segments) {
  if (!segments.length) return null;

  const counts = { low: 0, medium: 0, high: 0, critical: 0, unknown: 0 };
  segments.forEach((seg) => {
    const b = segmentCongestion(seg);
    if (b && counts[b] !== undefined) counts[b] += 1;
    else counts.unknown += 1;
  });

  const heavy = counts.high + counts.critical;
  const moderate = counts.medium;
  const known = counts.low + moderate + heavy;

  if (known === 0 && counts.unknown > 0) {
    return `Live traffic shows ${counts.unknown} road segment${counts.unknown > 1 ? 's' : ''} in this area—allow a little buffer time.`;
  }
  if (known === 0) return null;

  if (counts.critical > 0 || heavy >= 4) {
    return 'Heavy traffic is reported around your route—leave earlier if you can and consider an alternate path.';
  }
  if (heavy >= 1) {
    return 'Notable congestion near your corridor—budget a few extra minutes for this trip.';
  }
  if (moderate >= 3 && heavy === 0) {
    return 'Moderate traffic on some nearby roads—timing is still reasonable, but stay flexible.';
  }
  if (moderate >= 1) {
    return 'Some moderate traffic in the area—light delays are possible.';
  }
  return 'Live traffic looks light along this corridor—good conditions for driving right now.';
}

function incidentsToRecommendation(incidents) {
  if (!incidents.length) return null;
  const high = incidents.filter((i) => String(i.severity || '').toLowerCase() === 'high');
  const types = [...new Set(incidents.map((i) => String(i.type || 'incident').replace(/_/g, ' ')))];
  const typePhrase = types.slice(0, 3).join(', ');
  if (high.length > 0) {
    const d = high[0].description || high[0].title || 'Active incident';
    return `Traffic incidents (${typePhrase}): ${d}${high.length > 1 ? ` (+${high.length - 1} more)` : ''}—check live maps before you go.`;
  }
  const first = incidents[0];
  const desc = first.description || first.title || first.type || 'reported incident';
  return `${incidents.length} incident${incidents.length > 1 ? 's' : ''} near your route (${typePhrase}): ${desc}.`;
}

/**
 * Combined real-time traffic + incidents tip for journey copy (LandingPage / MapView).
 */
export async function getTrafficAwareTravelTip(pickup, dropoff, routeCoordinates = null) {
  const bbox = buildTrafficBoundingBox(pickup, dropoff, routeCoordinates);
  if (!bbox) return null;

  const [realtime, incidents] = await Promise.all([
    fetchTrafficRealTimeBbox(bbox),
    fetchTrafficIncidentsBbox(bbox)
  ]);

  const segments = realtime.ok ? extractTrafficSegments(realtime.data) : [];
  const incList = (incidents.ok ? extractIncidents(incidents.data) : [])
    .filter((i) => incidentMatchesTypesCsv(i, DEFAULT_INCIDENT_TYPES))
    .filter((i) => !isPoliceIncident(i));

  const parts = [];
  const segTip = trafficSummaryToRecommendation(segments);
  if (segTip) parts.push(segTip);
  const incTip = incidentsToRecommendation(incList);
  if (incTip) parts.push(incTip);

  return parts.length ? parts.join(' ') : null;
}

/**
 * Structured traffic + incidents for journey copy (top N, never police).
 * @param {object|null} pickup
 * @param {object|null} dropoff
 * @param {Array<[number, number]>|null} routeCoordinates GeoJSON [lng, lat]
 * @param {{ maxIncidents?: number, incidentTypes?: string }} options
 */
export async function getRouteTrafficJourneyInsights(
  pickup,
  dropoff,
  routeCoordinates = null,
  options = {}
) {
  const maxIncidents = Math.min(5, Math.max(1, Number(options.maxIncidents) || 5));
  const bbox = buildTrafficBoundingBox(pickup, dropoff, routeCoordinates);
  if (!bbox) {
    return { trafficSummary: null, incidents: [] };
  }

  const typesCsv = options.incidentTypes != null ? options.incidentTypes : DEFAULT_INCIDENT_TYPES;
  const [realtime, incidentsRes] = await Promise.all([
    fetchTrafficRealTimeBbox(bbox),
    fetchTrafficIncidentsBbox(bbox)
  ]);

  const segments = realtime.ok ? extractTrafficSegments(realtime.data) : [];
  const trafficSummary = trafficSummaryToRecommendation(segments) || null;

  let list = incidentsRes.ok ? extractIncidents(incidentsRes.data) : [];
  list = list.filter((i) => incidentMatchesTypesCsv(i, typesCsv));
  list = list.filter((i) => !isPoliceIncident(i));

  const seen = new Set();
  list = list.filter((i) => {
    const id = i.id != null && i.id !== '' ? String(i.id) : null;
    const key =
      id ||
      `${i.location?.lat ?? i.location?.latitude ?? ''}_${i.location?.lng ?? i.location?.longitude ?? ''}_${i.type ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const coords = Array.isArray(routeCoordinates) ? routeCoordinates : [];
  const scored = list.map((incident) => {
    const lat = incident.location?.lat ?? incident.location?.latitude;
    const lng = incident.location?.lng ?? incident.location?.longitude;
    let distM = Infinity;
    if (Number.isFinite(lat) && Number.isFinite(lng) && coords.length >= 2) {
      distM = minDistanceToPolylineMeters(coords, lng, lat);
    }
    return { incident, distM, sev: severityRank(incident.severity) };
  });

  scored.sort((a, b) => {
    if (b.sev !== a.sev) return b.sev - a.sev;
    const da = a.distM === Infinity ? 1e12 : a.distM;
    const db = b.distM === Infinity ? 1e12 : b.distM;
    return da - db;
  });

  const incidents = scored.slice(0, maxIncidents).map(({ incident, distM }) => ({
    id: incident.id,
    type: incident.type,
    severity: incident.severity,
    description: incident.description || incident.title || '',
    distanceFromRouteMeters: Number.isFinite(distM) && distM !== Infinity ? Math.round(distM) : null,
    location: incident.location
  }));

  return { trafficSummary, incidents };
}

export { TRAFFIC_API_BASE };
