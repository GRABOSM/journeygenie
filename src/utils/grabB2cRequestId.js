/**
 * Internal / engtools gateways need requestID + tracing. Public https://maps.grab.com does not.
 */
export function urlNeedsGrabB2cTracing(baseUrl) {
  if (process.env.REACT_APP_GRAB_NAVIGATION_B2C_TRACING === 'true') return true;
  try {
    const h = new URL(baseUrl).hostname.toLowerCase();
    return (
      h.includes('b2c-map-service') ||
      h.includes('engtools') ||
      h.includes('geo-tools.grabtaxi.com')
    );
  } catch {
    return false;
  }
}

/**
 * b2c-map-service requires a unique requestID on navigation, direction, traffic, etc.
 * Error without it: "Missing value for requestID"
 */
export function newGrabRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `jg-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * b2c-map-service often expects requestID in query and tracing IDs in headers.
 */
export function applyB2cRequestTracing(params, headers) {
  const rid = newGrabRequestId();
  params.set('requestID', rid);
  params.set('requestId', rid);
  if (headers && typeof headers === 'object') {
    headers['X-Request-ID'] = rid;
    headers['X-Correlation-ID'] = rid;
    headers['Request-ID'] = rid;
  }
  return rid;
}
