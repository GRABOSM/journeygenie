/**
 * Registers a lightweight service worker that caches Grab map-tile GETs for 15 minutes.
 * @see public/grab-map-tiles-sw.js
 */
export function registerGrabMapTileCacheServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const swUrl = `${base}/grab-map-tiles-sw.js`;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register(swUrl).catch((err) => {
      console.warn('Grab map tile cache SW not registered:', err?.message || err);
    });
  });
}
