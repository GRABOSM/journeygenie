/**
 * Local tips: static fallbacks plus optional Grab POI search (restaurants near destination).
 * @see https://maps.grab.com/developer/documentation/searching
 */

import {
  searchGrabPois,
  searchGrabNearbyPlaces,
  GRAB_POI_SEARCH_RADIUS_MAX_METERS
} from '../services/grabPoiSearchApi';
import { locationToLngLatArray } from './routeCoordinates';

/**
 * Hard max distance (meters) from drop-off for dining picks.
 * Grab POI `radius` is only a search bias — we still filter by straight-line distance client-side.
 */
/** Preferred max straight-line distance from the destination pin for picks (meters). */
export const DESTINATION_DINING_SEARCH_RADIUS_METERS = 1200;

/**
 * If the API returns POIs but none fall within {@link DESTINATION_DINING_SEARCH_RADIUS_METERS},
 * we still rank the closest ones up to this distance (dense campuses / lobby geocodes).
 */
export const DESTINATION_DINING_RELAXED_MAX_METERS = 2500;

/** Upper bound for user-facing copy (alerts, disclaimers). */
export const DESTINATION_DINING_DISPLAY_MAX_METERS = DESTINATION_DINING_RELAXED_MAX_METERS;

export const DESTINATION_DINING_TOP_N = 3;

const BASE_LOCAL_TIPS = [
  'Download offline maps before departing for backup navigation',
  'Keep some local currency handy for tolls and street food',
  'Window seats on the right often offer better city views',
  "Local drivers are friendly — don't hesitate to ask for recommendations!",
  'Street food vendors near landmarks serve authentic local cuisine',
  'Many shopping malls have rooftop viewpoints worth visiting',
  'Temple visits require modest clothing — keep a light jacket handy',
  'Night markets come alive after sunset for a different experience'
];

function pickupCountFromPopularity(pop) {
  if (pop == null || typeof pop !== 'object') return 0;
  const n = Number(pop.pickupCount ?? pop.pickup_count ?? pop.PickupCount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Prefer Grab `score`, then popularity pickup signals (ordering matches typical Grab ranking). */
function grabRestaurantRank(poi) {
  const score = typeof poi.score === 'number' && !Number.isNaN(poi.score) ? poi.score : Number(poi.score) || 0;
  const pickups = pickupCountFromPopularity(poi.popularity);
  return score * 1e9 + pickups;
}

const EARTH_RADIUS_M = 6371000;

/** Haversine distance in meters (WGS84). */
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

function distanceFromDropoffMeters(poi, originLat, originLng) {
  const plat = Number(poi?.location?.latitude);
  const plng = Number(poi?.location?.longitude);
  if (!Number.isFinite(plat) || !Number.isFinite(plng)) return Infinity;
  return haversineDistanceMeters(originLat, originLng, plat, plng);
}

/** Keep only POIs whose coordinates lie within `maxMeters` of the drop-off (API may return distant matches). */
function filterPoisWithinRadiusMeters(pois, originLat, originLng, maxMeters) {
  return pois.filter((p) => distanceFromDropoffMeters(p, originLat, originLng) <= maxMeters);
}

function dedupeRestaurantsById(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const k = p.id != null && p.id !== '' ? String(p.id) : `${p.name}-${p.location?.latitude}-${p.location?.longitude}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** Heuristic filter: Place nearby returns mixed POIs; keep food-related rows for dining picks. */
function poiLooksFoodRelated(poi) {
  const bt = String(poi.businessType || '').toLowerCase();
  const cat = String(poi.category || '').toLowerCase();
  const name = String(poi.name || '').toLowerCase();
  const hay = `${bt} ${cat}`;
  const tokens = [
    'restaurant',
    'food',
    'cafe',
    'coffee',
    'dining',
    'eatery',
    'bakery',
    'bistro',
    'bar',
    'pub',
    'hawker',
    'food_court',
    'meal',
    'kitchen',
    'grill',
    'steakhouse',
    'seafood',
    'fast_food',
    'foodcourt',
    'kopitiam'
  ];
  if (tokens.some((t) => hay.includes(t))) return true;
  if (tokens.some((t) => name.includes(t))) return true;
  return false;
}

function formatLocationLine(poi) {
  const addr = (poi.address || '').replace(/\s+/g, ' ').trim();
  const lat = poi.location?.latitude;
  const lng = poi.location?.longitude;
  const coords =
    Number.isFinite(lat) && Number.isFinite(lng) ? `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}` : '';
  if (addr && addr !== 'No address available') return addr;
  if (coords) return coords;
  return 'near your drop-off';
}

/** Light meal-timing hint from wall-clock arrival (local device timezone). */
function mealTimingHintForArrival(arrival) {
  if (!(arrival instanceof Date) || Number.isNaN(arrival.getTime())) return '';
  const mins = arrival.getHours() * 60 + arrival.getMinutes();
  if (mins >= 6 * 60 && mins < 10 * 60 + 45) {
    return ' You should arrive in the morning — great for breakfast or coffee.';
  }
  if (mins >= 10 * 60 + 45 && mins < 14 * 60 + 45) {
    return ' You should arrive around lunch — handy if you want a sit-down meal after the ride.';
  }
  if (mins >= 14 * 60 + 45 && mins < 17 * 60 + 30) {
    return ' Afternoon arrival — ideal for a late lunch or early dinner nearby.';
  }
  if (mins >= 17 * 60 + 30 && mins < 21 * 60 + 30) {
    return ' You should arrive around dinner time — these picks are close once you step out.';
  }
  if (mins >= 21 * 60 + 30 || mins < 1 * 60) {
    return ' Late-evening arrival — check opening hours before heading over.';
  }
  return '';
}

function formatEtaPreamble(durationMinutes, dropoffName) {
  const name = dropoffName || 'your destination';
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return `Near **${name}**`;
  }
  const arrival = new Date(Date.now() + durationMinutes * 60_000);
  const timeStr = arrival.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const meal = mealTimingHintForArrival(arrival);
  return `In about **${Math.round(durationMinutes)}** minute${Math.round(durationMinutes) === 1 ? '' : 's'} you should reach **${name}** (around **${timeStr}**).${meal}`;
}

async function searchRestaurantsNearLatLng(lat, lng, country) {
  const maxM = DESTINATION_DINING_SEARCH_RADIUS_METERS;
  const relaxedM = DESTINATION_DINING_RELAXED_MAX_METERS;
  /** Wider API bias so sparse campuses still return candidates; we filter client-side. */
  const apiRadius = Math.min(
    GRAB_POI_SEARCH_RADIUS_MAX_METERS,
    Math.max(relaxedM, 3500)
  );

  const tryPoiKeywordSearch = async (opts, countryOverride) => {
    const c =
      countryOverride !== undefined
        ? countryOverride
        : country != null && String(country).trim() !== ''
          ? country
          : null;
    try {
      return await searchGrabPois({
        ...opts,
        lat,
        lng,
        country: c != null && String(c).trim() !== '' ? c : null,
        limit: 50,
        radius: apiRadius,
        calculateDistance: () => null
      });
    } catch {
      return [];
    }
  };

  let raw = [];
  try {
    raw = await searchGrabNearbyPlaces({
      lat,
      lng,
      limit: 50,
      radius: apiRadius,
      rankBy: 'distance',
      calculateDistance: () => null
    });
  } catch {
    raw = [];
  }

  let foodRelated = dedupeRestaurantsById(raw.filter(poiLooksFoodRelated)).filter(
    (p) => p.name && p.location?.latitude != null && p.location?.longitude != null
  );

  if (foodRelated.length === 0) {
    const keywordAttempts = [
      { keyword: 'restaurant' },
      { keyword: 'restaurant', category: 'restaurant' },
      { keyword: 'restaurants' },
      { keyword: 'food' },
      { keyword: 'cafe' }
    ];
    const countryPasses = [
      country != null && String(country).trim() !== '' ? country : undefined,
      '__omit__'
    ];
    outer: for (const cPass of countryPasses) {
      const cOverride = cPass === '__omit__' ? null : cPass;
      for (const extra of keywordAttempts) {
        raw = await tryPoiKeywordSearch(extra, cOverride);
        if (raw.length) break outer;
      }
    }
    foodRelated = dedupeRestaurantsById(raw).filter(
      (p) => p.name && p.location?.latitude != null && p.location?.longitude != null
    );
  }

  const deduped = foodRelated;

  let nearby = filterPoisWithinRadiusMeters(deduped, lat, lng, maxM);
  if (nearby.length === 0 && deduped.length > 0) {
    nearby = filterPoisWithinRadiusMeters(deduped, lat, lng, relaxedM);
  }

  const ranked = nearby
    .sort((a, b) => grabRestaurantRank(b) - grabRestaurantRank(a))
    .slice(0, DESTINATION_DINING_TOP_N);

  return ranked.map((p, i) => ({
    ...p,
    diningRank: i + 1,
    distanceFromDestinationMeters: Math.round(distanceFromDropoffMeters(p, lat, lng))
  }));
}

/**
 * Top Grab-ranked restaurants within {@link DESTINATION_DINING_SEARCH_RADIUS_METERS} of drop-off (for map markers + copy).
 * @param {string|null|undefined} country - App country key (e.g. `singapore`); omit or pass null to let the API infer from location only.
 * @returns {Promise<Array<object>>} POIs with `diningRank` 1..3
 */
export async function fetchTopRestaurantsNearDropoff(dropoff, country) {
  const pair = locationToLngLatArray(dropoff);
  if (!pair) return [];
  const [lng, lat] = pair;
  return searchRestaurantsNearLatLng(lat, lng, country);
}

/**
 * Markdown-friendly dining tip when ranked results exist.
 * @param {number} [durationMinutes] - Route ETA; used for arrival-time and meal-timing copy.
 */
export function formatDestinationDiningTravelTip(ranked, dropoff, durationMinutes) {
  const lines = ranked.map(
    (p, i) => `${i + 1}. **${p.name}** — ${formatLocationLine(p)}`
  );
  const preamble = formatEtaPreamble(durationMinutes, dropoff?.name);
  const ring =
    DESTINATION_DINING_SEARCH_RADIUS_METERS === DESTINATION_DINING_DISPLAY_MAX_METERS
      ? `**${DESTINATION_DINING_SEARCH_RADIUS_METERS} m**`
      : `**${DESTINATION_DINING_SEARCH_RADIUS_METERS} m** (may extend to **${DESTINATION_DINING_DISPLAY_MAX_METERS} m** if the nearest POIs sit just outside)`;
  return `${preamble} Grab-ranked dining within ${ring} of your destination pin: ${lines.join(' ')}`;
}

/**
 * One line for journey narrative (Markdown-friendly).
 * @param {string|null|undefined} country - Selected region key for Grab `country` query param (not a hardcoded territory).
 * @param {{ durationMinutes?: number, rankedRestaurants?: Array<object>|null }} [options]
 * @returns {Promise<string>}
 */
export async function getLocalTravelTip(pickup, dropoff, country, options = {}) {
  const { durationMinutes, rankedRestaurants } = options;
  const ranked =
    rankedRestaurants != null
      ? rankedRestaurants
      : await fetchTopRestaurantsNearDropoff(dropoff, country);
  if (!ranked.length) {
    return pickLocalTip(pickup, dropoff);
  }
  return formatDestinationDiningTravelTip(ranked, dropoff, durationMinutes);
}

export function pickLocalTip(pickup, dropoff) {
  const locationSpecific = [];
  const pName = (pickup?.name || '').toLowerCase();
  const dName = (dropoff?.name || '').toLowerCase();

  if (pName.includes('airport') || dName.includes('airport')) {
    locationSpecific.push('Airport express trains are usually faster than taxis during peak hours');
  }
  if (pName.includes('mall') || dName.includes('mall')) {
    locationSpecific.push('Shopping malls often have the cleanest restrooms and free wifi');
  }
  if (pName.includes('hotel') || dName.includes('hotel')) {
    locationSpecific.push('Hotel concierges are goldmines of local knowledge - ask for hidden gems!');
  }

  const allTips = [...BASE_LOCAL_TIPS, ...locationSpecific];
  return allTips[Math.floor(Math.random() * allTips.length)];
}
