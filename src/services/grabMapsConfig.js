/**
 * Single Grab Maps base URL + API key for navigation, traffic, and POI search.
 *
 * Prefer: REACT_APP_GRAB_MAPS_API_URL + REACT_APP_GRAB_MAPS_API_KEY
 * Public static deploys: set REACT_APP_API_PROXY_URL to your serverless worker and omit the key from the build.
 * Legacy fallbacks keep older .env names working.
 */

import { GRAB_MAPS_PROXY_PREFIX, USE_API_PROXY } from '../config/apiProxy';

function trimSlash(s) {
  return String(s || '')
    .trim()
    .replace(/\/+$/, '');
}

const DIRECT_GRAB_BASE = trimSlash(
  process.env.REACT_APP_GRAB_MAPS_API_URL || 'https://maps.grab.com'
);

export const GRAB_MAPS_API_BASE = USE_API_PROXY ? trimSlash(GRAB_MAPS_PROXY_PREFIX) : DIRECT_GRAB_BASE;

export const GRAB_MAPS_API_KEY = USE_API_PROXY
  ? ''
  : String(
      process.env.REACT_APP_GRAB_MAPS_API_KEY ||
        process.env.REACT_APP_GRAB_MAPS_KEY ||
        process.env.REACT_APP_GRAB_MAP_KEY ||
        ''
    ).trim();

/** True when Grab REST/tiles can run (direct key or proxy worker). */
export function isGrabApiConfigured() {
  return USE_API_PROXY || Boolean(GRAB_MAPS_API_KEY);
}

/**
 * @param {{ omitJsonContentType?: boolean }} [opts] — omit `Content-Type` for GET requests (some gateways are strict).
 */
export function grabMapsJsonHeaders(opts = {}) {
  const headers = { Accept: 'application/json' };
  if (!opts.omitJsonContentType) {
    headers['Content-Type'] = 'application/json';
  }
  if (GRAB_MAPS_API_KEY) {
    headers.Authorization = `Bearer ${GRAB_MAPS_API_KEY}`;
  }
  return headers;
}
