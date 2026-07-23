/**
 * Place geocoding for the search bar (GB-focused).
 * Primary: Open-Meteo (no key). Fallback: Photon (komoot).
 * Fail soft — timeout / catch → empty results + caller toast.
 */

import { withTimeout } from './geo.js';
import { parseLatLon } from './clientLink.js';

const FETCH_MS = 8000;
const GB_BBOX = [-8.5, 49.5, 2.0, 61.2]; // west, south, east, north

const OPEN_METEO =
  'https://geocoding-api.open-meteo.com/v1/search';
const PHOTON = 'https://photon.komoot.io/api/';

/** Rough zoom by place kind. */
function zoomForKind(kind) {
  if (kind === 'region') return 8.2;
  if (kind === 'county') return 9.2;
  if (kind === 'city') return 10.8;
  if (kind === 'town') return 11.6;
  if (kind === 'village') return 12.4;
  return 11.2;
}

function kindFromOpenMeteo(code) {
  const c = String(code || '');
  if (c.startsWith('ADM1') || c === 'PCL' || c === 'PCLI') return 'region';
  if (c.startsWith('ADM2') || c.startsWith('ADM3')) return 'county';
  if (c === 'PPLC' || c === 'PPLA') return 'city';
  if (c === 'PPLA2' || c === 'PPLA3' || c === 'PPL') return 'town';
  if (c === 'PPLX' || c === 'PPLL') return 'village';
  return 'place';
}

function kindFromPhoton(props) {
  const t = String(props?.type || props?.osm_value || '').toLowerCase();
  if (t === 'country' || t === 'state' || t === 'region') return 'region';
  if (t === 'county') return 'county';
  if (t === 'city') return 'city';
  if (t === 'town') return 'town';
  if (t === 'village' || t === 'hamlet' || t === 'suburb') return 'village';
  return 'place';
}

function labelParts(name, context) {
  const bits = [name, ...context.filter(Boolean)];
  return [...new Set(bits)].join(', ');
}

async function fetchJson(url) {
  const ctl = new AbortController();
  const res = await withTimeout(fetch(url, { signal: ctl.signal }), FETCH_MS, 'geocode timeout');
  if (!res.ok) throw new Error(`geocode ${res.status}`);
  return res.json();
}

async function searchOpenMeteo(q) {
  const url =
    `${OPEN_METEO}?name=${encodeURIComponent(q)}` +
    `&count=8&language=en&countryCode=GB&format=json`;
  const data = await fetchJson(url);
  const rows = data?.results || [];
  return rows.map((r) => {
    const kind = kindFromOpenMeteo(r.feature_code);
    return {
      id: `om-${r.id}`,
      kind,
      kindLabel: kind,
      label: labelParts(r.name, [r.admin1, r.country]),
      name: r.name,
      center: [r.longitude, r.latitude],
      zoom: zoomForKind(kind),
      source: 'place'
    };
  });
}

async function searchPhoton(q) {
  const [w, s, e, n] = GB_BBOX;
  const url =
    `${PHOTON}?q=${encodeURIComponent(q)}` +
    `&limit=8&lang=en&bbox=${w},${s},${e},${n}`;
  const data = await fetchJson(url);
  const feats = data?.features || [];
  return feats
    .filter((f) => {
      const cc = (f.properties?.countrycode || f.properties?.country || '').toLowerCase();
      return !cc || cc === 'gb' || cc === 'uk' || cc.includes('united kingdom');
    })
    .map((f, i) => {
      const p = f.properties || {};
      const kind = kindFromPhoton(p);
      const name = p.name || p.street || q;
      const [lon, lat] = f.geometry?.coordinates || [];
      let bounds = null;
      if (Array.isArray(p.extent) && p.extent.length === 4) {
        // Photon extent: [minLon, maxLon, minLat, maxLat]
        bounds = [
          [p.extent[0], p.extent[2]],
          [p.extent[1], p.extent[3]]
        ];
      }
      return {
        id: `ph-${p.osm_id || i}`,
        kind,
        kindLabel: kind,
        label: labelParts(name, [p.city || p.county, p.state, p.country]),
        name,
        center: [lon, lat],
        zoom: zoomForKind(kind),
        bounds,
        source: 'place'
      };
    })
    .filter((r) => Number.isFinite(r.center[0]) && Number.isFinite(r.center[1]));
}

/**
 * Geocode a place query. Returns `{ results, error? }`.
 * Never throws.
 */
export async function searchPlaces(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return { results: [] };

  try {
    let results = await searchOpenMeteo(q);
    if (results.length) return { results };
  } catch {
    /* try fallback */
  }

  try {
    const results = await searchPhoton(q);
    return { results };
  } catch (err) {
    return {
      results: [],
      error:
        err?.message === 'geocode timeout'
          ? 'Place search timed out'
          : 'Place search unavailable'
    };
  }
}

/** Direct hit for pasted coordinates. */
export function parseDirectLocation(query) {
  const q = String(query || '').trim();
  const coords = parseLatLon(q);
  if (coords) {
    return {
      id: 'coords',
      kind: 'coords',
      kindLabel: 'coords',
      label: `${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`,
      name: 'Coordinates',
      center: coords,
      zoom: 12.2,
      source: 'coords'
    };
  }
  return null;
}
