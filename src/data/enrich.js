/**
 * Parcel enrichment orchestration — LiDAR canopy + DTM terrain + FSI on selection.
 * Routes by nation: England (EA WCS), Scotland (S3 NLP tiles), Wales (blocked — note only).
 * Results cached on the feature in memory (no localStorage). Fail soft always.
 */
import { state, notify } from '../state.js';
import { sampleCanopyEngland, emptyEnrich, applyExtrusionHeight } from './lidar.js';
import { sampleTerrainEngland } from './terrain.js';
import { sampleScotland } from './scotland.js';
import { nationFromFeature, coverageNoteFor, applyCoverProps, featureCentroid } from './nation.js';
import { applyWindthrowProps } from '../scoring/windthrow.js';
import { applyFireProps } from '../scoring/fire.js';
import {
  fetchFsiAt,
  resolveFsi,
  setFsiPill,
  initFsiPill,
  refreshFsiPillFromState
} from './fsi.js';
import { setPill } from '../ui/pills.js';
import { applyInferredAge, defaultAge } from './nfi.js';

const inflight = new Map();
let lidarLive = false;
let lidarAttempted = false;

/** Avoid static cycle with map.js (map selects → enrich → map pushSource). */
async function refreshMapSource() {
  try {
    const { pushSource } = await import('../map.js');
    pushSource();
  } catch {
    /* map may not be ready */
  }
}

function setLidarPill(kind, label) {
  if (kind === 'live') {
    setPill('pill-lidar', 'ok', label || 'LIDAR · LIVE');
  } else if (kind === 'unavailable') {
    setPill('pill-lidar', '', label || 'LIDAR · UNAVAILABLE');
  } else if (kind === 'warn') {
    setPill('pill-lidar', 'warn', label || 'LIDAR · PARTIAL');
  } else if (kind === 'sampling') {
    setPill('pill-lidar', 'ok', 'LIDAR · SAMPLING');
  }
}

export function initEnrichmentPills() {
  setLidarPill('unavailable', 'LIDAR · ENGLAND');
  initFsiPill();
}

function parcelCentroid(f) {
  return featureCentroid(f);
}

/** Stamp FSI onto enrich — live query with manual/default fallback. */
async function applyFsi(f) {
  if (f.enrich.fsiSource === 'sample') return;

  const cen = parcelCentroid(f);
  let live = null;
  if (cen) {
    live = await fetchFsiAt(cen[0], cen[1]).catch(() => null);
  }
  if (live && live.level != null) {
    f.enrich.fsiLevel = live.level;
    f.enrich.fsiSource = 'live';
    f.enrich.fsiSquare = live.square;
    f.enrich.fsiDate = live.date;
    setFsiPill('live');
  } else {
    const resolved = resolveFsi(null);
    f.enrich.fsiLevel = resolved.level;
    f.enrich.fsiSource = resolved.source;
    f.enrich.fsiSquare = null;
    f.enrich.fsiDate = null;
    setFsiPill(resolved.source);
  }
}

function finishEnrichVisuals(f) {
  applyExtrusionHeight(f);
  applyCoverProps(f, f.enrich);
  applyInferredAge(f);
  const age =
    state.selected.get(f.properties.__id)?.age ?? defaultAge(f.properties.__type);
  applyWindthrowProps(f, age);
  applyFireProps(f, age);
}

/**
 * Ensure feature.enrich exists; kick off sampling if needed.
 * Safe to call repeatedly — caches and dedupes in-flight work.
 */
export function enrichParcel(id) {
  const f = state.features.get(id);
  if (!f) return;

  if (!f.enrich) f.enrich = emptyEnrich();

  // Sample / demo parcels ship with fixed enrichment — do not hit remote data.
  if (f.enrich.canopySource === 'sample' || f.enrich.terrainSource === 'sample') {
    f.enrich.status = 'ok';
    f.enrich.nation = 'sample';
    f.enrich.coverageNote =
      'Sample parcels use fixed demo heights so the tool works offline.';
    finishEnrichVisuals(f);
    refreshFsiPillFromState();
    return;
  }

  if (f.enrich.status === 'ok' || f.enrich.status === 'none' || f.enrich.status === 'partial') {
    if (!f.enrich.fire || !f.enrich.windthrow) finishEnrichVisuals(f);
    return;
  }

  if (inflight.has(id)) return;

  f.enrich.status = 'loading';
  lidarAttempted = true;
  setLidarPill('sampling');
  notify();

  const job = runEnrich(f)
    .catch(() => {
      f.enrich.status = 'error';
      f.enrich.coverageNote =
        f.enrich.coverageNote ||
        'LiDAR lookup failed — heights fall back to type estimates.';
      finishEnrichVisuals(f);
      if (!lidarLive) setLidarPill('unavailable');
    })
    .finally(() => {
      inflight.delete(id);
      notify();
      refreshMapSource();
    });

  inflight.set(id, job);
}

async function runEnrich(f) {
  const nation = nationFromFeature(f);
  f.enrich.nation = nation;

  const fsiPromise = applyFsi(f).catch(() => {
    const resolved = resolveFsi(null);
    f.enrich.fsiLevel = resolved.level;
    f.enrich.fsiSource = resolved.source;
    setFsiPill(resolved.source);
  });

  if (nation === 'wales') {
    f.enrich.status = 'none';
    f.enrich.coverageNote = coverageNoteFor('wales');
    await fsiPromise;
    finishEnrichVisuals(f);
    if (!lidarLive) setLidarPill('warn', 'LIDAR · WALES BLOCKED');
    return;
  }

  if (nation === 'scotland') {
    const [sc] = await Promise.all([
      sampleScotland(f.geometry).catch(() => null),
      fsiPromise
    ]);
    if (!sc) {
      f.enrich.status = 'error';
      f.enrich.coverageNote = coverageNoteFor('scotland');
      if (!lidarLive) setLidarPill('unavailable');
      finishEnrichVisuals(f);
      return;
    }
    applyScotland(f, sc);
    return;
  }

  // England (default)
  const [canopy, terrain] = await Promise.all([
    sampleCanopyEngland(f.geometry).catch(() => ({
      canopyHeightM: null,
      canopySampleCount: 0,
      canopySource: null,
      status: 'error'
    })),
    sampleTerrainEngland(f.geometry).catch(() => ({
      elevationM: null,
      slopeDeg: null,
      aspectDeg: null,
      exposure: null,
      terrainSource: null,
      status: 'error'
    })),
    fsiPromise
  ]);

  f.enrich.canopyHeightM = canopy.canopyHeightM;
  f.enrich.canopySampleCount = canopy.canopySampleCount;
  f.enrich.canopySource = canopy.canopySource;
  f.enrich.elevationM = terrain.elevationM;
  f.enrich.slopeDeg = terrain.slopeDeg;
  f.enrich.aspectDeg = terrain.aspectDeg;
  f.enrich.exposure = terrain.exposure;
  f.enrich.terrainSource = terrain.terrainSource;

  const gotLidar = canopy.canopySource === 'lidar' || terrain.terrainSource === 'dtm';
  const hasValues = canopy.canopyHeightM != null || terrain.elevationM != null;

  if (gotLidar) {
    lidarLive = true;
    setLidarPill('live', 'LIDAR · LIVE');
    f.enrich.status = 'ok';
    f.enrich.coverageNote = null;
  } else if (hasValues) {
    f.enrich.status = 'ok';
    f.enrich.coverageNote = coverageNoteFor('england', 'none');
    if (!lidarLive && lidarAttempted) setLidarPill('unavailable');
  } else if (canopy.status === 'error' && terrain.status === 'error') {
    f.enrich.status = 'error';
    f.enrich.coverageNote = coverageNoteFor('england', 'none');
    if (!lidarLive) setLidarPill('unavailable');
  } else {
    f.enrich.status = 'none';
    f.enrich.coverageNote = coverageNoteFor('england', 'none');
    if (!lidarLive && lidarAttempted) setLidarPill('unavailable');
  }

  finishEnrichVisuals(f);
}

function applyScotland(f, sc) {
  f.enrich.canopyHeightM = sc.canopyHeightM;
  f.enrich.canopySampleCount = sc.canopySampleCount;
  f.enrich.canopySource = sc.canopySource;
  f.enrich.elevationM = sc.elevationM;
  f.enrich.slopeDeg = sc.slopeDeg;
  f.enrich.aspectDeg = sc.aspectDeg;
  f.enrich.exposure = sc.exposure;
  f.enrich.terrainSource = sc.terrainSource;
  f.enrich.status = sc.status;

  if (sc.status === 'ok') {
    lidarLive = true;
    setLidarPill('live', 'LIDAR · SCOTLAND');
    f.enrich.coverageNote = coverageNoteFor('scotland', 'ok');
  } else if (sc.status === 'partial') {
    lidarLive = true;
    setLidarPill('warn', 'LIDAR · SCOTLAND PARTIAL');
    f.enrich.coverageNote = coverageNoteFor('scotland', 'partial');
  } else {
    f.enrich.coverageNote = coverageNoteFor('scotland');
    if (!lidarLive) setLidarPill('warn', 'LIDAR · SCOTLAND GAPS');
  }

  finishEnrichVisuals(f);
}
