/**
 * Nation / coverage helpers for LiDAR enrichment.
 * Layperson notes explain what open data exists vs what the browser can use.
 * Cover keys drive map colour in “public data” mode (showcase what is / isn’t reachable).
 */

/** Map + legend colours for public-data coverage (amber reserved for selection). */
export const COVER_COLORS = {
  'ea-zone': '#3E7C4F', // England — EA LiDAR reachable
  'ea-lidar': '#5FA86E', // England — measured this session
  'scot-zone': '#5B7C9A', // Scotland — tiles may exist
  'scot-lidar': '#7A9BB8', // Scotland — tile hit, measured
  'scot-gap': '#3A4A58', // Scotland — no tile yet
  'wales-blocked': '#6B5E4E', // Wales — open data, browser blocked
  estimate: '#4A5340', // Looked up; no usable LiDAR
  sample: '#8A7B5A', // Offline demo parcels
  unknown: '#2A3228' // Not classified
};

export const COVER_LABELS = {
  'ea-zone': 'England · EA LiDAR zone',
  'ea-lidar': 'England · measured (EA)',
  'scot-zone': 'Scotland · partial cover',
  'scot-lidar': 'Scotland · measured tile',
  'scot-gap': 'Scotland · no tile yet',
  'wales-blocked': 'Wales · open but blocked',
  estimate: 'No LiDAR · estimate only',
  sample: 'Demo sample (offline)',
  unknown: 'Unknown'
};

/** Approximate nation from lon/lat when NFI COUNTRY is absent. */
export function nationOfLonLat(lon, lat) {
  // Scotland (incl. Solway / Borders heuristic)
  if (lat >= 54.85) return 'scotland';
  if (lat >= 54.55 && lon <= -2.6) return 'scotland';

  // Wales (mainland + anglesey-ish); keeps Cheshire/Mersey in England
  if (lon <= -2.65 && lon >= -5.6 && lat >= 51.3 && lat <= 53.48) {
    if (lat <= 52.15 || lon <= -3.05 || (lon <= -2.85 && lat <= 53.05)) return 'wales';
  }

  return 'england';
}

export function nationFromFeature(feature) {
  const c = (feature?.properties?.__country || '').toString().trim().toLowerCase();
  if (c.startsWith('scot')) return 'scotland';
  if (c.startsWith('wal')) return 'wales';
  if (c.startsWith('eng')) return 'england';
  const [lon, lat] = centroidLonLat(feature?.geometry);
  return nationOfLonLat(lon, lat);
}

function centroidLonLat(geometry) {
  if (!geometry) return [0, 0];
  const polys =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const poly of polys) {
    for (let i = 0; i < poly[0].length - 1; i++) {
      sx += poly[0][i][0];
      sy += poly[0][i][1];
      n++;
    }
  }
  return n ? [sx / n, sy / n] : [0, 0];
}

/** Parcel centroid [lon, lat] for FSI / coverage lookups. */
export function featureCentroid(feature) {
  return centroidLonLat(feature?.geometry);
}

/** Zone colour before a parcel is sampled (capability, not result). */
export function coverKeyForNation(nation) {
  if (nation === 'wales') return 'wales-blocked';
  if (nation === 'scotland') return 'scot-zone';
  if (nation === 'sample') return 'sample';
  if (nation === 'england') return 'ea-zone';
  return 'unknown';
}

/**
 * Refine cover key after enrichment resolves.
 * Measured = public data worked; gap/blocked/estimate = clearly not (yet) usable live.
 */
export function coverKeyAfterEnrich(enrich) {
  if (!enrich) return 'unknown';
  if (enrich.canopySource === 'sample' || enrich.terrainSource === 'sample' || enrich.nation === 'sample') {
    return 'sample';
  }
  const nation = enrich.nation;
  if (nation === 'wales') return 'wales-blocked';
  if (nation === 'scotland') {
    if (enrich.canopySource === 'lidar') return 'scot-lidar';
    return 'scot-gap';
  }
  if (nation === 'england') {
    if (enrich.canopySource === 'lidar') return 'ea-lidar';
    if (enrich.status === 'ok' || enrich.status === 'none' || enrich.status === 'error') {
      return 'estimate';
    }
    return 'ea-zone';
  }
  return 'unknown';
}

/** Stamp __nation / __cover on feature properties for MapLibre. */
export function applyCoverProps(feature, enrich = null) {
  if (!feature?.properties) return;
  const nation =
    enrich?.nation ||
    feature.properties.__nation ||
    nationFromFeature(feature);
  feature.properties.__nation = nation;
  feature.properties.__cover = enrich
    ? coverKeyAfterEnrich(enrich)
    : coverKeyForNation(nation === 'sample' ? 'sample' : nation);
}

/**
 * Plain-English coverage explanation for the panel / exports.
 * Keep sentence case; this is user-facing product copy.
 */
export function coverageNoteFor(nation, detail = null) {
  if (nation === 'england') {
    return detail === 'none'
      ? 'No usable LiDAR samples here — heights fall back to type estimates.'
      : null;
  }
  if (nation === 'wales') {
    return (
      'Wales publishes open LiDAR (ground and surface heights), but the file host blocks live use in a web browser. ' +
      'We cannot read tree heights here yet — the model uses estimates instead. A small server proxy would unlock this later.'
    );
  }
  if (nation === 'scotland') {
    if (detail === 'ok') {
      return (
        'Scotland height is from open national LiDAR tiles (surface minus ground). ' +
        'Coverage is still rolling out (2025–2027) and is patchy — not every wood has a tile yet.'
      );
    }
    if (detail === 'partial') {
      return (
        'Found Scotland terrain (ground model) but not a matching surface tile, so tree height is still estimated.'
      );
    }
    return (
      'No Scotland LiDAR tile for this spot yet. The national survey is still being flown and published in blocks ' +
      '(through 2027). Until a tile appears, heights use estimates. Scotland also has no ready-made “vegetation only” ' +
      'product like England’s — we derive tree height as surface minus ground where both tiles exist.'
    );
  }
  return 'LiDAR not available for this location — heights use estimates.';
}

/**
 * OSGB 1 km grid letters+digits (e.g. NR5908) for Scottish NLP S3 keys.
 * @see Ordnance Survey national grid
 */
const GRID_LETTERS = [
  ['SV', 'SW', 'SX', 'SY', 'SZ', 'TV', 'TW'],
  ['SQ', 'SR', 'SS', 'ST', 'SU', 'TQ', 'TR'],
  ['SL', 'SM', 'SN', 'SO', 'SP', 'TL', 'TM'],
  ['SF', 'SG', 'SH', 'SJ', 'SK', 'TF', 'TG'],
  ['SA', 'SB', 'SC', 'SD', 'SE', 'TA', 'TB'],
  ['NV', 'NW', 'NX', 'NY', 'NZ', 'OV', 'OW'],
  ['NQ', 'NR', 'NS', 'NT', 'NU', 'OQ', 'OR'],
  ['NL', 'NM', 'NN', 'NO', 'NP', 'OL', 'OM'],
  ['NF', 'NG', 'NH', 'NJ', 'NK', 'OF', 'OG'],
  ['NA', 'NB', 'NC', 'ND', 'NE', 'OA', 'OB'],
  ['HV', 'HW', 'HX', 'HY', 'HZ', 'JV', 'JW'],
  ['HQ', 'HR', 'HS', 'HT', 'HU', 'JQ', 'JR'],
  ['HL', 'HM', 'HN', 'HO', 'HP', 'JL', 'JM']
];

export function bngToOs1km(e, n) {
  if (!Number.isFinite(e) || !Number.isFinite(n)) return null;
  if (e < 0 || n < 0 || e >= 700000 || n >= 1300000) return null;
  const e100 = Math.floor(e / 100000);
  const n100 = Math.floor(n / 100000);
  const row = n100;
  const col = e100;
  const letters = GRID_LETTERS[row]?.[col];
  if (!letters) return null;
  const eKm = Math.floor((e % 100000) / 1000);
  const nKm = Math.floor((n % 100000) / 1000);
  return `${letters}${String(eKm).padStart(2, '0')}${String(nKm).padStart(2, '0')}`;
}
