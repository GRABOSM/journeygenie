# JourneyGenie

JourneyGenie is a **showcase application** for [**Grab Maps for developers**](https://maps.grab.com/developer): a portal where builders can use **data-enriched GrabMaps** to create mapping, mobility, and location experiences across **Southeast Asia**. This repo demonstrates how those capabilities fit together in a modern React app.

**Learn the APIs and concepts here:** [Grab Maps developer documentation](https://maps.grab.com/developer/documentation)

---

## Grab Maps platform — API and product highlights (short)

| Area | What developers get |
|------|------------------------|
| **Maps & basemap** | Vector map styles, **MapLibre**-compatible `style.json`, rich tiles (roads, labels, terrain context), and **3D / building** friendly camera workflows for immersive UIs. |
| **Routing & ETA** | **Directions** between places (e.g. driving profiles), route geometry for polylines, distance/duration — suitable for trip planning and turn-by-turn style experiences. |
| **Traffic** | **Real-time traffic** for a bounding box and **traffic incidents** (accidents, closures, roadwork, etc.) aligned to Grab’s network — ideal for live maps and rerouting context. |
| **Places & POI** | **POI search** to discover places by text and geography (names, categories, photos where available) for discovery, pickup/dropoff, and itinerary helpers. |
| **Single integration surface** | One **API base** (`REACT_APP_GRAB_MAPS_API_URL`) and **Bearer** key pattern for many map, routing, traffic, and search calls — see [documentation](https://maps.grab.com/developer/documentation) for full reference, quotas, and terms. |

*This app wires the rows above into a travel-style UI (map, search, route, traffic overlays, and optional route preview). Exact endpoint paths and fields evolve with Grab’s API versions — always follow the official docs.*

---

## Local development

### 1. Environment variables

```bash
cp .env.example .env
```

Edit `.env` — at minimum:

- **`REACT_APP_GRAB_MAPS_API_URL`** — Grab Maps API host (default in example: `https://maps.grab.com`).
- **`REACT_APP_GRAB_MAPS_API_KEY`** — Your Grab Maps **Bearer** API key from the developer portal.
- **`REACT_APP_OPENWEATHER_API_KEY`** — Optional weather UI ([OpenWeather](https://openweathermap.org/api)).

Never commit `.env`; it is gitignored.

### Public sites and API keys

Anything you put in `REACT_APP_*` is compiled into the JavaScript bundle and appears in the browser (for example the Network tab). **You cannot hide Grab or OpenWeather keys in a pure static GitHub Pages app.**

For a public demo, use **Option B** in `.env.example`: deploy the small Cloudflare Worker in `workers/journeygenie-api-proxy/`, store keys as Worker secrets, and set `REACT_APP_API_PROXY_URL` to that worker’s URL in CI. The UI then talks to your worker; the worker adds `Authorization` / `appid` upstream.

### 2. Install and run

```bash
npm install
npm start
```

Production build: `npm run build`.

For GitHub Pages project URLs, build with `PUBLIC_URL=/<repo-name>` (the included Actions workflow sets this automatically).

---

## Deploy on GitHub Pages

Workflow: [`.github/workflows/github-pages.yml`](.github/workflows/github-pages.yml).

1. **Settings → Pages → Build and deployment:** set **Source** to **GitHub Actions**.
2. **Settings → Secrets and variables → Actions:** add **`REACT_APP_API_PROXY_URL`** exactly (no trailing slash), e.g. `https://journeygenie-api-proxy.grabmaps-demo.workers.dev`.  
   Without this secret, the static build does **not** enable the proxy, so you will see OpenWeather “not configured” and Grab **401** in the browser.
3. Push to `main` (or run **Actions → Deploy GitHub Pages → Run workflow**). The site will be at `https://grabosm.github.io/journeygenie/` (org + repo name).

The Worker root URL (`/`) only returns a small JSON description; API traffic uses `/grab-maps/…`, `/grab-api/…`, and `/openweather/…`. Smoke test: open `/grab-maps/api/style.json` on your worker host.

---

## Optional: map tile cache (browser)

The app can register a small **service worker** (`public/grab-map-tiles-sw.js`) that caches Grab **vector map tile** requests for a short window to reduce repeat downloads. Confirm retention and use with **Grab’s terms** for your product. See `src/registerGrabMapTileCacheSw.js`.

---

## Security notes

- Keep keys in environment variables or your CI/CD secret store, not in source.
- Rotate keys if they are exposed.
