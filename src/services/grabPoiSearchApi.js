/**
 * Grab POI Search API Service
 * Uses /api/v1/maps/poi/v1/search and /api/v1/maps/place/v2/nearby on the same Grab Maps host (one key).
 */

import { applyB2cRequestTracing, urlNeedsGrabB2cTracing } from '../utils/grabB2cRequestId';
import { GRAB_MAPS_API_BASE, grabMapsJsonHeaders } from './grabMapsConfig';

function trimSlash(s) {
  return String(s || '')
    .trim()
    .replace(/\/+$/, '');
}

const GRAB_POI_API_BASE =
  trimSlash(process.env.REACT_APP_GRAB_POI_API_URL || '') || GRAB_MAPS_API_BASE;

/**
 * Best-effort first photo URL from Grab / legacy place payloads (field names vary by API version).
 */
export function extractPlacePhotoUrl(place) {
  if (!place || typeof place !== 'object') return null;
  if (Array.isArray(place.photos) && place.photos.length) {
    const first = place.photos[0];
    if (typeof first === 'string') return first;
    return first.url || first.uri || first.photoUri || first.photo_uri || null;
  }
  const urls = place.photo_urls || place.photoUrls;
  if (Array.isArray(urls) && urls[0]) return urls[0];
  if (typeof place.coverImage === 'string') return place.coverImage;
  if (place.cover_image?.url) return place.cover_image.url;
  if (typeof place.hero_image === 'string') return place.hero_image;
  if (place.heroImage?.url) return place.heroImage.url;
  if (place.image_url) return place.image_url;
  if (place.imageUrl) return place.imageUrl;
  return null;
}

// Country code mapping for Southeast Asian countries (MCP uses ISO 3166-1 alpha-3)
const COUNTRY_CODE_MAP = {
  singapore: 'SGP',
  indonesia: 'IDN',
  thailand: 'THA',
  malaysia: 'MYS',
  philippines: 'PHL',
  vietnam: 'VNM',
  myanmar: 'MMR',
  cambodia: 'KHM'
};

function normalizeCoord(value) {
  if (value == null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Best-effort lat/lng from Grab POI payloads (field names and types vary).
 * API sometimes returns numeric coordinates as strings; without Number(), UI bounds checks fail.
 */
function locationFromPlace(place) {
  if (!place || typeof place !== 'object') {
    return { latitude: undefined, longitude: undefined };
  }
  const loc = place.location;
  if (loc && typeof loc === 'object') {
    const latitude = normalizeCoord(loc.latitude ?? loc.lat);
    const longitude = normalizeCoord(loc.longitude ?? loc.lng);
    if (latitude != null && longitude != null) {
      return { latitude, longitude };
    }
  }
  const coords = place.geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    const longitude = normalizeCoord(coords[0]);
    const latitude = normalizeCoord(coords[1]);
    if (latitude != null && longitude != null) {
      return { latitude, longitude };
    }
  }
  const latitude = normalizeCoord(place.latitude ?? place.lat);
  const longitude = normalizeCoord(place.longitude ?? place.lng);
  if (latitude != null && longitude != null) {
    return { latitude, longitude };
  }
  return { latitude: undefined, longitude: undefined };
}

function transformMcpPlaceToPoi(place, userLocation, calculateDistance) {
  const location = locationFromPlace(place);
  let distance = null;
  if (userLocation && location.latitude != null && location.longitude != null) {
    distance = calculateDistance(
      userLocation.latitude,
      userLocation.longitude,
      location.latitude,
      location.longitude
    );
  }
  return {
    id: place.poi_id ?? place.id,
    name: place.name || 'Unknown Location',
    address:
      place.formatted_address ||
      (typeof place.address === 'string' ? place.address : place.address?.full) ||
      'No address available',
    phone: place.phone_number || null,
    location: {
      latitude: location.latitude,
      longitude: location.longitude
    },
    businessType: place.business_type,
    category: place.category,
    attributes: place.attribute || [],
    openingHours: place.opening_hours,
    popularity: place.Popularity || place.popularity,
    techFamilies: place.techFamilies || place.tech_families || [],
    distance,
    score: place.score,
    photoUrl: extractPlacePhotoUrl(place)
  };
}

/**
 * Transform alternate Grab/place payload shapes to component POI format
 */
function transformLegacyPlaceToPoi(place, userLocation, calculateDistance) {
  const location = locationFromPlace(place);
  let distance = null;
  if (userLocation && location.latitude != null && location.longitude != null) {
    distance = calculateDistance(
      userLocation.latitude,
      userLocation.longitude,
      location.latitude,
      location.longitude
    );
  }
  return {
    id: place.id || place.poi_id,
    name: place.name || place.languageSpecificNames?.en || 'Unknown Location',
    address:
      place.formattedAddress ||
      place.formatted_address ||
      (typeof place.address === 'string' ? place.address : place.addressNative) ||
      'No address available',
    phone: place.phoneNumber || place.phone_number || null,
    location: {
      latitude: location.latitude,
      longitude: location.longitude
    },
    businessType: place.businessType || place.business_type,
    category: place.category,
    attributes: place.attribute || [],
    openingHours: place.openingHours || place.opening_hours,
    popularity: place.Popularity || place.popularity,
    techFamilies: place.techFamilies || place.tech_families || [],
    distance,
    score: place.score,
    photoUrl: extractPlacePhotoUrl(place)
  };
}

/** API max radius in meters (Grab POI search). @see https://maps.grab.com/developer/documentation/searching */
export const GRAB_POI_SEARCH_RADIUS_MAX_METERS = 50000;

/** Place v2 nearby search path (same base URL + Bearer key as POI search). */
export const GRAB_PLACE_NEARBY_PATH = '/api/v1/maps/place/v2/nearby';

/**
 * Nearby places from Grab Place v2 (location + radius + rankBy).
 * Response uses `places` (same transform pipeline as POI search where fields overlap).
 *
 * @param {Object} options
 * @param {number} options.lat - Anchor latitude
 * @param {number} options.lng - Anchor longitude
 * @param {number} [options.limit=20] - Result cap (1–100)
 * @param {number} [options.radius] - Radius in meters (clamped to {@link GRAB_POI_SEARCH_RADIUS_MAX_METERS})
 * @param {string} [options.rankBy='distance'] - e.g. `distance`
 * @param {Object} [options.userLocation] - For distance fields on transformed POIs
 * @param {Function} [options.calculateDistance] - Haversine helper (km) when userLocation set
 * @returns {Promise<Array>} Transformed POI-shaped list
 */
export async function searchGrabNearbyPlaces({
  lat,
  lng,
  limit = 20,
  radius,
  rankBy = 'distance',
  userLocation,
  calculateDistance = () => null
}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return [];
  }

  const params = new URLSearchParams();
  params.set('location', `${lat},${lng}`);
  params.set('limit', String(Math.max(1, Math.min(100, Math.round(Number(limit)) || 20))));

  if (rankBy != null && String(rankBy).trim() !== '') {
    params.set('rankBy', String(rankBy).trim());
  }

  if (radius != null && Number.isFinite(Number(radius))) {
    const r = Math.min(
      GRAB_POI_SEARCH_RADIUS_MAX_METERS,
      Math.max(1, Math.round(Number(radius)))
    );
    params.set('radius', String(r));
  }

  const baseTrim = GRAB_POI_API_BASE.replace(/\/$/, '');

  try {
    const headers = grabMapsJsonHeaders({ omitJsonContentType: true });
    if (urlNeedsGrabB2cTracing(GRAB_POI_API_BASE)) {
      applyB2cRequestTracing(params, headers);
    }
    const url = `${baseTrim}${GRAB_PLACE_NEARBY_PATH}?${params.toString()}`;
    const response = await fetch(url, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      const hint =
        response.status === 401
          ? ' (check REACT_APP_GRAB_MAPS_API_KEY; internal gateways need REACT_APP_GRAB_NAVIGATION_B2C_TRACING=true + requestID — now applied automatically when hostname matches b2c/engtools)'
          : '';
      console.warn('Grab Place nearby HTTP', response.status, response.statusText, hint);
      return [];
    }

    const data = await response.json();
    const rawList = data.places ?? data.results;
    if (!rawList || !Array.isArray(rawList)) {
      return [];
    }

    return rawList.map((place) => {
      if (place.poi_id && place.formatted_address !== undefined) {
        return transformMcpPlaceToPoi(place, userLocation, calculateDistance);
      }
      return transformLegacyPlaceToPoi(place, userLocation, calculateDistance);
    });
  } catch (error) {
    console.error('Grab Place nearby failed:', error?.message || error);
    return [];
  }
}

/**
 * Search for POIs using Grab Maps POI API.
 * Query params follow Grab docs: keyword, location, country, radius, category, limit, bounds.
 * @see https://maps.grab.com/developer/documentation/searching
 *
 * @param {Object} options
 * @param {string} options.keyword - Search query (3+ characters recommended)
 * @param {number} [options.lat] - Bias latitude when sending location
 * @param {number} [options.lng] - Bias longitude when sending location
 * @param {string|null} [options.country] - App country key → alpha-3; pass null with bounds to omit
 * @param {number} [options.limit=20] - Result cap (default 10–20 per docs)
 * @param {number} [options.radius] - Search radius in meters (clamped to max 50000)
 * @param {string} [options.bounds] - Bbox "southWestLat,southWestLon,northEastLat,northEastLon"
 * @param {string} [options.category] - Optional category (e.g. restaurant, atm)
 * @param {Object} [options.userLocation] - For distance fields in transformed POIs
 * @param {Function} [options.calculateDistance] - Haversine distance function
 * @returns {Promise<Array>} Transformed POI array
 */
export async function searchGrabPois({
  keyword,
  lat,
  lng,
  country = 'singapore',
  limit = 20,
  radius,
  bounds,
  category,
  userLocation,
  calculateDistance = () => null
}) {
  const params = new URLSearchParams();
  params.set('keyword', keyword.trim());
  params.set('limit', String(Math.max(1, Math.min(100, Math.round(Number(limit)) || 20))));

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    params.set('location', `${lat},${lng}`);
  }

  if (bounds != null && String(bounds).trim() !== '') {
    params.set('bounds', String(bounds).trim());
  }

  if (category != null && String(category).trim() !== '') {
    params.set('category', String(category).trim());
  }

  if (radius != null && Number.isFinite(Number(radius))) {
    const r = Math.min(
      GRAB_POI_SEARCH_RADIUS_MAX_METERS,
      Math.max(1, Math.round(Number(radius)))
    );
    params.set('radius', String(r));
  }

  // Omit country when explicitly null/empty so bbox-only searches are not forced into
  // the wrong territory (e.g. map panned to KL while route state still has SGP).
  if (country != null && String(country).trim() !== '') {
    const alpha3 = COUNTRY_CODE_MAP[country];
    if (alpha3) params.set('country', alpha3);
  }

  const baseTrim = GRAB_POI_API_BASE.replace(/\/$/, '');
  const path = '/api/v1/maps/poi/v1/search';

  try {
    const headers = grabMapsJsonHeaders({ omitJsonContentType: true });
    if (urlNeedsGrabB2cTracing(GRAB_POI_API_BASE)) {
      applyB2cRequestTracing(params, headers);
    }
    const url = `${baseTrim}${path}?${params.toString()}`;
    const response = await fetch(url, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      const hint =
        response.status === 401
          ? ' (check REACT_APP_GRAB_MAPS_API_KEY; internal gateways need REACT_APP_GRAB_NAVIGATION_B2C_TRACING=true + requestID — now applied automatically when hostname matches b2c/engtools)'
          : '';
      console.warn('Grab POI search HTTP', response.status, response.statusText, hint);
      return [];
    }

    const data = await response.json();

    const rawList = data.places || data.results;
    if (rawList && Array.isArray(rawList)) {
      const transformFn = (place) => {
        if (place.poi_id && place.formatted_address !== undefined) {
          return transformMcpPlaceToPoi(place, userLocation, calculateDistance);
        }
        return transformLegacyPlaceToPoi(place, userLocation, calculateDistance);
      };
      return rawList.map(transformFn);
    }

    return [];
  } catch (error) {
    console.error('Grab POI search failed:', error?.message || error);
    return [];
  }
}

export { COUNTRY_CODE_MAP, GRAB_POI_API_BASE };
