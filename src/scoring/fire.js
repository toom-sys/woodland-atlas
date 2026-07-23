/**
 * Fire susceptibility score blended with dynamic FSI (SPEC §4.2).
 * Transparent 0–100 composite. All weights and ramps come from assumptions
 * state — no magic numbers in the scoring path.
 */
import { state, DEFAULT_FIRE } from '../state.js';
import { defaultAge } from '../data/nfi.js';
import { bandOf } from './windthrow.js';
import { resolveFsi } from '../data/fsi.js';

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function ramp(value, floor, ceil) {
  if (value == null || !Number.isFinite(value)) return null;
  if (ceil <= floor) return value >= ceil ? 1 : 0;
  return clamp01((value - floor) / (ceil - floor));
}

/**
 * Fuel-type contribution from group + raw type string.
 * Young plantation and felled override the base group table.
 */
function fuelContrib(feature, cfg) {
  const type = (feature.properties.__type || '').toLowerCase();
  const group = feature.properties.__group || 'other';
  const fuel = cfg.fuel || DEFAULT_FIRE.fuel;
  if (/young|ground prep|shrub/.test(type)) {
    return { value: clamp01(fuel.young), provenance: 'type' };
  }
  if (/fell|windblow|coppice/.test(type)) {
    return { value: clamp01(fuel.felled), provenance: 'type' };
  }
  const v = fuel[group] ?? fuel.other ?? DEFAULT_FIRE.fuel.other;
  return { value: clamp01(v), provenance: 'type' };
}

/**
 * Slope & aspect: south-ish aspect up to aspectMax + slope ramp.
 * No DTM → defaultSlopeAspect, flagged assumed.
 */
function slopeAspectContrib(en, cfg) {
  const hasTerrain =
    (en.slopeDeg != null && Number.isFinite(en.slopeDeg)) ||
    (en.aspectDeg != null && Number.isFinite(en.aspectDeg));

  if (!hasTerrain) {
    return {
      value: clamp01(cfg.defaultSlopeAspect ?? DEFAULT_FIRE.defaultSlopeAspect),
      provenance: 'assumed'
    };
  }

  const aspect = en.aspectDeg;
  let aspectPart = 0;
  if (aspect != null && Number.isFinite(aspect)) {
    const a = ((aspect % 360) + 360) % 360;
    const southMin = cfg.southAspectMin ?? DEFAULT_FIRE.southAspectMin;
    const southMax = cfg.southAspectMax ?? DEFAULT_FIRE.southAspectMax;
    if (a >= southMin && a <= southMax) {
      const mid = (southMin + southMax) / 2;
      const half = (southMax - southMin) / 2 || 1;
      aspectPart = (cfg.aspectMax ?? DEFAULT_FIRE.aspectMax) * (1 - Math.abs(a - mid) / half);
    }
  }

  const slopeR = ramp(
    en.slopeDeg ?? 0,
    cfg.slopeFloorDeg ?? DEFAULT_FIRE.slopeFloorDeg,
    cfg.slopeCeilDeg ?? DEFAULT_FIRE.slopeCeilDeg
  );
  const slopePart = (cfg.slopeMax ?? DEFAULT_FIRE.slopeMax) * (slopeR == null ? 0 : slopeR);

  const terrainProv =
    en.terrainSource === 'dtm'
      ? 'dtm'
      : en.terrainSource === 'sample'
        ? 'sample'
        : 'estimated';

  return { value: clamp01(aspectPart + slopePart), provenance: terrainProv };
}

/**
 * Contiguous fuel-bed size: log ramp from haFloor→contribFloor to haCeil→contribCeil.
 */
function continuityContrib(ha, cfg) {
  const h = Number.isFinite(ha) && ha > 0 ? ha : 1;
  const loH = Math.log10(cfg.haFloor ?? DEFAULT_FIRE.haFloor);
  const hiH = Math.log10(cfg.haCeil ?? DEFAULT_FIRE.haCeil);
  const loC = cfg.haContribFloor ?? DEFAULT_FIRE.haContribFloor;
  const hiC = cfg.haContribCeil ?? DEFAULT_FIRE.haContribCeil;
  const t = hiH <= loH ? 1 : clamp01((Math.log10(h) - loH) / (hiH - loH));
  return { value: clamp01(loC + t * (hiC - loC)), provenance: 'parcel' };
}

/** Read FSI from enrich stamp, or fall back to manual/default. */
function fsiFromEnrich(en) {
  if (en.fsiLevel != null && Number.isFinite(en.fsiLevel) && en.fsiSource) {
    return {
      level: en.fsiLevel,
      source: en.fsiSource,
      square: en.fsiSquare ?? null,
      date: en.fsiDate ?? null
    };
  }
  return resolveFsi(null);
}

/**
 * Score one parcel. Pure — reads feature + fire assumptions + enrich FSI stamp.
 * @returns {{score, band, components, inputsUsed, fsi, pending}|null}
 */
export function scoreFire(feature, age, fireCfg) {
  if (!feature) return null;
  const cfg = fireCfg || state.rates.fire || DEFAULT_FIRE;
  const en = feature.enrich || {};
  const ageKey = age || defaultAge(feature.properties.__type);

  if (en.status === 'loading') {
    return {
      score: null,
      band: null,
      pending: true,
      components: null,
      inputsUsed: null,
      fsi: null
    };
  }

  const fsi = fsiFromEnrich(en);
  const fsiNorm = clamp01((fsi.level - 1) / 4);

  const fuel = fuelContrib(feature, cfg);
  const slopeAsp = slopeAspectContrib(en, cfg);
  const continuity = continuityContrib(feature.properties.__ha, cfg);
  const ignition = {
    value: clamp01(cfg.ignitionAssumed ?? DEFAULT_FIRE.ignitionAssumed),
    provenance: 'assumed'
  };

  const w = cfg.weights || DEFAULT_FIRE.weights;
  const parts = {
    fuel: fuel.value,
    slopeAspect: slopeAsp.value,
    continuity: continuity.value,
    ignition: ignition.value
  };

  let wSum = 0;
  let weighted = 0;
  for (const key of Object.keys(parts)) {
    const wi = Number(w[key]) || 0;
    wSum += wi;
    weighted += wi * parts[key];
  }
  const susceptibility = wSum > 0 ? weighted / wSum : 0;

  const susW = cfg.susceptibilityBlend ?? DEFAULT_FIRE.susceptibilityBlend;
  const fsiW = cfg.fsiBlend ?? DEFAULT_FIRE.fsiBlend;
  const blendSum = susW + fsiW;
  const score = Math.round(
    100 * (blendSum > 0 ? (susW * susceptibility + fsiW * fsiNorm) / blendSum : 0)
  );
  const band = bandOf(score);

  return {
    score,
    band,
    pending: false,
    components: {
      fuel: { value: fuel.value, weight: w.fuel, provenance: fuel.provenance },
      slopeAspect: {
        value: slopeAsp.value,
        weight: w.slopeAspect,
        provenance: slopeAsp.provenance
      },
      continuity: {
        value: continuity.value,
        weight: w.continuity,
        provenance: continuity.provenance
      },
      ignition: {
        value: ignition.value,
        weight: w.ignition,
        provenance: ignition.provenance
      }
    },
    inputsUsed: {
      fuel: fuel.provenance,
      slopeAspect: slopeAsp.provenance,
      continuity: continuity.provenance,
      ignition: 'assumed',
      fsi: fsi.source,
      age: ageKey
    },
    fsi: {
      level: fsi.level,
      source: fsi.source,
      square: fsi.square ?? null,
      date: fsi.date ?? null
    },
    susceptibility,
    blends: { susceptibility: susW, fsi: fsiW }
  };
}

/** Write enrich.fire onto the feature. */
export function applyFireProps(feature, age) {
  const result = scoreFire(feature, age);
  if (feature.enrich) feature.enrich.fire = result;
  return result;
}

/**
 * Refresh fire scores across the store (weights / manual FSI change).
 * Live and sample FSI stamps are preserved; manual/default restamp from assumptions.
 */
export function syncFireProps() {
  for (const [id, f] of state.features) {
    const age = state.selected.get(id)?.age ?? defaultAge(f.properties.__type);
    if (f.enrich) {
      const src = f.enrich.fsiSource;
      if (src !== 'live' && src !== 'sample') {
        const resolved = resolveFsi(null);
        f.enrich.fsiLevel = resolved.level;
        f.enrich.fsiSource = resolved.source;
        f.enrich.fsiSquare = null;
        f.enrich.fsiDate = null;
      }
    }
    applyFireProps(f, age);
  }
}
