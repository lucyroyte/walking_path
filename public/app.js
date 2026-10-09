const map = L.map('map', { preferCanvas: true }).setView([40.7128, -73.98], 13);
// CARTO basemaps: free without a key for low-traffic sites, OpenStreetMap data.
const carto = (style) => L.tileLayer(`https://{s}.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}{r}.png`, {
  maxZoom: 20,
  subdomains: 'abcd',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
});
const basemaps = { Grey: carto('light_all'), Streets: carto('voyager'), Dark: carto('dark_all') };
basemaps.Grey.addTo(map);
L.control.layers(basemaps, null, { position: 'topright' }).addTo(map);

const COLORS = { flooded: '#c62828', wet: '#ef8f00', dry: '#2e7d32', unknown: '#9e9e9e', offline: '#ffffff' };
// Trees get their own pane below routes and sensors.
map.createPane('trees').style.zIndex = 350;
const treeRenderer = L.canvas({ pane: 'trees' });
const TREE_MIN_ZOOM = 16;
const sensorLayer = L.layerGroup().addTo(map);
const treeLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const pinLayer = L.layerGroup().addTo(map);

const legend = L.control({ position: 'bottomright' });
legend.onAdd = () => {
  const el = L.DomUtil.create('div', 'legend');
  el.innerHTML = `
    <div><i style="background:${COLORS.flooded}"></i>Flooded sensor</div>
    <div><i style="background:${COLORS.wet}"></i>Wet sensor</div>
    <div><i style="background:${COLORS.dry}"></i>Dry sensor</div>
    <div><i style="background:${COLORS.unknown}"></i>No recent reading</div>
    <div><i style="background:#fff;box-shadow:inset 0 0 0 2px #757575"></i>Sensor offline or unreliable</div>
    <div><i style="background:#43a047;opacity:.5"></i>Street tree canopy (est.)</div>
    <div class="hint" id="tree-hint">Zoom in to see all street trees</div>`;
  return el;
};
legend.addTo(map);

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const places = { from: null, to: null };
let lastResult = null;
let selected = 0;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// With server.js running, the browser calls its JSON API. On a static host
// (GitHub Pages) there's no API, so the same logic runs in the page instead.
const serverApi = {
  mode: 'server',
  route: (from, to, heat) => getJson(`api/route?${new URLSearchParams({ from: from.join(','), to: to.join(','), heat })}`),
  sensors: () => getJson('api/sensors'),
  geocode: (q) => getJson(`api/geocode?q=${encodeURIComponent(q)}`),
  trees: (b) => getJson(`api/trees?bbox=${[b.minLat, b.minLng, b.maxLat, b.maxLng].map((n) => n.toFixed(5)).join(',')}`),
};

async function pickApi() {
  try {
    const res = await fetch('api/health');
    if (res.ok && (await res.json()).ok) return serverApi;
  } catch { /* no server here */ }
  return (await import('./engine.js')).browserApi;
}
// Resolved lazily so the inputs and map work while this is still deciding.
const apiReady = pickApi();

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---- Sensors -------------------------------------------------------------

async function loadSensors() {
  try {
    const { sensors, updatedAt } = await (await apiReady).sensors();
    sensorLayer.clearLayers();
    for (const s of sensors) {
      const depth = s.status === 'offline'
        ? `Offline or unreliable (FloodNet status: ${escapeHtml(s.sensorStatus || 'unknown')}); not used for routing`
        : s.depthMm == null ? 'no recent reading' : `${s.depthMm} mm of water`;
      L.circleMarker([s.lat, s.lng], {
        radius: s.status === 'flooded' ? 8 : 5,
        color: s.status === 'offline' ? '#757575' : '#fff', weight: s.status === 'offline' ? 2 : 1,
        fillColor: COLORS[s.status], fillOpacity: 0.95,
      }).bindPopup(`<b>${escapeHtml(s.name)}</b><br>${depth}`).addTo(sensorLayer);
    }
    return { sensors, updatedAt };
  } catch (err) {
    setStatus(`Couldn't load FloodNet sensors: ${err.message}`, true);
  }
}

// ---- Places --------------------------------------------------------------

function setPlace(which, place) {
  places[which] = place;
  $(which).value = place.label;
  pinLayer.clearLayers();
  for (const w of ['from', 'to']) {
    const p = places[w];
    if (p) L.marker([p.lat, p.lng], { title: w }).bindTooltip(w === 'from' ? 'Start' : 'End').addTo(pinLayer);
  }
}

map.on('click', (e) => {
  const which = !places.from ? 'from' : !places.to ? 'to' : document.activeElement?.id === 'from' ? 'from' : 'to';
  setPlace(which, { lat: e.latlng.lat, lng: e.latlng.lng, label: `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}` });
  if (places.from && places.to) findRoutes();
});

for (const which of ['from', 'to']) {
  const input = $(which);
  const list = document.querySelector(`.suggest[data-for="${which}"]`);
  let timer;
  input.addEventListener('input', () => {
    places[which] = null;
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { list.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      try {
        const { results } = await (await apiReady).geocode(q);
        list.innerHTML = '';
        for (const r of results) {
          const li = document.createElement('li');
          li.textContent = r.label;
          li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            setPlace(which, r);
            list.innerHTML = '';
          });
          list.appendChild(li);
        }
      } catch { list.innerHTML = ''; }
    }, 250);
  });
  input.addEventListener('blur', () => setTimeout(() => { list.innerHTML = ''; }, 100));
}

async function resolvePlace(which) {
  if (places[which]) return places[which];
  const q = $(which).value.trim();
  const { results } = await (await apiReady).geocode(q);
  if (!results.length) throw new Error(`Couldn't find "${q}"`);
  setPlace(which, results[0]);
  return results[0];
}

// ---- Routes --------------------------------------------------------------

const fmtMin = (s) => `${Math.round(s / 60)} min`;
const fmtDist = (m) => (m >= 1000 ? `${(m / 1609.34).toFixed(1)} mi` : `${Math.round(m * 3.281)} ft`);

function googleMapsUrl(route, from, to) {
  // Pin the route with a few points along it so Google follows the same streets.
  const pts = [0.25, 0.5, 0.75].map((f) => route.path[Math.floor(route.path.length * f)]);
  const params = new URLSearchParams({
    api: '1', travelmode: 'walking',
    origin: from.join(','), destination: to.join(','),
    waypoints: pts.map((p) => p.join(',')).join('|'),
  });
  return `https://www.google.com/maps/dir/?${params}`;
}

function renderConditions(data) {
  const el = $('conditions');
  const w = data.weather || {};
  const heatText = data.heatMode === 'on' ? 'Shade prioritized (you chose "it\'s hot")'
    : data.heatMode === 'off' ? 'Ignoring heat'
    : data.heatWeight >= 0.5 ? 'Hot out: shade weighted heavily'
    : data.heatWeight > 0 ? 'Warm: shade weighted a little'
    : 'Mild: fastest dry route wins';
  el.innerHTML = `
    <div class="big">${w.tempF != null ? `${w.tempF}°F` : 'Weather unavailable'}${
      w.feelsLikeF != null && w.feelsLikeF !== w.tempF ? `, feels like ${w.feelsLikeF}°F` : ''}</div>
    <div>${escapeHtml(w.description || '')}</div>
    <div>${heatText}</div>
    <div class="meta">FloodNet: ${data.floodnet.sensorCount} sensors checked${
      data.floodnet.updatedAt ? `, updated ${new Date(data.floodnet.updatedAt).toLocaleTimeString()}` : ''}</div>
    ${data.floodnet.error ? `<div class="meta warn">Live flood data couldn't load, so routes are ranked on shade and time only.</div>` : ''}
    ${data.treeError ? `<div class="meta">Tree data unavailable: ${escapeHtml(data.treeError)}</div>` : ''}`;
  el.hidden = false;
}

function routeCard(r, i, data) {
  const li = document.createElement('li');
  li.className = 'route' + (i === selected ? ' selected' : '');
  const floodTag = r.floodStatus === 'flooded'
    ? `<span class="tag flooded">Passes flooding (${r.sensors.flooded.map((s) => `${s.depthMm} mm`).join(', ')})</span>`
    : r.floodStatus === 'wet'
      ? `<span class="tag wet">Some standing water</span>`
      : `<span class="tag clear">No flooding reported</span>`;
  const extra = r.extraMinutes > 0 ? ` · +${r.extraMinutes} min vs fastest` : '';
  li.innerHTML = `
    <div class="top"><span class="time">${fmtMin(r.durationS)}</span><span class="meta">${fmtDist(r.distanceM)}${extra}</span></div>
    <div class="tags">
      ${r.labels.map((l) => `<span class="tag ${l}">${l}</span>`).join('')}
      ${floodTag}
    </div>
    <div class="why"><b>${escapeHtml(r.decidedBy.source)}:</b> ${escapeHtml(r.decidedBy.text)}</div>
    <div class="meta">${r.shadePct}% under tree canopy</div>
    <div class="shadebar"><div style="width:${r.shadePct}%"></div></div>
    ${r.sensors.unknown.length ? `<div class="meta">${r.sensors.unknown.length} sensor(s) on this route are offline or have no recent reading</div>` : ''}
    <a href="${googleMapsUrl(r, data.from, data.to)}" target="_blank" rel="noopener">Open in Google Maps</a>`;
  li.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') return;
    selected = i;
    renderRoutes(data, false);
  });
  return li;
}

function renderRoutes(data, fit = true) {
  routeLayer.clearLayers();
  const list = $('routes');
  list.innerHTML = '';
  data.routes.forEach((r, i) => list.appendChild(routeCard(r, i, data)));

  // Draw unselected first so the selected route sits on top.
  const order = data.routes.map((r, i) => i).sort((a, b) => (a === selected) - (b === selected));
  for (const i of order) {
    const r = data.routes[i];
    const isSel = i === selected;
    const line = L.polyline(r.path, {
      color: isSel ? (r.floodStatus === 'flooded' ? COLORS.flooded : '#1565c0') : '#78909c',
      weight: isSel ? 7 : 4,
      opacity: isSel ? 0.9 : 0.55,
    }).addTo(routeLayer);
    line.on('click', () => { selected = i; renderRoutes(data, false); });
  }
  if (fit) map.fitBounds(L.latLngBounds(data.routes.flatMap((r) => r.path)), { padding: [30, 30] });
}

function drawTrees(trees) {
  treeLayer.clearLayers();
  for (const [lat, lng, r] of trees) {
    L.circle([lat, lng], {
      radius: r, stroke: false, fillColor: '#43a047', fillOpacity: 0.4, interactive: false, renderer: treeRenderer,
    }).addTo(treeLayer);
  }
}

// Zoomed in: every street tree in view (NYC Parks tree data). Zoomed out:
// only the trees along the last searched routes, to keep the map fast.
let routeTrees = [];
let treeRequest = 0;
let treeTimer;
function refreshTrees() {
  clearTimeout(treeTimer);
  treeTimer = setTimeout(async () => {
    const zoomedIn = map.getZoom() >= TREE_MIN_ZOOM;
    const hint = document.getElementById('tree-hint');
    if (hint) hint.hidden = zoomedIn;
    const id = ++treeRequest;
    if (!zoomedIn) return drawTrees(routeTrees);
    const b = map.getBounds().pad(0.2);
    try {
      const { trees } = await (await apiReady).trees({
        minLat: b.getSouth(), minLng: b.getWest(), maxLat: b.getNorth(), maxLng: b.getEast(),
      });
      if (id === treeRequest) drawTrees(trees);
    } catch { /* outside NYC or too wide; keep what's drawn */ }
  }, 300);
}
map.on('moveend', refreshTrees);

async function findRoutes() {
  const btn = $('go');
  btn.disabled = true;
  try {
    setStatus('Finding places…');
    const [from, to] = [await resolvePlace('from'), await resolvePlace('to')];
    setStatus('Checking flood sensors, street trees and weather…');
    const data = await (await apiReady).route([from.lat, from.lng], [to.lat, to.lng], $('heat').value);
    lastResult = data;
    selected = 0;
    renderConditions(data);
    routeTrees = data.trees;
    refreshTrees();
    renderRoutes(data);
    const best = data.routes[0];
    setStatus(best.floodStatus === 'flooded'
      ? 'Every route we found passes a flooded sensor. Consider waiting or taking transit.'
      : `Compared ${data.routes.length} route${data.routes.length > 1 ? 's' : ''}.`, best.floodStatus === 'flooded');
    loadSensors();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

$('trip').addEventListener('submit', (e) => { e.preventDefault(); findRoutes(); });
$('heat').addEventListener('change', () => { if (lastResult) findRoutes(); });

loadSensors();
setInterval(loadSensors, 3 * 60_000);
refreshTrees();
