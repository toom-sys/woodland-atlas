/**
 * Session-only woodland group guide: opaque typed ref + lat/lon centre + area (ha).
 * No third-party location API; no client directory fetch.
 * Guide size is entered in hectares and converted to a circle radius for the map.
 */

import { state, DEFAULT_CLIENT_AREA_HA } from '../state.js';
import { pointInPolygon } from './geo.js';

const EARTH_R = 6371000;
const M2_PER_HA = 10000;

/** Circle radius (m) for a guide area in hectares: A = π r². */
export function haToRadiusM(ha) {
  if (!(ha > 0)) return 0;
  return Math.sqrt((ha * M2_PER_HA) / Math.PI);
}

/** Area in hectares for a circle radius in metres. */
export function radiusMToHa(radiusM) {
  if (!(radiusM > 0)) return 0;
  return (Math.PI * radiusM * radiusM) / M2_PER_HA;
}

/** Derived guide radius from the link's areaHa (fallback to default). */
export function guideRadiusM(link) {
  const ha = link?.areaHa > 0 ? link.areaHa : DEFAULT_CLIENT_AREA_HA;
  return haToRadiusM(ha);
}

/** Normalise / clamp a user hectare count (whole ha). */
export function clampAreaHa(raw) {
  const n = Math.round(+raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 100000);
}

/** Default empty group-guide state. */
export function emptyClientLink() {
  return {
    ref: '',
    center: null, // [lon, lat]
    areaHa: DEFAULT_CLIENT_AREA_HA,
    status: 'idle' // idle | shown | error
  };
}

/** Haversine distance in metres. */
export function haversineM(lon1, lat1, lon2, lat2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Destination point from lon/lat, bearing degrees, distance metres. */
export function destinationPoint(lon, lat, bearingDeg, distM) {
  const δ = distM / EARTH_R;
  const θ = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);
  const φ2 = Math.asin(sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ));
  const λ2 =
    λ1 +
    Math.atan2(Math.sin(θ) * sinδ * cosφ1, cosδ - sinφ1 * Math.sin(φ2));
  return [((λ2 * 180) / Math.PI + 540) % 360 - 180, (φ2 * 180) / Math.PI];
}

/** Approximate circle as a GeoJSON Polygon (lon/lat). */
export function circlePolygon(lon, lat, radiusM, steps = 64) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 360;
    ring.push(destinationPoint(lon, lat, bearing, radiusM));
  }
  return { type: 'Polygon', coordinates: [ring] };
}

/** Bounding box [[west, south], [east, north]] for a circle. */
export function circleBounds(lon, lat, radiusM) {
  const n = destinationPoint(lon, lat, 0, radiusM);
  const e = destinationPoint(lon, lat, 90, radiusM);
  const s = destinationPoint(lon, lat, 180, radiusM);
  const w = destinationPoint(lon, lat, 270, radiusM);
  return [
    [w[0], s[1]],
    [e[0], n[1]]
  ];
}

function forEachCoord(geometry, fn) {
  if (!geometry) return;
  const walk = (coords, depth) => {
    if (!coords?.length) return;
    if (typeof coords[0] === 'number') {
      fn(coords[0], coords[1]);
      return;
    }
    for (const c of coords) walk(c, depth + 1);
  };
  walk(geometry.coordinates, 0);
}

function centroidOf(geometry) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  forEachCoord(geometry, (lon, lat) => {
    sx += lon;
    sy += lat;
    n++;
  });
  if (!n) return null;
  return [sx / n, sy / n];
}

/**
 * True if parcel geometry intersects (touches) a circle.
 * Covers: center in polygon, any vertex in radius, centroid in radius,
 * or any edge closer than radius (local metres).
 */
export function geometryTouchesCircle(geometry, center, radiusM) {
  if (!geometry || !center || !(radiusM > 0)) return false;
  const [clon, clat] = center;

  if (pointInPolygon(clon, clat, geometry)) return true;

  const c = centroidOf(geometry);
  if (c && haversineM(clon, clat, c[0], c[1]) <= radiusM) return true;

  let hit = false;
  forEachCoord(geometry, (lon, lat) => {
    if (hit) return;
    if (haversineM(clon, clat, lon, lat) <= radiusM) hit = true;
  });
  if (hit) return true;

  // Edge proximity in a local equirectangular frame (metres).
  const cosLat = Math.cos((clat * Math.PI) / 180);
  const toXY = (lon, lat) => [
    ((lon - clon) * Math.PI) / 180 * EARTH_R * cosLat,
    ((lat - clat) * Math.PI) / 180 * EARTH_R
  ];
  const r2 = radiusM * radiusM;

  const checkRing = (ring) => {
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = toXY(ring[i][0], ring[i][1]);
      const [x2, y2] = toXY(ring[i + 1][0], ring[i + 1][1]);
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? (-x1 * dx - y1 * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + t * dx;
      const py = y1 + t * dy;
      if (px * px + py * py <= r2) return true;
    }
    return false;
  };

  const polys =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  for (const poly of polys) {
    for (const ring of poly) {
      if (checkRing(ring)) return true;
    }
  }
  return false;
}

/** Parse `lat, lon` or `lon, lat` — GB latitudes are ~49–61, so lat-first if |a| > 20. */
export function parseLatLon(raw) {
  if (!raw) return null;
  const m = String(raw)
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const a = +m[1];
  const b = +m[2];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // Prefer lat,lon when first looks like a GB latitude.
  if (Math.abs(a) >= 20 && Math.abs(a) <= 70 && Math.abs(b) <= 180) {
    return [b, a]; // lon, lat
  }
  if (Math.abs(b) >= 20 && Math.abs(b) <= 70 && Math.abs(a) <= 180) {
    return [a, b];
  }
  // Fallback: lon, lat
  return [a, b];
}

/**
 * Resolve a location string to [lon, lat].
 * Accepts lat/lon paste only.
 */
export async function resolveLocation(raw) {
  const coords = parseLatLon(raw);
  if (coords) {
    return { center: coords, source: 'coords' };
  }
  return {
    error: 'Enter coordinates as lat, lon (for example 54.28, -0.68)'
  };
}

/** Snapshot for exports. */
export function clientLinkExport() {
  const link = state.clientLink;
  if (!link) return null;
  const ref = (link.ref || '').trim();
  if (!ref && !link.center) return null;
  const areaHa = link.areaHa > 0 ? link.areaHa : DEFAULT_CLIENT_AREA_HA;
  const radiusM = haToRadiusM(areaHa);
  return {
    ref: ref || null,
    center: link.center ? [link.center[0], link.center[1]] : null,
    areaHa,
    radiusM: radiusM > 0 ? Math.round(radiusM) : null
  };
}
