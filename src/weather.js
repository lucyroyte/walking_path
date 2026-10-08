// Current conditions from the National Weather Service. We use the latest
// observation from the nearest station to decide how much shade matters.

import { fetchJson } from './http.js';

const API = 'https://api.weather.gov';
const cache = new Map(); // rounded lat,lng -> { at, value }
const TTL_MS = 10 * 60_000;

const cToF = (c) => (c == null ? null : c * 9 / 5 + 32);

// NWS Rothfusz regression, used when the station doesn't report heat index.
export function heatIndexF(tempF, rh) {
  if (tempF == null) return null;
  if (rh == null || tempF < 80) return tempF;
  const T = tempF, R = rh;
  let hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R
    - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R
    + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
  if (R < 13 && T <= 112) hi -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
  else if (R > 85 && T <= 87) hi += ((R - 85) / 10) * ((87 - T) / 5);
  return hi;
}

// 0 when it feels mild, 1 when shade really matters. Ramps from 75°F to 90°F
// "feels like", which spans NWS's "caution" band.
export function heatWeight(feelsLikeF) {
  if (feelsLikeF == null) return 0;
  return Math.max(0, Math.min(1, (feelsLikeF - 75) / 15));
}

export async function currentConditions(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const point = await fetchJson(`${API}/points/${lat.toFixed(4)},${lng.toFixed(4)}`);
  const stations = await fetchJson(point.properties.observationStations);
  const stationId = stations.features[0].properties.stationIdentifier;
  const obs = (await fetchJson(`${API}/stations/${stationId}/observations/latest`)).properties;

  const tempF = cToF(obs.temperature?.value);
  const rh = obs.relativeHumidity?.value ?? null;
  const reportedHi = cToF(obs.heatIndex?.value);
  const feelsLikeF = reportedHi ?? heatIndexF(tempF, rh);
  const value = {
    station: stationId,
    observedAt: obs.timestamp,
    description: obs.textDescription,
    tempF: tempF == null ? null : Math.round(tempF),
    humidity: rh == null ? null : Math.round(rh),
    feelsLikeF: feelsLikeF == null ? null : Math.round(feelsLikeF),
    heatWeight: +heatWeight(feelsLikeF).toFixed(2),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}
