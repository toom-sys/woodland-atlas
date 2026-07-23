/**
 * Shared geo helpers for EA WCS sampling (BNG, GeoTIFF, sample grids).
 * Verified endpoints: docs/endpoints.md (2026-07-22).
 */

const A_AIRY = 6377563.396;
const B_AIRY = 6356256.909;
const F0 = 0.9996012717;
const LAT0 = (49 * Math.PI) / 180;
const LON0 = (-2 * Math.PI) / 180;
const N0 = -100000;
const E0 = 400000;

/** Rough England coverage in BNG (VOM envelope from endpoints.md). */
export const ENGLAND_BNG = {
  eMin: 133914,
  eMax: 655654,
  nMin: 11000,
  nMax: 657600
};

/**
 * WGS84 lon/lat → OSGB36 / EPSG:27700 (metres).
 * Direct Airy projection of WGS84 coords — metre-level error, fine for median canopy chips.
 */
export function wgs84ToBng(lon, lat) {
  const φ = (lat * Math.PI) / 180;
  const λ = (lon * Math.PI) / 180;
  const a = A_AIRY;
  const b = B_AIRY;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const sinφ = Math.sin(φ);
  const cosφ = Math.cos(φ);
  const tanφ = Math.tan(φ);
  const ν = (a * F0) / Math.sqrt(1 - e2 * sinφ * sinφ);
  const ρ = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sinφ * sinφ, 1.5);
  const η2 = ν / ρ - 1;
  const M =
    b *
    F0 *
    ((1 + n + (5 / 4) * n * n + (5 / 4) * n ** 3) * (φ - LAT0) -
      (3 * n + 3 * n * n + (21 / 8) * n ** 3) * Math.sin(φ - LAT0) * Math.cos(φ + LAT0) +
      ((15 / 8) * n * n + (15 / 8) * n ** 3) * Math.sin(2 * (φ - LAT0)) * Math.cos(2 * (φ + LAT0)) -
      (35 / 24) * n ** 3 * Math.sin(3 * (φ - LAT0)) * Math.cos(3 * (φ + LAT0)));
  const I = M + N0;
  const II = (ν / 2) * sinφ * cosφ;
  const III = (ν / 24) * sinφ * cosφ ** 3 * (5 - tanφ ** 2 + 9 * η2);
  const IIIA = (ν / 720) * sinφ * cosφ ** 5 * (61 - 58 * tanφ ** 2 + tanφ ** 4);
  const IV = ν * cosφ;
  const V = (ν / 6) * cosφ ** 3 * (ν / ρ - tanφ ** 2);
  const VI =
    (ν / 120) * cosφ ** 5 * (5 - 18 * tanφ ** 2 + tanφ ** 4 + 14 * η2 - 58 * tanφ ** 2 * η2);
  const dλ = λ - LON0;
  const N = I + II * dλ ** 2 + III * dλ ** 4 + IIIA * dλ ** 6;
  const E = E0 + IV * dλ + V * dλ ** 3 + VI * dλ ** 5;
  return [E, N];
}

export function inEnglandBng(e, n) {
  return (
    e >= ENGLAND_BNG.eMin &&
    e <= ENGLAND_BNG.eMax &&
    n >= ENGLAND_BNG.nMin &&
    n <= ENGLAND_BNG.nMax
  );
}

export function withTimeout(promise, ms, message = 'timeout') {
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

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi === yj) continue;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Lon/lat point-in-polygon for Polygon / MultiPolygon. */
export function pointInPolygon(lon, lat, geometry) {
  if (!geometry) return false;
  const polys =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  for (const poly of polys) {
    if (!poly.length) continue;
    if (!pointInRing(lon, lat, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(lon, lat, poly[h])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

export function featureCentroid(geometry) {
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
    const ring = poly[0];
    for (let i = 0; i < ring.length - 1; i++) {
      sx += ring[i][0];
      sy += ring[i][1];
      n++;
    }
  }
  if (!n) return [0, 0];
  return [sx / n, sy / n];
}

/**
 * Centroid + grid clipped to polygon, capped at maxPoints (SPEC ≤25).
 * Returns lon/lat positions.
 */
export function samplePointsInPolygon(geometry, maxPoints = 25) {
  const [cx, cy] = featureCentroid(geometry);
  const pts = [];
  if (pointInPolygon(cx, cy, geometry)) pts.push([cx, cy]);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const polys =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  for (const poly of polys) {
    for (const [x, y] of poly[0]) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return pts.length ? pts : [[cx, cy]];

  const span = Math.max(maxX - minX, maxY - minY);
  // Prefer denser grids on larger parcels; always leave room for the centroid.
  const side = span < 0.001 ? 3 : span < 0.004 ? 4 : 5;
  const candidates = [];
  for (let iy = 0; iy < side; iy++) {
    for (let ix = 0; ix < side; ix++) {
      const x = minX + ((ix + 0.5) / side) * (maxX - minX);
      const y = minY + ((iy + 0.5) / side) * (maxY - minY);
      if (Math.hypot(x - cx, y - cy) < 1e-9) continue;
      if (pointInPolygon(x, y, geometry)) candidates.push([x, y]);
    }
  }
  // Prefer points nearer the centroid when we must thin.
  candidates.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  for (const p of candidates) {
    if (pts.length >= maxPoints) break;
    pts.push(p);
  }
  if (!pts.length) pts.push([cx, cy]);
  return pts.slice(0, maxPoints);
}

export function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Minimal reader for Defra WCS GeoTIFFs: classic TIFF, uncompressed Float32, tiled or striped.
 * Returns { width, height, values: Float32Array (row-major), worldToPixel(e,n), nodata }.
 */
export function parseFloatGeoTiff(buffer) {
  const data = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const le = data[0] === 0x49 && data[1] === 0x49;
  const u16 = (o) => view.getUint16(o, le);
  const u32 = (o) => view.getUint32(o, le);
  if (u16(2) !== 42) throw new Error('not classic TIFF');

  const ifd = u32(4);
  const nTags = u16(ifd);
  const tags = new Map();
  for (let i = 0; i < nTags; i++) {
    const o = ifd + 2 + i * 12;
    const tag = u16(o);
    const typ = u16(o + 2);
    const count = u32(o + 4);
    const valOff = u32(o + 8);
    tags.set(tag, { typ, count, valOff, entry: o });
  }

  const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 };

  function readValues(tag) {
    const t = tags.get(tag);
    if (!t) return null;
    const size = (typeSize[t.typ] || 4) * t.count;
    let start;
    if (size <= 4) start = t.entry + 8;
    else start = t.valOff;
    const out = [];
    for (let i = 0; i < t.count; i++) {
      const o = start + i * (typeSize[t.typ] || 4);
      if (t.typ === 3) out.push(view.getUint16(o, le));
      else if (t.typ === 4) out.push(view.getUint32(o, le));
      else if (t.typ === 11) out.push(view.getFloat32(o, le));
      else if (t.typ === 12) out.push(view.getFloat64(o, le));
      else if (t.typ === 2) out.push(view.getUint8(o));
    }
    return out;
  }

  const width = readValues(256)[0];
  const height = readValues(257)[0];
  const bps = readValues(258)[0];
  const sampleFormat = (readValues(339) || [1])[0];
  if (bps !== 32 || sampleFormat !== 3) throw new Error('expected Float32 GeoTIFF');

  const tileW = readValues(322)?.[0];
  const tileH = readValues(323)?.[0];
  const values = new Float32Array(width * height);

  if (tileW && tileH) {
    const offsets = readValues(324);
    const counts = readValues(325);
    const tilesX = Math.ceil(width / tileW);
    const tilesY = Math.ceil(height / tileH);
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const i = ty * tilesX + tx;
        const off = offsets[i];
        const cnt = counts[i];
        const nFloats = cnt / 4;
        for (let p = 0; p < nFloats; p++) {
          const col = tx * tileW + (p % tileW);
          const row = ty * tileH + Math.floor(p / tileW);
          if (col >= width || row >= height) continue;
          values[row * width + col] = view.getFloat32(off + p * 4, le);
        }
      }
    }
  } else {
    const offsets = readValues(273);
    const counts = readValues(279);
    const rowsPerStrip = (readValues(278) || [height])[0];
    let row0 = 0;
    for (let s = 0; s < offsets.length; s++) {
      const off = offsets[s];
      const nFloats = counts[s] / 4;
      for (let p = 0; p < nFloats; p++) {
        const col = p % width;
        const row = row0 + Math.floor(p / width);
        if (row >= height) break;
        values[row * width + col] = view.getFloat32(off + p * 4, le);
      }
      row0 += rowsPerStrip;
    }
  }

  const transform = readValues(34264); // ModelTransformationTag 4×4 row-major
  let originE = 0;
  let originN = 0;
  let pixE = 1;
  let pixN = -1;
  if (transform && transform.length >= 16) {
    // E = m00*col + m01*row + m03; N = m10*col + m11*row + m13
    pixE = transform[0];
    const m01 = transform[1];
    originE = transform[3];
    const m10 = transform[4];
    pixN = transform[5];
    originN = transform[7];
    void m01;
    void m10;
  } else {
    const scale = readValues(33550); // ModelPixelScale
    const tie = readValues(33922); // ModelTiepoint
    if (scale && tie) {
      pixE = scale[0];
      pixN = -Math.abs(scale[1]);
      originE = tie[3];
      originN = tie[4];
    }
  }

  let nodata = -3.4028234663852886e38;
  const gdal = readValues(42113);
  if (gdal) {
    const str = String.fromCharCode(...gdal.filter((c) => c)).replace(/\0/g, '').trim();
    const n = Number(str);
    if (Number.isFinite(n)) nodata = n;
  }

  function worldToPixel(e, n) {
    const col = Math.floor((e - originE) / pixE);
    const row = Math.floor((n - originN) / pixN);
    return [col, row];
  }

  function sample(e, n) {
    const [col, row] = worldToPixel(e, n);
    if (col < 0 || row < 0 || col >= width || row >= height) return null;
    const v = values[row * width + col];
    if (!Number.isFinite(v) || v <= nodata * 0.5 || v < -1e30) return null;
    return v;
  }

  return { width, height, values, originE, originN, pixE, pixN, nodata, worldToPixel, sample };
}

/** Verified 2026-07-22 — see docs/endpoints.md */
export const VOM_WCS = 'https://environment.data.gov.uk/spatialdata/vegetation-object-model/wcs';
export const VOM_COVERAGE =
  'ecae3bef-1e1d-4051-887b-9dc613c928ec__Vegetation_Object_Model_Elevation_2022';
export const DTM_WCS =
  'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs';
export const DTM_COVERAGE =
  '13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m';

const WCS_TIMEOUT_MS = 9000;

/**
 * Fetch a small BNG chip as Float32 GeoTIFF and parse it.
 * @param {string} endpoint WCS URL
 * @param {string} coverageId
 * @param {{eMin:number,eMax:number,nMin:number,nMax:number}} box
 */
export async function fetchWcsChip(endpoint, coverageId, box) {
  const e0 = Math.floor(box.eMin);
  const e1 = Math.ceil(box.eMax);
  const n0 = Math.floor(box.nMin);
  const n1 = Math.ceil(box.nMax);
  if (e1 <= e0 || n1 <= n0) throw new Error('empty WCS subset');

  const params = new URLSearchParams();
  params.set('service', 'WCS');
  params.set('version', '2.0.1');
  params.set('request', 'GetCoverage');
  params.set('CoverageId', coverageId);
  // URLSearchParams collapses duplicate keys — build manually for two subset= params.
  const qs =
    params.toString() +
    `&subset=${encodeURIComponent(`E(${e0},${e1})`)}` +
    `&subset=${encodeURIComponent(`N(${n0},${n1})`)}` +
    `&format=${encodeURIComponent('image/tiff')}`;

  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), WCS_TIMEOUT_MS);
  try {
    const res = await withTimeout(
      fetch(`${endpoint}?${qs}`, { signal: ctl.signal }),
      WCS_TIMEOUT_MS,
      'WCS timeout'
    );
    if (!res.ok) throw new Error(`WCS HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    // XML exception reports are small text; GeoTIFF starts II* or MM*
    const head = new Uint8Array(buf.slice(0, 4));
    const isTiff =
      (head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d);
    if (!isTiff) throw new Error('WCS did not return TIFF');
    return parseFloatGeoTiff(buf);
  } finally {
    clearTimeout(to);
  }
}

/** Clamp a BNG point set's bbox to maxSpan metres, centred on the set. */
export function clampBngBox(points, maxSpan = 160, pad = 2) {
  let eMin = Infinity;
  let eMax = -Infinity;
  let nMin = Infinity;
  let nMax = -Infinity;
  for (const [e, n] of points) {
    if (e < eMin) eMin = e;
    if (e > eMax) eMax = e;
    if (n < nMin) nMin = n;
    if (n > nMax) nMax = n;
  }
  let ce = (eMin + eMax) / 2;
  let cn = (nMin + nMax) / 2;
  let halfE = Math.max((eMax - eMin) / 2 + pad, pad + 1);
  let halfN = Math.max((nMax - nMin) / 2 + pad, pad + 1);
  if (halfE * 2 > maxSpan) halfE = maxSpan / 2;
  if (halfN * 2 > maxSpan) halfN = maxSpan / 2;
  return {
    eMin: ce - halfE,
    eMax: ce + halfE,
    nMin: cn - halfN,
    nMax: cn + halfN
  };
}
