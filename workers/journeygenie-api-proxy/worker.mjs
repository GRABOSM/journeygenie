/**
 * Thin edge proxy: adds Grab Bearer + OpenWeather appid server-side so static apps never embed keys.
 * Deploy with Cloudflare Workers (Wrangler). Keys live only as Worker secrets, not in GitHub.
 *
 * Routes:
 *   GET|POST …/grab-maps/*  → https://maps.grab.com/*
 *   GET|POST …/grab-api/*   → https://api.grab.com/*
 *   GET …/openweather/weather?lat=&lon= → OpenWeather current weather
 */

function corsHeaders(origin) {
  const allow = origin && origin !== 'null' ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allow,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Accept, Content-Type, Range, Accept-Language, If-None-Match, If-Modified-Since, Authorization, X-Request-ID, X-Correlation-ID, Request-ID',
    'Access-Control-Max-Age': '86400'
  };
}

function mergeCors(baseHeaders, cors) {
  const h = new Headers(baseHeaders);
  Object.entries(cors).forEach(([k, v]) => h.set(k, v));
  return h;
}

/**
 * Grab serves some vector tiles under site-root `/v1/…`; public API expects `/api/v1/…`.
 * The browser SDK rewrites this for maps.grab.com URLs, but proxied paths stay `/grab-maps/v1/…`
 * and would otherwise forward `/v1/…` upstream → 403. Align with Grab basic-init / MapBuilder behavior.
 * @param {string} pathWithQuery pathname + optional "?" search
 */
function rewriteGrabMapsUpstreamPath(pathWithQuery) {
  const s = pathWithQuery || '/';
  const q = s.indexOf('?');
  const path = q >= 0 ? s.slice(0, q) : s;
  const search = q >= 0 ? s.slice(q) : '';
  if (path === '/v1' || path.startsWith('/v1/')) {
    const rest = path.replace(/^\/v1(\/|$)/, '/api/v1$1');
    return `${rest}${search}`;
  }
  return s;
}

async function forwardGrab(request, upstreamBaseOrigin, pathnameAndSearch, bearer, cors, env) {
  let pathAndQuery = pathnameAndSearch || '/';
  if (upstreamBaseOrigin === 'https://maps.grab.com') {
    pathAndQuery = rewriteGrabMapsUpstreamPath(pathAndQuery);
  }
  const target = new URL(pathAndQuery, upstreamBaseOrigin);
  if (target.origin !== upstreamBaseOrigin) {
    return new Response('Invalid upstream', { status: 500, headers: cors });
  }

  const hop = new Headers();
  for (const name of [
    'accept',
    'content-type',
    'range',
    'accept-language',
    'if-none-match',
    'if-modified-since',
    // Grab keys restricted by HTTP referrer: Worker→Grab must carry the app origin the key was allowlisted for.
    'referer',
    'origin',
    'user-agent'
  ]) {
    const v = request.headers.get(name);
    if (v) hop.set(name, v);
  }

  const fallbackRef = String(env?.GRAB_UPSTREAM_REFERER || '').trim();
  if (fallbackRef && !hop.has('referer')) {
    hop.set('Referer', fallbackRef);
  }
  if (fallbackRef && !hop.has('origin')) {
    try {
      hop.set('Origin', new URL(fallbackRef).origin);
    } catch {
      /* ignore */
    }
  }

  hop.set('Authorization', `Bearer ${bearer}`);

  const body =
    request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined;

  const res = await fetch(target.toString(), {
    method: request.method,
    headers: hop,
    body,
    redirect: 'follow'
  });

  const out = mergeCors(res.headers, cors);
  out.delete('set-cookie');
  return new Response(res.body, { status: res.status, headers: out });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const grabKey = env.GRAB_MAPS_API_KEY;
    if (!grabKey) {
      return new Response('Worker misconfigured: set secret GRAB_MAPS_API_KEY', {
        status: 500,
        headers: cors
      });
    }

    if (url.pathname === '/' || url.pathname === '') {
      const body = JSON.stringify({
        service: 'journeygenie-api-proxy',
        note: 'Root has no API; use path prefixes below.',
        paths: {
          grabMaps: '/grab-maps/… → https://maps.grab.com/…',
          grabApi: '/grab-api/… → https://api.grab.com/…',
          openweather: '/openweather/weather?lat=&lon='
        },
        smokeTest: '/grab-maps/api/style.json'
      });
      return new Response(body, {
        status: 200,
        headers: mergeCors({ 'Content-Type': 'application/json; charset=utf-8' }, cors)
      });
    }

    if (url.pathname === '/grab-maps' || url.pathname.startsWith('/grab-maps/')) {
      const after = url.pathname.slice('/grab-maps'.length) || '/';
      const pathOnOrigin = after.startsWith('/') ? after : `/${after}`;
      return forwardGrab(request, 'https://maps.grab.com', pathOnOrigin + url.search, grabKey, cors, env);
    }

    if (url.pathname === '/grab-api' || url.pathname.startsWith('/grab-api/')) {
      const after = url.pathname.slice('/grab-api'.length) || '/';
      const pathOnOrigin = after.startsWith('/') ? after : `/${after}`;
      return forwardGrab(request, 'https://api.grab.com', pathOnOrigin + url.search, grabKey, cors, env);
    }

    if (url.pathname.startsWith('/openweather/')) {
      const owKey = env.OPENWEATHER_API_KEY;
      if (!owKey) {
        return new Response(JSON.stringify({ error: 'OPENWEATHER_API_KEY not set on worker' }), {
          status: 503,
          headers: mergeCors({ 'Content-Type': 'application/json' }, cors)
        });
      }
      const lat = url.searchParams.get('lat');
      const lon = url.searchParams.get('lon');
      if (lat == null || lon == null || lat === '' || lon === '') {
        return new Response(JSON.stringify({ error: 'lat and lon required' }), {
          status: 400,
          headers: mergeCors({ 'Content-Type': 'application/json' }, cors)
        });
      }
      const ow = new URL('https://api.openweathermap.org/data/2.5/weather');
      ow.searchParams.set('lat', lat);
      ow.searchParams.set('lon', lon);
      ow.searchParams.set('units', 'metric');
      ow.searchParams.set('appid', owKey);
      const res = await fetch(ow);
      const headers = mergeCors(res.headers, cors);
      return new Response(res.body, { status: res.status, headers });
    }

    return new Response('Not found', { status: 404, headers: cors });
  }
};
