// Address autocomplete from NYC GeoSearch (NYC Planning Labs).
import { fetchJson } from './http.js';

export async function geocode(text) {
  const data = await fetchJson(`https://geosearch.planninglabs.nyc/v2/autocomplete?text=${encodeURIComponent(text)}`);
  return {
    results: data.features.slice(0, 6).map((f) => ({
      label: f.properties.label,
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
    })),
  };
}
