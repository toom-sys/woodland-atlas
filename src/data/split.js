/**
 * Manual parcel split — cut a loaded NFI (or sample) polygon with a drawn line.
 * Uses polygon-clipping (UMD global) for intersection / difference.
 * Pieces are session-only features; the parent stays in memory but is suppressed from the map.
 */
import { featureHa, groupOf, selectionAgeState, baseHeight } from './nfi.js';
import { emptyEnrich } from './lidar.js';
import { applyCoverProps } from './nation.js';
import { HEIGHT_X } from '../state.js';

const MIN_PIECE_HA = 0.05;

function pcApi() {
  const api = globalThis.polygonClipping;
  if (!api?.intersection || !api?.difference) {
    throw new Error('polygon-clipping unavailable');
  }
  return api;
}

/** GeoJSON Polygon | MultiPolygon → polygon-clipping MultiPolygon. */
export function geomToPc(geom) {
  if (!geom) return null;
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return null;
}

/** polygon-clipping result → GeoJSON geometry (or null if empty). */
export function pcToGeom(pc) {
  if (!pc || !pc.length) return null;
  if (pc.length === 1) return { type: 'Polygon', coordinates: pc[0] };
  return { type: 'MultiPolygon', coordinates: pc };
}

/**
 * Large half-plane polygon on the left of directed segment a→b.
 * padDeg must exceed the parcel extent.
 */
export function leftHalfPlanePolygon(a, b, padDeg) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1e-9;
  const ux = dx / len;
  const uy = dy / len;
  // Left normal in lon/lat plane.
  const nx = -uy;
  const ny = ux;
  const a2 = [a[0] - ux * padDeg, a[1] - uy * padDeg];
  const b2 = [b[0] + ux * padDeg, b[1] + uy * padDeg];
  const b3 = [b2[0] + nx * padDeg, b2[1] + ny * padDeg];
  const a3 = [a2[0] + nx * padDeg, a2[1] + ny * padDeg];
  return {
    type: 'Polygon',
    coordinates: [[a2, b2, b3, a3, a2]]
  };
}

function bboxSpan(geom) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const rings =
    geom.type === 'Polygon'
      ? geom.coordinates
      : geom.type === 'MultiPolygon'
        ? geom.coordinates.flat()
        : [];
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return 0.05;
  return Math.max(maxX - minX, maxY - minY, 0.01);
}

/**
 * Split a feature with an open cut line (≥2 positions [lon,lat]).
 * Uses the first→last segment as the cut (half-plane).
 * @returns {{ pieces: object[], error?: string }}
 */
export function splitFeatureByLine(feature, lineCoords) {
  if (!feature?.geometry) return { pieces: [], error: 'No parcel geometry' };
  if (!lineCoords || lineCoords.length < 2) {
    return { pieces: [], error: 'Draw at least two points for the cut' };
  }

  const a = lineCoords[0];
  const b = lineCoords[lineCoords.length - 1];
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-8) {
    return { pieces: [], error: 'Cut line is too short' };
  }

  let parentPc;
  let leftPc;
  try {
    const api = pcApi();
    parentPc = geomToPc(feature.geometry);
    if (!parentPc) return { pieces: [], error: 'Unsupported geometry' };
    const pad = bboxSpan(feature.geometry) * 4 + 0.05;
    const left = leftHalfPlanePolygon(a, b, pad);
    leftPc = geomToPc(left);
    const partL = api.intersection(parentPc, leftPc);
    const partR = api.difference(parentPc, leftPc);
    const gL = pcToGeom(partL);
    const gR = pcToGeom(partR);
    if (!gL || !gR) {
      return { pieces: [], error: 'Cut must cross the parcel so both sides have area' };
    }

    const parentId = feature.properties?.__id || 'parcel';
    const stamp = Date.now().toString(36);
    const pieces = [gL, gR].map((geom, i) =>
      buildSplitFeature(feature, geom, `${parentId}·${i === 0 ? 'a' : 'b'}·${stamp}`)
    );

    for (const p of pieces) {
      if ((p.properties.__ha || 0) < MIN_PIECE_HA) {
        return {
          pieces: [],
          error: `Each piece must be at least ${MIN_PIECE_HA} ha — adjust the cut`
        };
      }
    }
    return { pieces };
  } catch (err) {
    return { pieces: [], error: err?.message || 'Split failed' };
  }
}

function buildSplitFeature(parent, geometry, id) {
  const typeStr = parent.properties?.__type || 'Woodland';
  const group = parent.properties?.__group || groupOf(typeStr);
  const draft = {
    type: 'Feature',
    geometry,
    properties: {}
  };
  const ha = featureHa(draft);
  draft.properties = {
    __id: id,
    __type: typeStr,
    __group: group,
    __ha: ha,
    __h: (parent.properties?.__h != null
      ? parent.properties.__h
      : baseHeight(typeStr) * HEIGHT_X),
    __country: parent.properties?.__country ?? null,
    __parentId: parent.properties?.__id || null,
    __split: true
  };
  // Fresh enrichment — sample the clipped geometry on select.
  draft.enrich = emptyEnrich();
  if (parent.enrich?.nation) draft.enrich.nation = parent.enrich.nation;
  applyCoverProps(draft, draft.enrich);
  return draft;
}

/** Selection payload for a new split piece, inheriting age from parent selection when present. */
export function selectionForSplitPiece(piece, parentSel) {
  const base = selectionAgeState(piece);
  if (parentSel?.ageLocked || parentSel?.ageSource === 'user') {
    return {
      ...base,
      age: parentSel.age,
      ageSource: 'user',
      ageLocked: true
    };
  }
  if (parentSel?.age) {
    return { ...base, age: parentSel.age, ageSource: parentSel.ageSource || base.ageSource };
  }
  return base;
}
