import { HEIGHT_X, state, DEFAULT_WINDTHROW, AGES } from '../state.js';
import { applyCoverProps } from './nation.js';

function ringArea(c) {
  let a = 0;
  const R = 6378137;
  const d = Math.PI / 180;
  for (let i = 0; i < c.length; i++) {
    const [l1, p1] = c[i];
    const [l2, p2] = c[(i + 1) % c.length];
    a += (l2 - l1) * d * (2 + Math.sin(p1 * d) + Math.sin(p2 * d));
  }
  return Math.abs((a * R * R) / 2);
}

export function featureHa(f) {
  const g = f.geometry;
  if (!g) return 0;
  const polys =
    g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  let m2 = 0;
  for (const p of polys) {
    if (!p.length) continue;
    m2 += ringArea(p[0]);
    for (let i = 1; i < p.length; i++) m2 -= ringArea(p[i]);
  }
  return m2 / 10000;
}

export function groupOf(t) {
  t = (t || '').toLowerCase();
  if (t.includes('mixed')) return 'mixed';
  if (t.includes('conifer')) return 'conifer';
  if (t.includes('broadlea') || t.includes('coppice')) return 'broadleaf';
  if (
    /felled|ground prep|windblow|failed|bare|grass|open|agriculture|urban|road|river|quarry|power|windfarm|other vegetation|uncertain/.test(
      t
    )
  )
    return 'other';
  if (t.includes('young') || t.includes('shrub') || t.includes('low density') || t.includes('assumed'))
    return 'mixed';
  return 'mixed';
}

/**
 * Pick the age band whose assumed canopy (group × age table) is closest to
 * measured height. Table lives in assumptions — no magic numbers here.
 */
export function ageFromCanopyHeight(group, canopyHeightM) {
  if (canopyHeightM == null || !Number.isFinite(canopyHeightM)) return null;
  const g = group || 'other';
  const table =
    state.rates.windthrow?.estimatedCanopyM?.[g] ||
    DEFAULT_WINDTHROW.estimatedCanopyM[g] ||
    DEFAULT_WINDTHROW.estimatedCanopyM.other;
  let best = 'semi';
  let bestDist = Infinity;
  for (const [age] of AGES) {
    const h = table[age];
    if (h == null || !Number.isFinite(h)) continue;
    const d = Math.abs(h - canopyHeightM);
    if (d < bestDist) {
      bestDist = d;
      best = age;
    }
  }
  return best;
}

/**
 * Infer stand age band from open data.
 * Priority: measured canopy height → clear NFI type cues → semi default.
 * NFI does not publish age — this is an estimate for valuation/risk only.
 * Returns { age, source: 'height'|'type'|'default' }.
 */
export function inferAge({ type, group, canopyHeightM } = {}) {
  const t = (type || '').toLowerCase();
  const g = group || groupOf(type);

  // Measured / sample canopy beats type labels (height is the best open proxy).
  const fromHeight = ageFromCanopyHeight(g, canopyHeightM);
  if (fromHeight) {
    return { age: fromHeight, source: 'height' };
  }

  // Clear stage labels from NFI class when no canopy yet.
  if (/young|ground prep|failed|shrub|low density|felled|windblow/.test(t)) {
    return { age: 'young', source: 'type' };
  }

  return { age: 'semi', source: 'default' };
}

/** Type-only fallback (no LiDAR yet). */
export function defaultAge(t) {
  return inferAge({ type: t }).age;
}

export const AGE_SOURCE_LABELS = {
  height: 'from canopy',
  type: 'from NFI type',
  default: 'assumed',
  user: 'set by you'
};

/**
 * Build / refresh selection age from inference unless the user locked it.
 * Returns true if age changed.
 */
export function applyInferredAge(feature, { force = false } = {}) {
  if (!feature?.properties?.__id) return false;
  const id = feature.properties.__id;
  const sel = state.selected.get(id);
  if (!sel) return false;
  if (sel.ageLocked && !force) return false;

  const next = inferAge({
    type: feature.properties.__type,
    group: feature.properties.__group,
    canopyHeightM: feature.enrich?.canopyHeightM ?? null
  });
  const changed = sel.age !== next.age || sel.ageSource !== next.source;
  sel.age = next.age;
  sel.ageSource = next.source;
  sel.ageLocked = false;
  return changed;
}

/** Initial selection payload for a newly clicked parcel. */
export function selectionAgeState(feature) {
  const next = inferAge({
    type: feature?.properties?.__type,
    group: feature?.properties?.__group,
    canopyHeightM: feature?.enrich?.canopyHeightM ?? null
  });
  return { age: next.age, ageSource: next.source, ageLocked: false };
}

export function baseHeight(t) {
  t = (t || '').toLowerCase();
  if (t.includes('conifer')) return 20;
  if (t.includes('mixed')) return 17;
  if (t.includes('broadlea')) return 15;
  if (t.includes('coppice')) return 8;
  if (t.includes('young')) return 5;
  if (t.includes('shrub') || t.includes('low density')) return 3;
  if (/felled|ground prep|windblow|failed/.test(t)) return 1;
  return 12;
}

const NFI_ROOT = 'https://services2.arcgis.com/mHXjwgl3OARRqqD4/ArcGIS/rest/services';
const FETCH_TIMEOUT_MS = 9000;
const DISCOVER_TIMEOUT_MS = 10000;
const MAX_DISCOVER_CANDIDATES = 6;

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Hard deadline — AbortSignal alone can leave hung CORS/proxy fetches unresolved. */
function withTimeout(promise, ms, message = 'timeout') {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(to);
        resolve(v);
      },
      (e) => {
        clearTimeout(to);
        reject(e);
      }
    );
  });
}

function serviceUrl(name) {
  return (
    NFI_ROOT.replace(/\/ArcGIS\/rest\/services$/i, '') +
    '/ArcGIS/rest/services/' +
    String(name).split('/').pop() +
    '/FeatureServer'
  );
}

/** Prefer inventory FeatureServers; dated names stay discoverable (SPEC §3.1). */
function rankNfiCandidates(services) {
  const inventory = services.filter(
    (s) => /National_Forest_Inventory/i.test(s.name) && s.type === 'FeatureServer'
  );
  const pool = inventory.length
    ? inventory
    : services.filter((s) => /forest|nfi|woodland/i.test(s.name) && s.type === 'FeatureServer');
  return pool
    .slice()
    .sort((a, b) => {
      const score = (n) => {
        let s = 0;
        if (/National_Forest_Inventory/i.test(n)) s += 100;
        if (/National_Forest_Inventory_GB_\d{4}$/i.test(n)) s += 50; // prefer full GB IFT inventory
        if (/_GB_/i.test(n)) s += 20;
        if (/_view$/i.test(n)) s -= 30;
        if (/Woodland_GB/i.test(n)) s -= 15; // older woodland-only variant
        const y = n.match(/(20\d{2})/g);
        if (y) s += (Math.max(...y.map(Number)) - 2000) * 2;
        return s;
      };
      return score(b.name) - score(a.name) || b.name.localeCompare(a.name);
    })
    .slice(0, MAX_DISCOVER_CANDIDATES);
}

/**
 * Discover a live NFI FeatureServer layer.
 * Prefer a direct probe of recent GB inventory names, then directory ranking (SPEC §3.1).
 */
export async function discoverNFI() {
  return withTimeout(
    (async () => {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), DISCOVER_TIMEOUT_MS);
      try {
        // Fast path: known recent inventory names (still not a single hardcoded-only URL).
        const preferred = [
          'National_Forest_Inventory_GB_2024',
          'National_Forest_Inventory_GB_2023',
          'National_Forest_Inventory_Woodland_GB_2022'
        ];
        for (const name of preferred) {
          if (ctl.signal.aborted) break;
          try {
            const url = serviceUrl(name);
            const meta = await fetchJson(url + '?f=json', ctl.signal);
            if (!meta.error && (meta.layers || [])[0]) return url + '/' + meta.layers[0].id;
          } catch {
            /* try next */
          }
        }

        const dir = await fetchJson(NFI_ROOT + '?f=json', ctl.signal);
        const svcs = rankNfiCandidates(dir.services || []);
        if (!svcs.length) throw new Error('no NFI service in directory');
        for (const s of svcs) {
          if (ctl.signal.aborted) throw new Error('discovery aborted');
          try {
            const url = serviceUrl(s.name);
            const meta = await fetchJson(url + '?f=json', ctl.signal);
            if (meta.error) continue;
            const layer = (meta.layers || [])[0];
            if (layer) return url + '/' + layer.id;
          } catch {
            /* try next candidate */
          }
        }
        throw new Error('no queryable layer');
      } finally {
        clearTimeout(to);
      }
    })(),
    DISCOVER_TIMEOUT_MS + 500,
    'NFI discovery timeout'
  );
}

/**
 * Query viewport envelope; mutate `features` Map. Returns count of newly added features.
 */
export async function queryViewport(layerUrl, bounds, features) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const env = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
    // Omit spatialRel — FC hosted services currently 400 on esriIntersects (see docs/endpoints.md).
    // Tight outFields + maxAllowableOffset keep payloads small enough for the browser.
    const span = Math.max(bounds.getEast() - bounds.getWest(), bounds.getNorth() - bounds.getSouth());
    const simplify = Math.max(span / 800, 0.00005);
    const q =
      `${layerUrl}/query?f=geojson&where=1%3D1&geometry=${env}` +
      `&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326` +
      `&outFields=FID,IFT_IOA,CATEGORY,Area_Ha,COUNTRY` +
      `&maxAllowableOffset=${simplify}&geometryPrecision=5&resultRecordCount=2000`;
    const gj = await withTimeout(fetchJson(q, ctl.signal), FETCH_TIMEOUT_MS, 'NFI query timeout');
    if (gj.error) throw new Error(gj.error.message || 'NFI query error');
    let added = 0;
    for (const f of gj.features || []) {
      const p = f.properties || {};
      const oid = p.OBJECTID ?? p.objectid ?? p.FID ?? p.fid;
      if (oid == null) continue;
      const id = 'nfi-' + oid;
      if (features.has(id)) continue;
      const type = p.IFT_IOA ?? p.ift_ioa ?? p.CATEGORY ?? p.category ?? 'Woodland';
      const typeStr = String(type);
      const idProps = {
        __id: id,
        __type: typeStr,
        __group: groupOf(typeStr),
        __ha: (p.Area_Ha ?? p.Area_ha ?? p.AREA_HA ?? p.hectares) || featureHa(f),
        __h: baseHeight(typeStr) * HEIGHT_X,
        __country: p.COUNTRY ?? p.Country ?? p.country ?? null
      };
      f.properties = idProps;
      applyCoverProps(f);
      features.set(id, f);
      added++;
    }
    return added;
  } finally {
    clearTimeout(to);
  }
}

/** Cap in-memory store; never evict selected features. */
export function capFeatures(features, selected, softCap = 6000, hardFloor = 5000) {
  if (features.size <= softCap) return;
  for (const [id] of features) {
    if (features.size <= hardFloor) break;
    if (!selected.has(id)) features.delete(id);
  }
}
