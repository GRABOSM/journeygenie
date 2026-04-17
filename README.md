# JourneyGenie

JourneyGenie is a **showcase application** for [**Grab Maps for developers**](https://maps.grab.com/developer): a portal where builders can use **data-enriched GrabMaps** to create mapping, mobility, and location experiences across **Southeast Asia**. This repo demonstrates how those capabilities fit together in a modern React app.

**Learn the APIs and concepts here:** [Grab Maps developer documentation](https://maps.grab.com/developer/documentation)

### Keeping this folder in sync with `../journeygenie`

If you develop in the main app repo and deploy from here, run from this directory:

```bash
./sync-from-journeygenie.sh
```

Then commit and push. The script copies `src/`, `public/`, `workers/`, `.github/`, and root manifests from the sibling `journeygenie` folder.

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

`REACT_APP_*` keys in the browser are always visible (Network tab / bundle). For a **public** Pages site, deploy `workers/journeygenie-api-proxy/` and use **`REACT_APP_API_PROXY_URL`** instead of embedding keys (see main repo README and `workers/journeygenie-api-proxy/README.md`).

### 2. Install and run

```bash
npm install
npm start
```

Production build: `npm run build`.

For a **GitHub Pages** project URL (`https://<user>.github.io/<repo>/`), build with the same base path CRA will use in CI:

```bash
PUBLIC_URL=/<your-repo-name> npm run build
```

---

## Deploy on GitHub Pages

This repository is set up for **GitHub Actions** static hosting (no `gh-pages` npm package required).

1. Create a new empty GitHub repository and push this tree as the default branch (`main` or `master`).
2. In the GitHub repo: **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**.
3. Add **Settings → Secrets and variables → Actions** repository secrets.

   **Recommended (keys not in the static bundle):** deploy the Worker in `workers/journeygenie-api-proxy/`, then add:
   - `REACT_APP_API_PROXY_URL` — your Worker origin, e.g. `https://journeygenie-api-proxy.your-subdomain.workers.dev`  
   The workflow clears Grab/OpenWeather key env vars when this is set so they are not compiled into JS.

   **Alternative (keys visible to visitors):** omit `REACT_APP_API_PROXY_URL` and set:
   - `REACT_APP_GRAB_MAPS_API_KEY` (required for maps)
   - `REACT_APP_OPENWEATHER_API_KEY` (optional)
   - `REACT_APP_GRAB_MAPS_API_URL` (optional; defaults to `https://maps.grab.com`)

4. Push to `main` or `master`; the workflow **Deploy GitHub Pages** builds with `PUBLIC_URL` set to `/<repository-name>` and publishes the `build` folder. A duplicate `404.html` is included so direct loads of client routes work on Pages.

---

## Security notes

- Static hosting cannot hide API keys. Use the edge proxy + `REACT_APP_API_PROXY_URL` for public demos.
- Anyone may still abuse your Worker URL unless you add rate limits or extra auth; monitor quotas.
- Rotate keys if they are exposed.
