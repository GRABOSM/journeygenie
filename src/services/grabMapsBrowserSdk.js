/**
 * Grab basemap initialization (per Grab developer docs).
 *
 * **Default (full vector basemap):** Per Grab docs, {@link fetchGrabOfficialMapStyle} loads
 * `…/api/style.json` with `Authorization: Bearer`, then MapLibre is created with `style` as that JSON
 * object. URLs are normalized like Grab’s basic-initialization demo: legacy site-root `/v1/…` is
 * rewritten to `/api/v1/…` on the maps origin; root-relative resources are resolved to the API base;
 * {@link grabMapTransformRequest} applies the same rewrite and adds `Bearer` on Grab hosts.
 *
 * **Optional Grab JS library:** Set `REACT_APP_GRAB_MAPS_LIBRARY_FIRST=true` *and*
 * `REACT_APP_GRAB_MAPS_LIBRARY_URL`. When the bundle exposes `GrabMapsLib` (UI Library / config-driven init;
 * @see https://maps.grab.com/developer/documentation/ui-library-config), that path is used first (`apiKey` + `baseUrl`,
 * style comes from Grab `style.json` inside the library). Otherwise
 * `GrabMapsBuilder` + `MapBuilder` (async `build()`). If the library path fails, MapLibre + `style.json` is used.
 *
 * **No API key:** MapTiles `basic.json` (or `REACT_APP_GRAB_MAP_STYLE_URL`) only.
 *
 * @see https://maps.grab.com/developer/documentation/initializing-map
 */
import maplibregl from 'maplibre-gl';
import { USE_API_PROXY, rewriteGrabUrlForProxy } from '../config/apiProxy';
import { GRAB_MAPS_API_BASE, GRAB_MAPS_API_KEY } from './grabMapsConfig';

function trimSlash(s) {
  return String(s || '')
    .trim()
    .replace(/\/+$/, '');
}

const DEFAULT_GRAB_HOST = 'https://maps.grab.com';

/** Cloudflare proxy uses `/grab-maps` prefix; Grab expects `/api/v1` not site-root `/v1` for vector tiles. */
function rewriteGrabProxyPathV1toApiV1(url) {
  if (!USE_API_PROXY || typeof url !== 'string') return url;
  return url.replace(/\/grab-maps\/v1(\/|$)/, '/grab-maps/api/v1$1');
}

/**
 * Origin of the Grab Maps site used for style/tiles (same idea as Grab basic-initialization demo).
 * @param {string} apiBase
 * @returns {string}
 */
function grabMapsPublicOriginFromApiBase(apiBase) {
  const raw = trimSlash(apiBase || DEFAULT_GRAB_HOST);
  try {
    if (raw.includes('://')) return new URL(raw).origin;
    return new URL(`https://${raw}`).origin;
  } catch {
    try {
      return new URL(DEFAULT_GRAB_HOST).origin;
    } catch {
      return DEFAULT_GRAB_HOST;
    }
  }
}

/**
 * Legacy style URLs used `/v1/...` at site root; tiles are served under `/api/v1/...`
 * (Grab basic-initialization.html + MapBuilder styleUrlRewriter).
 * @param {string} url
 * @param {string} publicMapsOrigin e.g. `https://maps.grab.com`
 * @returns {string}
 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteLegacyV1ApiPath(url, publicMapsOrigin) {
  if (!publicMapsOrigin || typeof url !== 'string' || !url.startsWith('http')) return url;
  const pathBeforeQuery = url.split('?')[0];
  // `new URL()` encodes `{z}`, `{fontstack}`, `{range}` in paths and breaks MapLibre style templates.
  if (pathBeforeQuery.includes('{')) {
    if (!url.startsWith(publicMapsOrigin)) return url;
    return url.replace(
      new RegExp(`^${escapeRegExp(publicMapsOrigin)}/v1(/|$)`),
      `${publicMapsOrigin}/api/v1$1`
    );
  }
  try {
    const u = new URL(url);
    if (u.origin !== publicMapsOrigin) return url;
    if (!/^\/v1(\/|$)/.test(u.pathname)) return url;
    u.pathname = u.pathname.replace(/^\/v1(\/|$)/, '/api/v1$1');
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * @param {unknown} style
 * @param {string} publicMapsOrigin
 * @returns {unknown}
 */
function rewriteLegacyV1UrlsInStyle(style, publicMapsOrigin) {
  if (style == null || !publicMapsOrigin) return style;
  function walk(obj) {
    if (obj == null) return obj;
    if (typeof obj === 'string') {
      let s = rewriteLegacyV1ApiPath(obj, publicMapsOrigin);
      if (USE_API_PROXY) {
        s = rewriteGrabUrlForProxy(s);
        s = rewriteGrabProxyPathV1toApiV1(s);
      }
      return s;
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i += 1) {
        obj[i] = walk(obj[i]);
      }
      return obj;
    }
    if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        obj[key] = walk(obj[key]);
      }
      return obj;
    }
    return obj;
  }
  walk(style);
  return style;
}

/**
 * When `style.json` is loaded as a JSON object, root-relative `tiles` / `glyphs` / `sprite` URLs
 * would otherwise resolve against the app origin (e.g. localhost) and never receive Grab auth.
 * Rewrite them to `apiBase` so tile/font requests hit Grab with {@link grabMapTransformRequest}.
 * Also rewrites legacy `…/v1/…` → `…/api/v1/…` on the Grab maps origin (Grab official examples).
 * @param {object} styleJson
 * @param {string} apiBase
 */
/**
 * Removes vector sources whose tile URLs target Grab traffic PBF endpoints (e.g. `…/traffic-v1/…`)
 * and drops layers that use those sources. Avoids MapLibre spamming requests when that tier returns 502.
 * Set `REACT_APP_GRAB_MAP_KEEP_TRAFFIC_TILES=true` to keep the default style traffic overlay.
 * @param {object} styleJson
 * @returns {object}
 */
export function stripTrafficVectorTileSourcesFromStyle(styleJson) {
  if (!styleJson || typeof styleJson !== 'object' || Array.isArray(styleJson)) return styleJson;
  const sources = styleJson.sources;
  if (!sources || typeof sources !== 'object') return styleJson;

  const trafficSourceIds = new Set();
  for (const [id, def] of Object.entries(sources)) {
    if (!def || typeof def !== 'object') continue;
    const urls = [];
    if (Array.isArray(def.tiles)) {
      for (const t of def.tiles) {
        if (typeof t === 'string') urls.push(t);
      }
    }
    if (typeof def.url === 'string') urls.push(def.url);
    const joined = urls.join(' ');
    if (/traffic-v\d|\/traffic[-_]v\d|map-tiles\/[^?]*traffic/i.test(joined)) {
      trafficSourceIds.add(id);
    }
  }

  if (trafficSourceIds.size === 0) return styleJson;

  const newSources = { ...sources };
  trafficSourceIds.forEach((sid) => {
    delete newSources[sid];
  });

  const layers = Array.isArray(styleJson.layers)
    ? styleJson.layers.filter((layer) => {
        if (!layer || typeof layer !== 'object') return true;
        const sid = layer.source;
        return !sid || !trafficSourceIds.has(sid);
      })
    : styleJson.layers;

  return { ...styleJson, sources: newSources, layers };
}

function normalizeGrabStyleResourceUrls(styleJson, apiBase) {
  if (!styleJson || typeof styleJson !== 'object') return styleJson;
  const root = `${trimSlash(apiBase || DEFAULT_GRAB_HOST)}/`;
  const publicOrigin = grabMapsPublicOriginFromApiBase(apiBase);
    const baseTrim = trimSlash(apiBase || DEFAULT_GRAB_HOST);
    const abs = (u) => {
    if (typeof u !== 'string' || !u) return u;
    let out;
    if (/^https?:\/\//i.test(u) || u.startsWith('//')) {
      out = u;
    } else if (u.startsWith('/')) {
      // Leading "/" is origin-root in the URL API and would drop a path-mounted base (e.g. …/grab-maps).
      out = `${baseTrim}${u}`;
    } else if (u.includes('{')) {
      // Same as above: avoid new URL() so `{z}` / `{x}` / `{y}` / `{fontstack}` stay literal for MapLibre.
      const sep = u.startsWith('/') ? '' : '/';
      out = `${baseTrim}${sep}${u}`;
    } else {
      try {
        out = new URL(u, root).href;
      } catch {
        return u;
      }
    }
    out = rewriteLegacyV1ApiPath(out, publicOrigin);
    if (USE_API_PROXY) {
      out = rewriteGrabUrlForProxy(out);
      out = rewriteGrabProxyPathV1toApiV1(out);
    }
    return out;
  };
  const out = { ...styleJson };
  if (typeof out.glyphs === 'string') out.glyphs = abs(out.glyphs);
  if (typeof out.sprite === 'string') out.sprite = abs(out.sprite);
  else if (Array.isArray(out.sprite)) {
    out.sprite = out.sprite.map((s) => (typeof s === 'string' ? abs(s) : s));
  }
  if (out.sources && typeof out.sources === 'object') {
    const sources = { ...out.sources };
    for (const id of Object.keys(sources)) {
      const s = sources[id];
      if (!s || typeof s !== 'object') continue;
      const copy = { ...s };
      if (Array.isArray(copy.tiles)) copy.tiles = copy.tiles.map(abs);
      if (typeof copy.url === 'string') copy.url = abs(copy.url);
      sources[id] = copy;
    }
    out.sources = sources;
  }
  return out;
}

/**
 * Merge Grab `Authorization` (and root-relative URL fixes) with any existing MapLibre transform
 * (e.g. Grab MapBuilder). Uses a private field on RequestManager; safe no-op if the shape changes.
 * @param {import('maplibre-gl').Map} map
 */
export function applyGrabBasemapAuthTransform(map) {
  if (!map || typeof map.setTransformRequest !== 'function') return;
  const rm = map._requestManager;
  const prevFn = rm && typeof rm._transformRequestFn === 'function' ? rm._transformRequestFn : null;
  map.setTransformRequest((url, resourceType) => {
    let base = { url };
    if (prevFn) {
      try {
        const p = prevFn(url, resourceType);
        if (p && typeof p === 'object') base = { ...p, url: p.url ?? url };
      } catch {
        /* ignore */
      }
    }
    const auth = grabMapTransformRequest(base.url, resourceType);
    const out = {
      url: auth.url,
      headers: { ...(base.headers || {}), ...(auth.headers || {}) }
    };
    if (base.credentials) out.credentials = base.credentials;
    if (base.method) out.method = base.method;
    if (base.body) out.body = base.body;
    if (base.collectResourceTiming) out.collectResourceTiming = base.collectResourceTiming;
    return out;
  });
}

/**
 * Official Grab Maps style endpoint (MapLibre-compatible spec).
 * Uses the same base as navigation/POI (`REACT_APP_GRAB_MAPS_API_URL`) when set.
 */
export function getGrabOfficialStyleJsonUrl() {
  const base = trimSlash(GRAB_MAPS_API_BASE || DEFAULT_GRAB_HOST);
  return `${base}/api/style.json`;
}

/**
 * Full style URL, or `${REACT_APP_GRAB_MAP_TILES_BASE_URL}/v1/styles/basic.json`.
 * Used when `style.json` is unavailable (no key, HTTP error, or network failure).
 */
export function getGrabMapStyleUrl() {
  const full = (process.env.REACT_APP_GRAB_MAP_STYLE_URL || '').trim();
  if (full) return full;
  const base = trimSlash(process.env.REACT_APP_GRAB_MAP_TILES_BASE_URL || 'https://maptiles.stg-myteksi.com');
  return `${base}/v1/styles/basic.json`;
}

/**
 * Fetches Grab `style.json` with Bearer auth for use as MapLibre `style` (inline object).
 * @returns {Promise<object|null>} Normalized style JSON, or `null` on missing key / HTTP error.
 */
export async function fetchGrabOfficialMapStyle() {
  const key = String(GRAB_MAPS_API_KEY || '').trim();
  if (!key && !USE_API_PROXY) {
    return null;
  }
  const url = getGrabOfficialStyleJsonUrl();
  try {
    const headers = { Accept: 'application/json' };
    if (key) {
      headers.Authorization = `Bearer ${key}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn('Grab style.json:', res.status, res.statusText, url);
      return null;
    }
    const json = await res.json();
    const apiBase = GRAB_MAPS_API_BASE || DEFAULT_GRAB_HOST;
    const publicOrigin = grabMapsPublicOriginFromApiBase(apiBase);
    rewriteLegacyV1UrlsInStyle(json, publicOrigin);
    let out = normalizeGrabStyleResourceUrls(json, apiBase);
    if (String(process.env.REACT_APP_GRAB_MAP_KEEP_TRAFFIC_TILES || '').trim() !== 'true') {
      out = stripTrafficVectorTileSourcesFromStyle(out);
    }
    return out;
  } catch (e) {
    console.warn('Grab style.json fetch failed:', e?.message || e);
    return null;
  }
}

/**
 * @param {string} url
 * @param {import('maplibre-gl').ResourceType | string} [resourceType]
 * @returns {{ url: string, headers?: Record<string, string> }}
 */
export function grabMapTransformRequest(url, resourceType) {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('grabmap_token') : null;
  if (token && (url.includes('myteksi.com') || url.includes('grabtaxi.com'))) {
    return { url, headers: { 'X-MTS-SSID': token } };
  }
  const key = String(GRAB_MAPS_API_KEY || '').trim();
  const apiBase = trimSlash(GRAB_MAPS_API_BASE || DEFAULT_GRAB_HOST);
  const publicOrigin = grabMapsPublicOriginFromApiBase(apiBase);
  const apiBaseHost = (() => {
    try {
      return new URL(apiBase).hostname;
    } catch {
      return '';
    }
  })();

  let reqUrl = typeof url === 'string' ? rewriteLegacyV1ApiPath(url, publicOrigin) : url;
  if (
    (key || USE_API_PROXY) &&
    typeof reqUrl === 'string' &&
    reqUrl.startsWith('/') &&
    !reqUrl.startsWith('//') &&
    (reqUrl.includes('/api/') || reqUrl.includes('/v1/') || reqUrl.includes('map-tiles'))
  ) {
    // Do not use new URL('/path', base) here: a leading "/" replaces the whole path and breaks …/grab-maps proxies.
    reqUrl = `${apiBase}${reqUrl}`;
    reqUrl = rewriteLegacyV1ApiPath(reqUrl, publicOrigin);
  }

  const onGrabHost =
    reqUrl.includes('maps.grab.com') ||
    reqUrl.includes('api.grab.com') ||
    (Boolean(apiBaseHost) && reqUrl.includes(apiBaseHost));
  const needsBearer = Boolean(key && onGrabHost);

  if (USE_API_PROXY && typeof reqUrl === 'string') {
    reqUrl = rewriteGrabUrlForProxy(reqUrl);
    reqUrl = rewriteGrabProxyPathV1toApiV1(reqUrl);
  }

  if (needsBearer) {
    return { url: reqUrl, headers: { Authorization: `Bearer ${key}` } };
  }
  return { url: reqUrl };
}

/**
 * Creates a MapLibre map: with API key, fetches Grab `…/api/style.json` with Bearer and passes the
 * JSON as `style` (per Grab initializing-map docs); if fetch fails, falls back to the same URL as
 * `style` string + {@link grabMapTransformRequest}. Without key, uses `opts.styleUrl` or MapTiles
 * `basic.json`.
 * @param {{
 *   container: string | HTMLElement,
 *   center: [number, number],
 *   zoom?: number,
 *   minZoom?: number,
 *   styleUrl?: string,
 * }} opts
 * @returns {Promise<import('maplibre-gl').Map>}
 */
export async function createGrabBasemapMapWithStyleFallback(opts) {
  const el =
    typeof opts.container === 'string' ? document.getElementById(opts.container) : opts.container;
  if (!el) {
    throw new Error('Grab map: container element not found');
  }

  const key = String(GRAB_MAPS_API_KEY || '').trim();
  let style;
  if (key || USE_API_PROXY) {
    const inline = await fetchGrabOfficialMapStyle();
    if (inline && typeof inline === 'object' && !Array.isArray(inline)) {
      style = inline;
    } else {
      style = getGrabOfficialStyleJsonUrl();
    }
  } else {
    style = opts.styleUrl || getGrabMapStyleUrl();
  }

  const map = new maplibregl.Map({
    container: el,
    style,
    center: opts.center,
    zoom: opts.zoom ?? 12,
    minZoom: opts.minZoom ?? 2,
    transformRequest: grabMapTransformRequest
  });
  applyGrabBasemapAuthTransform(map);
  return map;
}

/**
 * Synchronous map creation (fixed style URL). Prefer {@link createGrabBasemapMapWithStyleFallback} for production.
 * @param {{
 *   container: string | HTMLElement,
 *   center: [number, number],
 *   zoom?: number,
 *   minZoom?: number,
 *   styleUrl?: string,
 * }} opts
 * @returns {import('maplibre-gl').Map}
 */
export function createGrabVectorBasemapMap(opts) {
  const el =
    typeof opts.container === 'string' ? document.getElementById(opts.container) : opts.container;
  if (!el) {
    throw new Error('Grab map: container element not found');
  }
  const key = String(GRAB_MAPS_API_KEY || '').trim();
  const style =
    opts.styleUrl || (key || USE_API_PROXY ? getGrabOfficialStyleJsonUrl() : getGrabMapStyleUrl());
  const map = new maplibregl.Map({
    container: el,
    style,
    center: opts.center,
    zoom: opts.zoom ?? 12,
    minZoom: opts.minZoom ?? 2,
    transformRequest: grabMapTransformRequest
  });
  applyGrabBasemapAuthTransform(map);
  return map;
}

let grabMapsLibraryLoadPromise = null;
/** @type {string} */
let grabMapsLibraryLoadUrl = '';

function isGrabMapsBrowserBundleReady() {
  const G = typeof window !== 'undefined' ? window.GrabMaps : null;
  if (!G) return false;
  if (typeof G.GrabMapsLib === 'function') return true;
  if (G.GrabMapsBuilder && G.MapBuilder) return true;
  return false;
}

/**
 * Injects the Grab Maps browser bundle once. URL must be provided by Grab (partner / docs); there is no stable public default.
 * @param {string} scriptUrl
 * @returns {Promise<typeof window.GrabMaps>}
 */
export function loadGrabMapsLibrary(scriptUrl) {
  const url = String(scriptUrl || '').trim();
  if (!url) {
    return Promise.reject(new Error('GrabMaps library URL is empty'));
  }
  if (typeof window !== 'undefined' && isGrabMapsBrowserBundleReady()) {
    return Promise.resolve(window.GrabMaps);
  }
  if (grabMapsLibraryLoadPromise && grabMapsLibraryLoadUrl === url) {
    return grabMapsLibraryLoadPromise;
  }
  if (grabMapsLibraryLoadPromise && grabMapsLibraryLoadUrl !== url) {
    grabMapsLibraryLoadPromise = null;
    grabMapsLibraryLoadUrl = '';
  }
  grabMapsLibraryLoadUrl = url;
  grabMapsLibraryLoadPromise = new Promise((resolve, reject) => {
    const fail = (err) => {
      grabMapsLibraryLoadPromise = null;
      grabMapsLibraryLoadUrl = '';
      reject(err);
    };
    const ok = () => {
      if (isGrabMapsBrowserBundleReady()) {
        resolve(window.GrabMaps);
      } else {
        fail(
          new Error(
            'GrabMaps script loaded but window.GrabMaps is missing GrabMapsLib and GrabMapsBuilder/MapBuilder'
          )
        );
      }
    };

    let existing = document.querySelector('script[data-journeygenie-grabmaps="1"]');
    if (existing && existing.src && url) {
      const want = new URL(url, window.location.href).href;
      if (existing.src !== want) {
        existing.remove();
        existing = null;
      }
    }
    if (existing) {
      if (isGrabMapsBrowserBundleReady()) {
        ok();
        return;
      }
      existing.addEventListener('load', ok);
      existing.addEventListener('error', () => fail(new Error('GrabMaps script load error')));
      return;
    }

    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.dataset.journeygenieGrabmaps = '1';
    s.onload = ok;
    s.onerror = () => fail(new Error(`Failed to load GrabMaps script: ${url}`));
    document.head.appendChild(s);
  });
  return grabMapsLibraryLoadPromise;
}

/**
 * MapBuilder / GrabMapsLib may resolve the inner MapLibre map asynchronously after `build()`.
 * @param {unknown} wrapper
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 * @returns {Promise<import('maplibre-gl').Map | null>}
 */
export async function waitForGrabWrapperMaplibre(wrapper, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 25000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const map = unwrapGrabMapToMaplibre(wrapper);
    if (map) return map;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return unwrapGrabMapToMaplibre(wrapper);
}

/**
 * Returns the MapLibre `Map` instance if `map` is a wrapper (Grab MapBuilder) or already MapLibre.
 * @param {unknown} map
 * @returns {import('maplibre-gl').Map | null}
 */
export function unwrapGrabMapToMaplibre(map) {
  if (!map) return null;
  if (typeof map.getBounds === 'function' && typeof map.getCenter === 'function' && typeof map.addLayer === 'function') {
    return /** @type {import('maplibre-gl').Map} */ (map);
  }
  const inner =
    map.getMap?.() ||
    map.getMaplibreMap?.() ||
    map.map ||
    map._map ||
    map.__map ||
    map.maplibreMap;
  if (inner && typeof inner.getBounds === 'function' && typeof inner.addLayer === 'function') {
    return /** @type {import('maplibre-gl').Map} */ (inner);
  }
  return null;
}

/**
 * Map init: **default** = MapLibre + Grab `style.json` fetched with Bearer, passed as style object.
 * Set `REACT_APP_GRAB_MAPS_LIBRARY_FIRST=true` to try the Grab JS bundle first when `REACT_APP_GRAB_MAPS_LIBRARY_URL` is set.
 * @param {{
 *   container: string | HTMLElement,
 *   center: [number, number],
 *   zoom?: number,
 *   minZoom?: number,
 *   styleUrl?: string,
 * }} opts
 * @returns {Promise<{ map: import('maplibre-gl').Map, wrapper: object | null, via: 'grab-maps-lib' | 'grab-library' | 'maplibre-style' }>}
 */
export async function createGrabMapWithPreferredInit(opts) {
  const libUrl = (process.env.REACT_APP_GRAB_MAPS_LIBRARY_URL || '').trim();
  const libraryFirst = String(process.env.REACT_APP_GRAB_MAPS_LIBRARY_FIRST || '').trim() === 'true';
  const container = typeof opts.container === 'string' ? opts.container : opts.container?.id;
  const key = String(GRAB_MAPS_API_KEY || '').trim();

  if (libraryFirst && libUrl && typeof window !== 'undefined' && key) {
    try {
      const Grab = await loadGrabMapsLibrary(libUrl);
      const base = trimSlash(GRAB_MAPS_API_BASE || DEFAULT_GRAB_HOST);
      if (!container || typeof container !== 'string') {
        throw new Error('Grab map library: container must be a string element id');
      }

      if (typeof Grab.GrabMapsLib === 'function') {
        const [lng, lat] = opts.center;
        /** @type {Record<string, unknown>} */
        const libOpts = {
          container,
          apiKey: key,
          baseUrl: base,
          lat,
          lng,
          zoom: opts.zoom ?? 12,
          interactive: true,
          navigation: true,
          attribution: true,
          buildings: true,
          labels: true,
          routing: null
        };
        const built = new Grab.GrabMapsLib(libOpts);
        const map = await waitForGrabWrapperMaplibre(built, { timeoutMs: 25000 });
        if (map) {
          if (opts.minZoom != null && typeof map.setMinZoom === 'function') {
            try {
              map.setMinZoom(opts.minZoom);
            } catch {
              /* ignore */
            }
          }
          applyGrabBasemapAuthTransform(map);
          return { map, wrapper: built, via: 'grab-maps-lib' };
        }
        console.warn('GrabMapsLib: could not resolve MapLibre map after init; trying MapBuilder or fallback.');
      }

      if (Grab.GrabMapsBuilder && Grab.MapBuilder) {
        const baseWithSlash = `${trimSlash(base)}/`;
        const client = new Grab.GrabMapsBuilder().setBaseUrl(baseWithSlash).setApiKey(key).build();
        let builder = new Grab.MapBuilder(client)
          .setContainer(container)
          .setCenter(opts.center)
          .setZoom(opts.zoom ?? 12)
          .enableNavigation()
          .enableLabels()
          .enableBuildings()
          .enableAttribution();
        if (opts.minZoom != null && typeof builder.setMinZoom === 'function') {
          builder = builder.setMinZoom(opts.minZoom);
        }
        const built = await builder.build();
        let map = unwrapGrabMapToMaplibre(built);
        if (!map) {
          map = await waitForGrabWrapperMaplibre(built, { timeoutMs: 25000 });
        }
        if (map) {
          if (opts.minZoom != null && typeof map.setMinZoom === 'function') {
            try {
              map.setMinZoom(opts.minZoom);
            } catch {
              /* ignore */
            }
          }
          applyGrabBasemapAuthTransform(map);
          return { map, wrapper: built, via: 'grab-library' };
        }
        console.warn('Grab MapBuilder: could not resolve MapLibre map from build() result; falling back.');
      }
    } catch (e) {
      console.warn('GrabMaps library path failed:', e?.message || e);
    }
  }

  const map = await createGrabBasemapMapWithStyleFallback(opts);
  return { map, wrapper: null, via: 'maplibre-style' };
}
