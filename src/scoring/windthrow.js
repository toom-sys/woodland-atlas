/**
 * ForestGALES-inspired windthrow score — NOT the ForestGALES model.
 * Transparent 0–100 composite from open inputs. All weights and ramps
 * come from assumptions state (no magic numbers in the scoring path).
 */
import { state, DEFAULT_WINDTHROW } from '../state.js';
import { defaultAge } from '../data/nfi.js';

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function ramp(value, floor, ceil) {
  if (value == null || !Number.isFinite(value)) return null;
  if (ceil <= floor) return value >= ceil ? 1 : 0;
  return clamp01((value - floor) / (ceil - floor));
}

export function bandOf(score) {
  if (score == null || !Number.isFinite(score)) return null;
  if (score < 25) return 'LOW';
  if (score < 50) return 'MODERATE';
  if (score < 75) return 'ELEVATED';
  return 'HIGH';
}

function scenarioLabel(key) {
  if (key === 'northerly') return 'Northerly (Arwen-type)';
  if (key === 'any') return 'Any (worst case)';
  return 'Prevailing SW';
}

/**
 * Height contribution 0–1: 0 below floor m, linear to 1 at ceil m+.
 */
function heightContrib(heightM, cfg) {
  const r = ramp(heightM, cfg.heightFloorM, cfg.heightCeilM);
  return r == null ? 0 : r;
}

/**
 * Northerly vulnerability from aspect + exposure.
 * North-facing (0°) and exposed parcels ramp toward 1.0.
 */
function northerlyDirection(aspectDeg, exposure, cfg) {
  const asp = aspectDeg != null && Number.isFinite(aspectDeg) ? aspectDeg : 180;
  const exp = exposure != null && Number.isFinite(exposure) ? exposure : 0.4;
  const northFace = (1 + Math.cos((asp * Math.PI) / 180)) / 2;
  return clamp01(northFace * (0.35 + 0.65 * exp));
}

function directionContrib(aspectDeg, exposure, scenario, cfg) {
  const sw = clamp01(cfg.directionSwBaseline);
  const north = northerlyDirection(aspectDeg, exposure, cfg);
  if (scenario === 'northerly') return north;
  if (scenario === 'any') return Math.max(sw, north);
  return sw;
}

function resolveCanopy(f, age, cfg) {
  const en = f.enrich || {};
  if (en.canopyHeightM != null && Number.isFinite(en.canopyHeightM)) {
    const source =
      en.canopySource === 'lidar'
        ? 'lidar'
        : en.canopySource === 'sample'
          ? 'sample'
          : 'estimated';
    return { heightM: en.canopyHeightM, source };
  }
  const g = f.properties.__group || 'other';
  const table = cfg.estimatedCanopyM?.[g] || DEFAULT_WINDTHROW.estimatedCanopyM[g];
  const heightM = table?.[age] ?? DEFAULT_WINDTHROW.estimatedCanopyM.other.semi;
  return { heightM, source: 'estimated' };
}

/**
 * Score one parcel. Pure — reads feature + age + windthrow assumptions.
 * @returns {{score, band, components, inputsUsed, scenario, scenarioLabel} | null}
 */
export function scoreWindthrow(feature, age, windCfg) {
  if (!feature) return null;
  const cfg = windCfg || state.rates.windthrow || DEFAULT_WINDTHROW;
  const en = feature.enrich || {};
  const group = feature.properties.__group || 'other';
  const ageKey = age || defaultAge(feature.properties.__type);
  const id = feature.properties.__id;
  const ageProv = state.selected.get(id)?.ageSource || 'default';
  const ageProvLabel =
    ageProv === 'height'
      ? 'canopy'
      : ageProv === 'type'
        ? 'type'
        : ageProv === 'user'
          ? 'user'
          : 'assumed';

  // Still sampling — caller may show a spinner instead.
  if (en.status === 'loading') {
    return {
      score: null,
      band: null,
      pending: true,
      components: null,
      inputsUsed: null,
      scenario: cfg.stormScenario,
      scenarioLabel: scenarioLabel(cfg.stormScenario)
    };
  }

  const { heightM, source: canopySource } = resolveCanopy(feature, ageKey, cfg);
  const w = cfg.weights || DEFAULT_WINDTHROW.weights;

  const cHeight = heightContrib(heightM, cfg);
  const cSpecies = clamp01(cfg.species?.[group] ?? DEFAULT_WINDTHROW.species.other);
  const elevR = ramp(en.elevationM, cfg.elevFloorM, cfg.elevCeilM);
  const exp = en.exposure != null && Number.isFinite(en.exposure) ? clamp01(en.exposure) : 0.35;
  const elevPart = elevR == null ? 0.35 : elevR;
  const cExposure = clamp01(
    (cfg.exposureBlend ?? 0.6) * exp + (cfg.elevBlend ?? 0.4) * elevPart
  );
  const cAge = clamp01(cfg.age?.[ageKey] ?? DEFAULT_WINDTHROW.age.semi);
  const scenario = cfg.stormScenario || 'sw';
  const cDirection = directionContrib(en.aspectDeg, en.exposure, scenario, cfg);

  const parts = {
    height: cHeight,
    species: cSpecies,
    exposure: cExposure,
    age: cAge,
    direction: cDirection
  };

  let wSum = 0;
  let weighted = 0;
  for (const key of Object.keys(parts)) {
    const wi = Number(w[key]) || 0;
    wSum += wi;
    weighted += wi * parts[key];
  }
  const score = Math.round(100 * (wSum > 0 ? weighted / wSum : 0));
  const band = bandOf(score);

  const terrainProv =
    en.terrainSource === 'dtm'
      ? 'dtm'
      : en.terrainSource === 'sample'
        ? 'sample'
        : en.elevationM != null || en.aspectDeg != null || en.exposure != null
          ? 'estimated'
          : 'assumed';

  return {
    score,
    band,
    pending: false,
    components: {
      height: { value: cHeight, weight: w.height, provenance: canopySource },
      species: { value: cSpecies, weight: w.species, provenance: 'type' },
      exposure: {
        value: cExposure,
        weight: w.exposure,
        provenance: terrainProv
      },
      age: { value: cAge, weight: w.age, provenance: ageProvLabel },
      direction: {
        value: cDirection,
        weight: w.direction,
        provenance: en.aspectDeg != null ? terrainProv : 'assumed'
      }
    },
    inputsUsed: {
      canopy: canopySource,
      canopyHeightM: heightM,
      elevation: en.elevationM != null ? terrainProv : 'assumed',
      aspect: en.aspectDeg != null ? terrainProv : 'assumed',
      exposure: en.exposure != null ? terrainProv : 'assumed',
      age: ageProvLabel,
      species: 'type'
    },
    scenario,
    scenarioLabel: scenarioLabel(scenario)
  };
}

/** Write __windBand / __windScore onto a feature for map risk colouring. */
export function applyWindthrowProps(feature, age) {
  const result = scoreWindthrow(feature, age);
  if (feature.enrich) feature.enrich.windthrow = result;
  if (result?.pending || result?.band == null) {
    feature.properties.__windBand = 'NONE';
    feature.properties.__windScore = -1;
  } else {
    feature.properties.__windBand = result.band;
    feature.properties.__windScore = result.score;
  }
  return result;
}

/**
 * Refresh windthrow props for map risk colouring.
 * Cheap pure math — safe across the in-memory store.
 */
export function syncWindthrowProps() {
  for (const [id, f] of state.features) {
    const age = state.selected.get(id)?.age ?? defaultAge(f.properties.__type);
    applyWindthrowProps(f, age);
  }
}
