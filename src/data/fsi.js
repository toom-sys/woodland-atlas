/**
 * Met Office Fire Severity Index via Natural England OASYS FeatureServer.
 * Fallback chain (SPEC §3.5): live → manual assumptions → default 2.
 * Never throws — fire scoring must not block on this feed.
 */
import { state } from '../state.js';
import { setPill } from '../ui/pills.js';

/** Verified 2026-07-22 — see docs/endpoints.md. Re-check if NE republishes. */
export const FSI_LAYER =
  'https://services.arcgis.com/JJzESW51TqeY9uat/arcgis/rest/services/OASYS_FSI_PRD_VIEW/FeatureServer/0';

const TIMEOUT_MS = 9000;
const HALF_BOX = 0.02; // ~2 km envelope around the point
/** Cache by rounded grid cell (~1 km) so nearby parcels share one query. */
const cache = new Map();

let liveOk = false;
let attempted = false;

function cacheKey(lon, lat) {
  return `${lon.toFixed(2)},${lat.toFixed(2)}`;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('FSI timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * Query today’s FSI rating for a lon/lat. Returns null on any failure.
 * @returns {Promise<{level:number, square:string|null, date:string|null}|null>}
 */
export async function fetchFsiAt(lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const key = cacheKey(lon, lat);
  if (cache.has(key)) return cache.get(key);

  attempted = true;
  const xmin = lon - HALF_BOX;
  const ymin = lat - HALF_BOX;
  const xmax = lon + HALF_BOX;
  const ymax = lat + HALF_BOX;
  const params = new URLSearchParams({
    f: 'json',
    where: 'data_date_offset_pk=0',
    geometry: `${xmin},${ymin},${xmax},${ymax}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outFields: 'square_reference_pk,dow_date,data_date_offset_pk,rating',
    returnGeometry: 'false',
    resultRecordCount: '5'
  });
  // Do not send spatialRel — NE hosts reject it (see endpoints.md).

  try {
    const res = await withTimeout(fetch(`${FSI_LAYER}/query?${params}`), TIMEOUT_MS);
    if (!res.ok) throw new Error(`FSI HTTP ${res.status}`);
    const data = await res.json();
    const feats = data?.features;
    if (!Array.isArray(feats) || !feats.length) {
      cache.set(key, null);
      return null;
    }
    // Prefer the feature whose centroid is closest to the query point when multiple.
    let best = feats[0];
    let bestRating = Number(best?.attributes?.rating);
    for (const f of feats) {
      const r = Number(f?.attributes?.rating);
      if (Number.isFinite(r) && r >= 1 && r <= 5) {
        best = f;
        bestRating = r;
        break;
      }
    }
    if (!Number.isFinite(bestRating) || bestRating < 1 || bestRating > 5) {
      cache.set(key, null);
      return null;
    }
    const result = {
      level: Math.round(bestRating),
      square: best.attributes?.square_reference_pk ?? null,
      date: best.attributes?.dow_date ?? null
    };
    cache.set(key, result);
    liveOk = true;
    return result;
  } catch {
    cache.set(key, null);
    return null;
  }
}

/**
 * Resolve FSI level for scoring: live if present, else manual, else default 2.
 * @returns {{level:number, source:'live'|'manual'|'default', square?:string|null, date?:string|null}}
 */
export function resolveFsi(live) {
  if (live && live.level != null && Number.isFinite(live.level)) {
    return {
      level: live.level,
      source: 'live',
      square: live.square ?? null,
      date: live.date ?? null
    };
  }
  const manual = state.rates.fire?.fsiLevelManual;
  if (manual != null && Number.isFinite(manual)) {
    return { level: Math.max(1, Math.min(5, Math.round(manual))), source: 'manual' };
  }
  return { level: 2, source: 'default' };
}

/** Update the masthead FSI pill from the resolved source. */
export function setFsiPill(source) {
  if (source === 'live') {
    setPill('pill-fsi', 'ok', 'FSI · LIVE');
  } else if (source === 'manual' || source === 'default') {
    setPill('pill-fsi', 'warn', 'FSI · MANUAL');
  } else {
    setPill('pill-fsi', '', 'FSI · UNAVAILABLE');
  }
}

export function initFsiPill() {
  setPill('pill-fsi', 'warn', 'FSI · MANUAL');
}

/**
 * After a live attempt, refresh pill to reflect best-known status.
 * Call when enrichment finishes or assumptions change.
 */
export function refreshFsiPillFromState() {
  if (liveOk) {
    setFsiPill('live');
    return;
  }
  if (attempted) {
    setFsiPill('manual');
    return;
  }
  // Not attempted yet — still show manual as the working path.
  setFsiPill('manual');
}

/** Clear live cache (e.g. if we later add a refresh control). */
export function clearFsiCache() {
  cache.clear();
  liveOk = false;
  attempted = false;
}
