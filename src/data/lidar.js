/**
 * EA Vegetation Object Model (VOM) canopy-height sampling via WCS GetCoverage.
 * England only — see scotland.js / nation.js for other nations.
 * ImageServer getSamples is retired — see docs/endpoints.md (2026-07-22).
 */
import {
  VOM_WCS,
  VOM_COVERAGE,
  wgs84ToBng,
  samplePointsInPolygon,
  clampBngBox,
  fetchWcsChip,
  median
} from './geo.js';
import { HEIGHT_X } from '../state.js';
import { baseHeight } from './nfi.js';

const MIN_CANOPY_M = 0.5;
const MAX_CANOPY_M = 60;

export function emptyEnrich() {
  return {
    canopyHeightM: null,
    canopySampleCount: null,
    canopySource: null, // 'lidar' | 'sample' | null
    elevationM: null,
    slopeDeg: null,
    aspectDeg: null,
    exposure: null,
    terrainSource: null, // 'dtm' | 'sample' | null
    fsiLevel: null,
    fsiSource: null, // 'live' | 'manual' | 'default' | 'sample'
    fsiSquare: null,
    fsiDate: null,
    windthrow: null,
    fire: null,
    nation: null,
    coverageNote: null,
    status: 'idle' // idle | loading | ok | none | error | partial
  };
}

/** Apply measured or estimated extrusion height onto feature properties. */
export function applyExtrusionHeight(feature) {
  const p = feature.properties;
  const h = feature.enrich?.canopyHeightM;
  if (h != null && Number.isFinite(h) && h > 0) {
    p.__h = h * HEIGHT_X;
    p.__hSource = feature.enrich.canopySource === 'sample' ? 'sample' : 'lidar';
  } else {
    p.__h = baseHeight(p.__type) * HEIGHT_X;
    p.__hSource = 'est';
  }
}

/**
 * Sample median canopy height for an England parcel (EA VOM).
 */
export async function sampleCanopyEngland(geometry) {
  const lonlat = samplePointsInPolygon(geometry, 25);
  const bng = lonlat.map(([lon, lat]) => wgs84ToBng(lon, lat));
  const box = clampBngBox(bng, 160, 2);

  const raster = await fetchWcsChip(VOM_WCS, VOM_COVERAGE, box);
  const heights = [];
  for (const [e, n] of bng) {
    if (e < box.eMin || e > box.eMax || n < box.nMin || n > box.nMax) continue;
    const v = raster.sample(e, n);
    if (v != null && v > MIN_CANOPY_M && v < MAX_CANOPY_M) heights.push(v);
  }

  if (heights.length < 3) {
    for (let i = 0; i < raster.values.length; i++) {
      const v = raster.values[i];
      if (Number.isFinite(v) && v > MIN_CANOPY_M && v < MAX_CANOPY_M) heights.push(v);
    }
  }

  const med = median(heights);
  if (med == null) {
    return {
      canopyHeightM: null,
      canopySampleCount: 0,
      canopySource: null,
      status: 'none'
    };
  }

  return {
    canopyHeightM: Math.round(med * 10) / 10,
    canopySampleCount: heights.length,
    canopySource: 'lidar',
    status: 'ok'
  };
}

/** @deprecated use sampleCanopyEngland — kept name for older imports */
export const sampleCanopy = sampleCanopyEngland;
