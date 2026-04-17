# JourneyGenie API proxy (edge)

Static sites (including GitHub Pages) **cannot** keep third-party API keys private: anything the browser uses ends up in DevTools, the bundle, or replayed requests.

This Worker holds **Grab** and **OpenWeather** credentials and forwards only allow-listed upstreams.

## Deploy (Cloudflare)

1. Install Wrangler and log in: [Wrangler install](https://developers.cloudflare.com/workers/wrangler/install-and-update/).
2. From this directory:

```bash
cd workers/journeygenie-api-proxy
npx wrangler deploy
```

3. Set secrets (values are not stored in git):

```bash
npx wrangler secret put GRAB_MAPS_API_KEY
npx wrangler secret put OPENWEATHER_API_KEY
```

4. Copy the worker **origin** (for example `https://journeygenie-api-proxy.grabmaps-demo.workers.dev`). Visiting `/` in the browser shows a short JSON index; real traffic uses `/grab-maps/…`, `/grab-api/…`, `/openweather/…`.

## Wire the React app

In the GitHub Actions workflow or `.env` for local builds, set **only** the public origin (no keys in the repo):

```bash
REACT_APP_API_PROXY_URL=https://journeygenie-api-proxy.your-subdomain.workers.dev
```

Do **not** set `REACT_APP_GRAB_MAPS_API_KEY` or `REACT_APP_OPENWEATHER_API_KEY` in that build.

## Security notes

- Anyone can call your worker from any site unless you add extra checks (signed tokens, Cloudflare rate limiting, authenticated users, IP rules).
- Keys are hidden from casual inspection of your GitHub Pages app, but **abuse of the worker** is still possible; monitor usage and quotas in Cloudflare and Grab/OpenWeather dashboards.
