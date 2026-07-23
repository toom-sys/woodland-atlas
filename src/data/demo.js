import { SAMPLE, HEIGHT_X } from '../state.js';
import { featureHa, groupOf, baseHeight } from './nfi.js';
import { emptyEnrich, applyExtrusionHeight } from './lidar.js';
import { applyCoverProps } from './nation.js';

/** Plausible fixed enrichment so risk/height UI works offline (SPEC §3.2). */
function sampleEnrich(type, rnd) {
  const t = type.toLowerCase();
  let canopy = 14 + rnd() * 10;
  if (t.includes('young')) canopy = 3 + rnd() * 4;
  else if (t.includes('felled')) canopy = 0.8 + rnd() * 1.2;
  else if (t.includes('broadlea')) canopy = 12 + rnd() * 8;
  else if (t.includes('conifer')) canopy = 16 + rnd() * 12;
  const e = emptyEnrich();
  e.canopyHeightM = Math.round(canopy * 10) / 10;
  e.canopySampleCount = 0;
  e.canopySource = 'sample';
  e.elevationM = Math.round(180 + rnd() * 120);
  e.slopeDeg = Math.round((3 + rnd() * 18) * 10) / 10;
  e.aspectDeg = Math.round(rnd() * 360);
  e.exposure = Math.round((0.15 + rnd() * 0.55) * 100) / 100;
  e.terrainSource = 'sample';
  e.fsiLevel = 2 + Math.floor(rnd() * 2); // 2 or 3
  e.fsiSource = 'sample';
  e.fsiSquare = null;
  e.fsiDate = null;
  e.status = 'ok';
  return e;
}

/** Procedural sample parcels (seeded PRNG). Always available as offline fallback. */
export function demoData() {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const types = [
    'Conifer',
    'Conifer',
    'Broadleaved',
    'Broadleaved',
    'Mixed mainly conifer',
    'Mixed mainly broadleaved',
    'Young trees',
    'Conifer',
    'Broadleaved',
    'Felled',
    'Conifer',
    'Mixed mainly broadleaved',
    'Broadleaved',
    'Conifer'
  ];
  const feats = [];
  const [cx, cy] = SAMPLE.center;
  for (let i = 0; i < types.length; i++) {
    const ang = rnd() * Math.PI * 2;
    const dist = 0.004 + rnd() * 0.02;
    const px = cx + Math.cos(ang) * dist * 1.6;
    const py = cy + Math.sin(ang) * dist;
    const r = (90 + rnd() * 320) / 111320;
    const n = 9 + Math.floor(rnd() * 5);
    const ring = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const rr = r * (0.65 + rnd() * 0.6);
      ring.push([px + (Math.cos(a) * rr) / Math.cos((py * Math.PI) / 180), py + Math.sin(a) * rr]);
    }
    ring.push(ring[0]);
    const f = {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {}
    };
    const id = 'demo-' + i;
    const type = types[i];
    f.properties = {
      __id: id,
      __type: type + ' (sample)',
      __group: groupOf(type),
      __ha: featureHa(f),
      __h: baseHeight(type) * HEIGHT_X
    };
    f.enrich = sampleEnrich(type, rnd);
    f.enrich.nation = 'sample';
    applyExtrusionHeight(f);
    applyCoverProps(f, f.enrich);
    feats.push(f);
  }
  return feats;
}

export function loadDemo(features) {
  for (const f of demoData()) features.set(f.properties.__id, f);
}
