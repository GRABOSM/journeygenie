/* eslint-disable no-restricted-globals */
/**
 * JourneyGenie — short-lived client cache for Grab map *vector tiles* only.
 * Buckets cache by wall-clock 15-minute windows so nothing is served older than ~15 minutes.
 * Confirm retention with Grab Maps terms for your product tier.
 */
const CACHE_PREFIX = 'jg-grab-maptiles-v1-';
const TTL_MS = 15 * 60 * 1000;

function tileBucket() {
  return Math.floor(Date.now() / TTL_MS);
}

function tileCacheName() {
  return CACHE_PREFIX + tileBucket();
}

function isGrabMapTileGet(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    const onGrabMapsHost =
      host === 'maps.grab.com' ||
      host.endsWith('.grab.com') ||
      host.includes('maptiles.') ||
      host.includes('myteksi.com') ||
      host.includes('grabtaxi.com');
    if (!onGrabMapsHost) return false;
    const p = u.pathname;
    if (!p.includes('map-tiles')) return false;
    return p.endsWith('.pbf') || p.includes('/map-tiles/');
  } catch {
    return false;
  }
}

let lastPruneMs = 0;
const PRUNE_INTERVAL_MS = 3000;

async function pruneStaleTileCaches() {
  const keep = tileCacheName();
  const keys = await caches.keys();
  await Promise.all(
    keys.map((k) => {
      if (k.startsWith(CACHE_PREFIX) && k !== keep) return caches.delete(k);
      return Promise.resolve();
    })
  );
}

async function pruneStaleTileCachesThrottled() {
  const now = Date.now();
  if (now - lastPruneMs < PRUNE_INTERVAL_MS) return;
  lastPruneMs = now;
  await pruneStaleTileCaches();
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await pruneStaleTileCaches();
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (!isGrabMapTileGet(req.url)) return;

  event.respondWith(
    (async () => {
      await pruneStaleTileCachesThrottled();
      const cache = await caches.open(tileCacheName());
      const hit = await cache.match(req, { ignoreVary: true });
      if (hit) return hit;

      const res = await fetch(req);
      if (res && res.ok && res.status === 200) {
        try {
          await cache.put(req, res.clone());
        } catch {
          /* quota, opaque, or Cache API restriction */
        }
      }
      return res;
    })()
  );
});
