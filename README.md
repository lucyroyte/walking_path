# Walking Path

NYC walking directions that **steer around live street flooding** and **toward tree shade when it's hot**.

For each trip the app:

1. Gets several candidate walking routes. It asks the routing provider for its alternatives, and also for routes forced through "via" points on either side of the straight line, so there's a real choice when the obvious streets are flooded.
2. Checks each route against **[FloodNet](https://www.floodnet.nyc)**, the network of about 400 real-time street-flood sensors. A route that passes within 50 m of a sensor reading at least 25 mm (about 1 inch) of water is marked *flooded*. A reading of 10 to 25 mm counts as *wet*. Only sensors FloodNet marks as healthy (`good`, `good - fs`, `non-ota`, `low_charge`) are trusted. Sensors marked `noisy`, `signal`, `needs_driverail` and the like can report deep water on a dry street, so the map shows them as *offline* and they never count as flooding.
3. Measures how much of each route is under street-tree canopy, using **[NYC Parks Forestry Tree Points](https://data.cityofnewyork.us/d/hn5i-inap)**. That dataset has about 900k living street trees. Crown size is estimated from trunk diameter.
4. Reads the current temperature and heat index from the nearest **[National Weather Service](https://www.weather.gov)** station. Shade starts to count when it feels like 75°F and counts fully at 90°F.
5. Ranks the routes by "effective minutes":

   ```
   cost = walk time × (1 + 0.6 × heat × share of route in sun)
        + 2 min per wet sensor passed
        + 60 min if any flooded sensor is passed
   ```

   On a mild day this means the fastest dry route wins. On a hot day an unshaded minute counts as up to 1.6 minutes, so a slightly longer, shadier street can win. A flooded route comes last unless every option is flooded.

Each route card says which data source decided its place in the ranking: **FloodNet** (it avoids, or passes, a wet or flooded sensor), **Street trees + NWS heat** (it won or lost on shade on a warm day), or **Walk time** (nothing else separated it from the others). The API returns this as `decidedBy: { source, text }` on every route.

Each route card has an **Open in Google Maps** link. It pins the chosen route with waypoints so you can navigate turn-by-turn in Google Maps.

## Run it

Requires Node 20+. There are no dependencies to install.

```sh
npm start          # http://localhost:3000
npm test           # unit tests (offline)
```

Type addresses (geocoded with [NYC GeoSearch](https://geosearch.planninglabs.nyc)) or click the map to set a start and an end point. The **Heat** menu lets you force shade-seeking ("It's hot") or turn it off.

### Configuration (env vars)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `GOOGLE_MAPS_API_KEY` | unset | If set, candidate routes come from the [Google Routes API](https://developers.google.com/maps/documentation/routes) (`WALK` mode) instead of OpenStreetMap. The key needs the Routes API enabled. |
| `OSRM_URL` | `https://routing.openstreetmap.de/routed-foot` | OSRM foot-profile server used when no Google key is set. Run your own server for production traffic. |
| `SOCRATA_APP_TOKEN` | unset | NYC Open Data app token, for higher rate limits on tree lookups. |
| `HOST` | `0.0.0.0` | Address to listen on |
| `TRUST_PROXY` | unset | Set to `1` behind a load balancer or CDN so rate limits use the visitor's IP from `X-Forwarded-For` |
| `ROUTE_LIMIT_PER_MIN` | `20` | Route searches allowed per visitor per minute |

### GitHub Pages (no server)

The app also runs with no server at all. Turn on GitHub Pages for this repo (Settings > Pages > Deploy from a branch, folder `/ (root)`), and the site at `https://<user>.github.io/walking_path/` opens the app. When the page can't reach `api/health`, `public/engine.js` runs the same code from `src/` in the browser and calls FloodNet, OSRM, NYC Open Data, NWS and NYC GeoSearch directly. It only asks FloodNet about sensors near the routes, so the sensor map fills in after a search. If one of those services blocks browser requests, the page says which data is missing (for example, "Live flood data couldn't load") and ranks on what it has.

### Running it as a public website

To put it online for free, use [Render](https://render.com): sign in with GitHub, choose **New > Blueprint**, and pick this repo. `render.yaml` sets everything up, and each merge redeploys. The free plan sleeps when idle, so the first visit after a quiet spell takes about 30 seconds.


The server is ready to sit behind a host's HTTPS proxy as a single process:

- **Rate limits** per visitor IP: 20 route searches, 120 address lookups and 30 sensor refreshes a minute. Over the limit returns `429` with `Retry-After`.
- **Caching**: identical route searches are reused for 2 minutes and address lookups for a day, so repeat clicks and shared links don't hit the routing server again. FloodNet is polled in the background every 3 minutes no matter how much traffic there is.
- **Headers**: a Content-Security-Policy that only allows this site, Leaflet from unpkg and OpenStreetMap tiles, plus `nosniff` and a strict referrer policy.
- **Errors**: upstream failures are logged on the server, and visitors only see a generic "data service is not responding" message.
- Limits and caches live in memory, so they reset on restart and aren't shared if you run several processes.

Before launch, set `GOOGLE_MAPS_API_KEY` or point `OSRM_URL` at your own OSRM server, and swap the openstreetmap.org tile URL for a tile provider that allows production traffic. Both public OSM services are for light use only.

## API

- `GET /api/route?from=lat,lng&to=lat,lng&heat=auto|on|off` returns ranked routes with geometry, shade %, nearby sensors, weather, and trees along the routes.
- `GET /api/sensors` returns every active FloodNet sensor with its latest depth and status (`dry`/`wet`/`flooded`/`unknown`).
- `GET /api/geocode?q=...` returns address autocomplete results.
- `GET /api/trees?bbox=minLat,minLng,maxLat,maxLng` returns street trees in a small area as `[lat, lng, crownRadiusM]`. The map draws every tree in view from zoom 16 up, and only the trees along your routes when zoomed out.

## How it's built

```
server.js         HTTP server: JSON API + static files
src/floodnet.js   polls every FloodNet sensor every 3 min, keeps the latest reading
src/trees.js      fetches street trees in ~1 km tiles; caches them in memory and in .cache/ for 7 days
src/weather.js    NWS latest observation → heat weight
src/routing.js    candidate routes (OSRM or Google) plus via-point detours, deduped
src/scoring.js    shade share, flood proximity, ranking
public/           Leaflet map UI
```

## Known limits and next steps

- **Coverage is NYC only.** FloodNet and the tree inventory are NYC datasets, and requests outside the five boroughs are rejected.
- **Sensors are points.** A sensor only reports the spot where it's mounted. A street with no sensor is treated as dry. Possible next steps: add NYC's [Stormwater Flood Maps](https://data.cityofnewyork.us/d/9i7c-xyvv) as a "prone to flooding" prior when it's raining, and 311 street-flooding complaints.
- **Shade is approximate.** Canopy is estimated from trunk diameter, and building shade (which depends on time of day) isn't modeled yet. Possible next steps: the NYC LiDAR canopy layer and a sun-position and building-height shadow model.
- **Apple Maps.** The Apple Maps Server API needs a signed developer token and doesn't accept intermediate waypoints for walking, so there's no Apple provider or deep link yet. Google Maps links follow the chosen route through waypoints.
- **Public OSRM demo server.** The default routing server is a free community service with fair-use limits. Use a Google key or self-host OSRM before real launch.
