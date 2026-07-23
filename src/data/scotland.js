/**
 * Scotland LiDAR sampling via Scottish Remote Sensing Portal open data on AWS S3.
 * National Land LiDAR Programme 1 km DTM/DSM tiles (OGL). CORS allows browser Range reads.
 * Canopy height = DSM − DTM (no VOM equivalent). Verified 2026-07-22 — see docs/endpoints.md.
 */
import { fromUrl } from '../../vendor/geotiff/geotiff.js';
import {
  wgs84ToBng,
  samplePointsInPolygon,
  featureCentroid,
  median,
  withTimeout
} from './geo.js';
import { bngToOs1km } from './nation.js';

const S3 = 'https://srsp-open-data.s3.eu-west-2.amazonaws.com';
const FETCH_MS = 12000;
const MIN_CANOPY_M = 0.5;
const MAX_CANOPY_M = 60;

/** @type {Map<string, Promise<{dsm:any, dtm:any}|null>>} */
const tileJobs = new Map();

function nlpUrls(tileId) {
  return {
    dsm: `${S3}/lidar/national-lidar-programme/dsm/27700/gridded/${tileId}_50cm_DSM_ScotlandNationalLiDAR.tif`,
    dtm: `${S3}/lidar/national-lidar-programme/dtm/27700/gridded/${tileId}_50cm_DTM_ScotlandNationalLiDAR.tif`
  };
}

async function headOk(url) {
  try {
    const res = await withTimeout(fetch(url, { method: 'HEAD' }), 6000, 'HEAD timeout');
    return res.ok;
  } catch {
    return false;
  }
}

async function loadNlpTile(tileId) {
  if (tileJobs.has(tileId)) return tileJobs.get(tileId);
  const job = (async () => {
    const { dsm, dtm } = nlpUrls(tileId);
    const [dsmOk, dtmOk] = await Promise.all([headOk(dsm), headOk(dtm)]);
    if (!dsmOk && !dtmOk) return null;
    const [dsmTiff, dtmTiff] = await Promise.all([
      dsmOk ? fromUrl(dsm) : null,
      dtmOk ? fromUrl(dtm) : null
    ]);
    const [dsmImg, dtmImg] = await Promise.all([
      dsmTiff ? dsmTiff.getImage() : null,
      dtmTiff ? dtmTiff.getImage() : null
    ]);
    return { dsm: dsmImg, dtm: dtmImg };
  })();
  tileJobs.set(tileId, job);
  try {
    return await job;
  } catch (err) {
    tileJobs.delete(tileId);
    throw err;
  }
}

function pixelAt(img, e, n) {
  if (!img) return null;
  const bbox = img.getBoundingBox(); // minX, minY, maxX, maxY in BNG
  const w = img.getWidth();
  const h = img.getHeight();
  const resX = (bbox[2] - bbox[0]) / w;
  const resY = (bbox[3] - bbox[1]) / h;
  const col = Math.floor((e - bbox[0]) / resX);
  const row = Math.floor((bbox[3] - n) / resY);
  if (col < 0 || row < 0 || col >= w || row >= h) return null;
  return { col, row, w, h };
}

/** Read many BNG points with a single raster window fetch. */
async function readPoints(img, bngPoints) {
  const pixels = bngPoints.map(([e, n]) => pixelAt(img, e, n));
  const valid = pixels.filter(Boolean);
  if (!valid.length) return bngPoints.map(() => null);

  let minC = Infinity;
  let minR = Infinity;
  let maxC = -Infinity;
  let maxR = -Infinity;
  for (const p of valid) {
    if (p.col < minC) minC = p.col;
    if (p.row < minR) minR = p.row;
    if (p.col > maxC) maxC = p.col;
    if (p.row > maxR) maxR = p.row;
  }
  minC = Math.max(0, minC - 1);
  minR = Math.max(0, minR - 1);
  maxC = Math.min(img.getWidth() - 1, maxC + 1);
  maxR = Math.min(img.getHeight() - 1, maxR + 1);

  const spanC = maxC - minC;
  const spanR = maxR - minR;
  // Large windows are slow to LZW-decode; fall back to per-point reads.
  if (spanC > 250 || spanR > 250 || valid.length <= 4) {
    const out = [];
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i];
      if (!p) {
        out.push(null);
        continue;
      }
      const data = await img.readRasters({
        window: [p.col, p.row, p.col + 1, p.row + 1],
        interleave: true
      });
      const z = data[0];
      out.push(Number.isFinite(z) && z > -100 && z < 2000 ? z : null);
    }
    return out;
  }

  const width = maxC - minC + 1;
  const data = await img.readRasters({
    window: [minC, minR, maxC + 1, maxR + 1],
    interleave: true
  });

  return pixels.map((p) => {
    if (!p) return null;
    const z = data[(p.row - minR) * width + (p.col - minC)];
    if (!Number.isFinite(z) || z <= -100 || z > 2000) return null;
    return z;
  });
}

async function readZ(img, e, n) {
  const pts = await readPoints(img, [[e, n]]);
  return pts[0];
}

/**
 * Sample Scotland NLP tiles for canopy (DSM−DTM) and/or terrain (DTM).
 * @returns {{
 *   canopyHeightM: number|null,
 *   canopySampleCount: number,
 *   canopySource: 'lidar'|null,
 *   elevationM: number|null,
 *   slopeDeg: number|null,
 *   aspectDeg: number|null,
 *   exposure: number|null,
 *   terrainSource: 'dtm'|null,
 *   status: 'ok'|'none'|'partial'|'error',
 *   tileId: string|null
 * }}
 */
export async function sampleScotland(geometry) {
  const [clon, clat] = featureCentroid(geometry);
  const [ce, cn] = wgs84ToBng(clon, clat);
  const tileId = bngToOs1km(ce, cn);
  if (!tileId) {
    return emptyResult('none');
  }

  const tile = await withTimeout(loadNlpTile(tileId), FETCH_MS, 'Scotland LiDAR timeout');
  if (!tile) return emptyResult('none', tileId);

  const lonlat = samplePointsInPolygon(geometry, 25);
  const bng = lonlat.map(([lon, lat]) => wgs84ToBng(lon, lat));

  // One windowed read per raster covering all in-tile sample points (faster than N round-trips).
  const dsmGrid = tile.dsm ? await readPoints(tile.dsm, bng) : null;
  const dtmGrid = tile.dtm ? await readPoints(tile.dtm, bng) : null;

  const canopyVals = [];
  const elevSamples = [];

  for (let i = 0; i < bng.length; i++) {
    const [e, n] = bng[i];
    const zDtm = dtmGrid ? dtmGrid[i] : null;
    const zDsm = dsmGrid ? dsmGrid[i] : null;
    if (zDtm != null) elevSamples.push({ e, n, z: zDtm });
    if (zDsm != null && zDtm != null) {
      const h = zDsm - zDtm;
      if (h > MIN_CANOPY_M && h < MAX_CANOPY_M) canopyVals.push(h);
    }
  }

  const canopyMed = median(canopyVals);
  const elevMed = median(elevSamples.map((s) => s.z));
  let slopeDeg = null;
  let aspectDeg = null;
  if (elevSamples.length >= 3) {
    const fit = planeFitSlopeAspect(elevSamples);
    slopeDeg = fit.slopeDeg;
    aspectDeg = fit.aspectDeg;
  }

  // Cheap exposure: 4 cardinal DTM samples at 250 m when DTM present
  let exposure = null;
  if (elevMed != null && tile.dtm) {
    try {
      exposure = await exposureProxy(tile.dtm, ce, cn, elevMed);
    } catch {
      exposure = null;
    }
  }

  const hasCanopy = canopyMed != null;
  const hasTerrain = elevMed != null;
  let status = 'none';
  if (hasCanopy && hasTerrain) status = 'ok';
  else if (hasTerrain || hasCanopy) status = 'partial';

  return {
    canopyHeightM: hasCanopy ? Math.round(canopyMed * 10) / 10 : null,
    canopySampleCount: canopyVals.length,
    canopySource: hasCanopy ? 'lidar' : null,
    elevationM: hasTerrain ? Math.round(elevMed * 10) / 10 : null,
    slopeDeg: slopeDeg != null ? Math.round(slopeDeg * 10) / 10 : null,
    aspectDeg: aspectDeg != null ? Math.round(aspectDeg) : null,
    exposure: exposure != null ? Math.round(exposure * 100) / 100 : null,
    terrainSource: hasTerrain ? 'dtm' : null,
    status,
    tileId
  };
}

function emptyResult(status, tileId = null) {
  return {
    canopyHeightM: null,
    canopySampleCount: 0,
    canopySource: null,
    elevationM: null,
    slopeDeg: null,
    aspectDeg: null,
    exposure: null,
    terrainSource: null,
    status,
    tileId
  };
}

async function exposureProxy(dtmImg, ce, cn, elevParcel) {
  const bearings = [0, 90, 180, 270];
  const diffs = [];
  for (const deg of bearings) {
    const rad = (deg * Math.PI) / 180;
    const e = ce + Math.sin(rad) * 250;
    const n = cn + Math.cos(rad) * 250;
    const z = await readZ(dtmImg, e, n);
    if (z == null) continue;
    diffs.push(Math.max(0, elevParcel - z));
  }
  if (!diffs.length) return null;
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  return Math.max(0, Math.min(1, mean / 50));
}

function planeFitSlopeAspect(samples) {
  const N = samples.length;
  const e0 = samples.reduce((a, s) => a + s.e, 0) / N;
  const n0 = samples.reduce((a, s) => a + s.n, 0) / N;
  const z0 = samples.reduce((a, s) => a + s.z, 0) / N;
  let Scee = 0;
  let Scnn = 0;
  let Scen = 0;
  let Scez = 0;
  let Scnz = 0;
  for (const s of samples) {
    const ce = s.e - e0;
    const cn = s.n - n0;
    const cz = s.z - z0;
    Scee += ce * ce;
    Scnn += cn * cn;
    Scen += ce * cn;
    Scez += ce * cz;
    Scnz += cn * cz;
  }
  const det = Scee * Scnn - Scen * Scen;
  if (Math.abs(det) < 1e-9) return { slopeDeg: 0, aspectDeg: null };
  const a = (Scez * Scnn - Scnz * Scen) / det;
  const b = (Scnz * Scee - Scez * Scen) / det;
  const slopeDeg = (Math.atan(Math.hypot(a, b)) * 180) / Math.PI;
  let aspect = (Math.atan2(a, b) * 180) / Math.PI;
  aspect = (aspect + 180 + 360) % 360;
  return { slopeDeg, aspectDeg: aspect };
}
