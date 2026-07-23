/**
 * EA Composite DTM terrain attributes via WCS GetCoverage (England).
 * Derives elevation, slope, aspect, and a cheap topex-style exposure proxy (SPEC §3.4).
 * This is explicitly a proxy for DAMS/topex — not the real ForestGALES exposure metric.
 */
import {
  DTM_WCS,
  DTM_COVERAGE,
  wgs84ToBng,
  samplePointsInPolygon,
  clampBngBox,
  fetchWcsChip,
  median
} from './geo.js';

const RING_DIST_M = 250;
const EXPOSURE_NORM_M = 50; // SPEC: normalise proudness over ~50 m

/**
 * @returns {{
 *   elevationM: number|null,
 *   slopeDeg: number|null,
 *   aspectDeg: number|null,
 *   exposure: number|null,
 *   terrainSource: 'dtm'|null,
 *   status: 'ok'|'none'|'error'
 * }}
 */
export async function sampleTerrainEngland(geometry) {
  const lonlat = samplePointsInPolygon(geometry, 25);
  const bng = lonlat.map(([lon, lat]) => wgs84ToBng(lon, lat));
  const box = clampBngBox(bng, 160, 2);

  const raster = await fetchWcsChip(DTM_WCS, DTM_COVERAGE, box);
  const samples = [];
  for (const [e, n] of bng) {
    if (e < box.eMin || e > box.eMax || n < box.nMin || n > box.nMax) continue;
    const z = raster.sample(e, n);
    if (z != null && z > -100 && z < 2000) samples.push({ e, n, z });
  }

  if (samples.length < 3) {
    // Chip-wide fallback — use a coarse grid of pixel centres.
    const step = Math.max(1, Math.floor(Math.min(raster.width, raster.height) / 5));
    for (let row = step >> 1; row < raster.height; row += step) {
      for (let col = step >> 1; col < raster.width; col += step) {
        const z = raster.values[row * raster.width + col];
        if (!Number.isFinite(z) || z < -100 || z > 2000) continue;
        const e = raster.originE + (col + 0.5) * raster.pixE;
        const n = raster.originN + (row + 0.5) * raster.pixN;
        samples.push({ e, n, z });
      }
    }
  }

  if (!samples.length) {
    return {
      elevationM: null,
      slopeDeg: null,
      aspectDeg: null,
      exposure: null,
      terrainSource: null,
      status: 'none'
    };
  }

  const elevationM = median(samples.map((s) => s.z));
  const { slopeDeg, aspectDeg } = planeFitSlopeAspect(samples);

  let exposure = null;
  try {
    exposure = await sampleExposureProxy(ce, cn, elevationM);
  } catch {
    exposure = null;
  }

  return {
    elevationM: elevationM != null ? Math.round(elevationM * 10) / 10 : null,
    slopeDeg: slopeDeg != null ? Math.round(slopeDeg * 10) / 10 : null,
    aspectDeg: aspectDeg != null ? Math.round(aspectDeg) : null,
    exposure: exposure != null ? Math.round(exposure * 100) / 100 : null,
    terrainSource: 'dtm',
    status: 'ok'
  };
}

/** Least-squares plane z = ae + bn + c → slope & aspect. */
function planeFitSlopeAspect(samples) {
  // Solve normal equations for [a,b,c]
  let Σe = 0;
  let Σn = 0;
  let Σz = 0;
  let Σee = 0;
  let Σnn = 0;
  let Σen = 0;
  let Σez = 0;
  let Σnz = 0;
  const N = samples.length;
  for (const s of samples) {
    Σe += s.e;
    Σn += s.n;
    Σz += s.z;
    Σee += s.e * s.e;
    Σnn += s.n * s.n;
    Σen += s.e * s.n;
    Σez += s.e * s.z;
    Σnz += s.n * s.z;
  }
  // Use centred coords for numerical stability
  const e0 = Σe / N;
  const n0 = Σn / N;
  const z0 = Σz / N;
  let Sce = 0;
  let Scn = 0;
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
  if (Math.abs(det) < 1e-9) {
    return { slopeDeg: 0, aspectDeg: null };
  }
  const a = (Scez * Scnn - Scnz * Scen) / det; // dz/de
  const b = (Scnz * Scee - Scez * Scen) / det; // dz/dn
  void Sce;
  void Scn;

  const slopeRad = Math.atan(Math.hypot(a, b));
  const slopeDeg = (slopeRad * 180) / Math.PI;
  // Aspect: direction of steepest descent, degrees clockwise from north.
  // Gradient points upslope; downslope azimuth = atan2(a, b) then +180.
  let aspect = (Math.atan2(a, b) * 180) / Math.PI; // from north toward east for upslope
  aspect = (aspect + 180 + 360) % 360; // downslope
  return { slopeDeg, aspectDeg: aspect };
}

/**
 * Topex-style proxy: mean of max(0, elev_parcel − elev_ring) / 50 m, clamped 0–1.
 * Eight ring points at ~250 m in BNG space.
 */
async function sampleExposureProxy(ce, cn, elevParcel) {
  if (elevParcel == null) return null;
  const bearings = [0, 45, 90, 135, 180, 225, 270, 315];
  const jobs = bearings.map(async (deg) => {
    const rad = (deg * Math.PI) / 180;
    // BNG: E east, N north
    const e = ce + Math.sin(rad) * RING_DIST_M;
    const n = cn + Math.cos(rad) * RING_DIST_M;
    if (!inEnglandBng(e, n)) return null;
    const box = {
      eMin: e - 3,
      eMax: e + 3,
      nMin: n - 3,
      nMax: n + 3
    };
    const raster = await fetchWcsChip(DTM_WCS, DTM_COVERAGE, box);
    return raster.sample(e, n);
  });

  const ringZ = await Promise.all(jobs);
  const diffs = [];
  for (const z of ringZ) {
    if (z == null || !Number.isFinite(z)) continue;
    diffs.push(Math.max(0, elevParcel - z));
  }
  if (!diffs.length) return null;
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  return Math.max(0, Math.min(1, mean / EXPOSURE_NORM_M));
}

export const sampleTerrain = sampleTerrainEngland;
