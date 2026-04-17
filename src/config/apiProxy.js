/**
 * Optional backend proxy so Grab / OpenWeather secrets are not embedded in the static bundle.
 * GitHub Pages (and any static host) cannot hide API keys: anything the browser sends is visible.
 *
 * Deploy the worker in `workers/journeygenie-api-proxy/`, set secrets there, then point this app at
 * the worker origin via REACT_APP_API_PROXY_URL (no trailing slash).
 */

function trimSlash(s) {
  return String(s || '')
    .trim()
    .replace(/\/+$/, '');
}

/** e.g. https://your-worker.workers.dev */
export const API_PROXY_ORIGIN = trimSlash(process.env.REACT_APP_API_PROXY_URL || '');

/** When true, the app calls the worker for Grab + weather; omit REACT_APP_GRAB_MAPS_API_KEY and REACT_APP_OPENWEATHER_API_KEY from the build. */
export const USE_API_PROXY = Boolean(API_PROXY_ORIGIN);

/** Path prefix the worker maps to https://maps.grab.com */
export const GRAB_MAPS_PROXY_PREFIX = `${API_PROXY_ORIGIN}/grab-maps`;

/** Path prefix the worker maps to https://api.grab.com */
export const GRAB_API_COM_PROXY_PREFIX = `${API_PROXY_ORIGIN}/grab-api`;

/**
 * @param {string} url
 * @returns {string}
 */
export function rewriteGrabUrlForProxy(url) {
  if (!USE_API_PROXY || typeof url !== 'string' || !url.startsWith('http')) return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'maps.grab.com') {
      return `${API_PROXY_ORIGIN}/grab-maps${u.pathname}${u.search}`;
    }
    if (u.hostname === 'api.grab.com') {
      return `${API_PROXY_ORIGIN}/grab-api${u.pathname}${u.search}`;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * @param {number} lat
 * @param {number} lon
 * @returns {string}
 */
export function buildOpenWeatherClientUrl(lat, lon) {
  const q = new URLSearchParams({
    lat: String(lat),
    lon: String(lon)
  });
  return `${API_PROXY_ORIGIN}/openweather/weather?${q}`;
}

export function isWeatherFetchConfigured() {
  return USE_API_PROXY || Boolean(String(process.env.REACT_APP_OPENWEATHER_API_KEY || '').trim());
}
