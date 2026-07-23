import { state } from './state.js';
import { scoreWindthrow, bandOf } from './scoring/windthrow.js';
import { scoreFire } from './scoring/fire.js';
import { clientLinkExport } from './data/clientLink.js';

const EMPTY_BANDS = () => ({ LOW: 0, MODERATE: 0, ELEVATED: 0, HIGH: 0 });

/**
 * Passive hint when measured canopy looks implausible for a user-locked age
 * band — a nudge only, never auto-corrects (SPEC §5).
 */
export function heightPlausibilityHint(canopyHeightM, age, ageSource) {
  if (ageSource && ageSource !== 'user') return null;
  if (canopyHeightM == null || !Number.isFinite(canopyHeightM) || !age) return null;
  const maxM = state.rates.heightPlausibilityMaxM?.[age];
  if (maxM == null || !Number.isFinite(maxM)) return null;
  if (canopyHeightM <= maxM) return null;
  const ageLbl =
    age === 'young'
      ? 'young'
      : age === 'establishing'
        ? 'establishing'
        : age === 'semi'
          ? 'semi-mature'
          : 'mature';
  return `Measured height (${canopyHeightM} m) looks tall for a ${ageLbl} stand — check the age band.`;
}

/**
 * Area-weighted mean scores + per-band parcel counts for the selection.
 */
export function selectionRiskSummary(rows) {
  const windBands = EMPTY_BANDS();
  const fireBands = EMPTY_BANDS();
  let windHa = 0;
  let fireHa = 0;
  let windSum = 0;
  let fireSum = 0;

  for (const r of rows) {
    const wt = r.windthrow;
    if (wt && !wt.pending && wt.score != null && wt.band && windBands[wt.band] != null) {
      windBands[wt.band] += 1;
      windSum += wt.score * r.ha;
      windHa += r.ha;
    }
    const fire = r.fire;
    if (fire && !fire.pending && fire.score != null && fire.band && fireBands[fire.band] != null) {
      fireBands[fire.band] += 1;
      fireSum += fire.score * r.ha;
      fireHa += r.ha;
    }
  }

  const windMean = windHa > 0 ? Math.round(windSum / windHa) : null;
  const fireMean = fireHa > 0 ? Math.round(fireSum / fireHa) : null;

  return {
    windthrow: {
      mean: windMean,
      band: bandOf(windMean),
      bands: windBands,
      scoredHa: windHa
    },
    fire: {
      mean: fireMean,
      band: bandOf(fireMean),
      bands: fireBands,
      scoredHa: fireHa
    }
  };
}

export function valueParcel(id) {
  const f = state.features.get(id);
  if (!f) return null;
  const sel = state.selected.get(id);
  const g = f.properties.__group;
  const ha = f.properties.__ha;
  const age = sel.age;
  const ageSource = sel.ageSource || 'user';
  const timber = (state.rates.timber[g]?.[age] ?? 0) * ha;
  const land = state.rates.land * ha;
  const seqR = g === 'other' ? state.rates.seq[age] * 0.3 : state.rates.seq[age];
  const carbon = seqR * state.rates.cprice * ha;
  const en = f.enrich || {};
  const windthrow = scoreWindthrow(f, age, state.rates.windthrow);
  const fire = scoreFire(f, age, state.rates.fire);
  const canopyHeightM = en.canopyHeightM ?? null;
  return {
    id,
    type: f.properties.__type,
    group: g,
    ha,
    age,
    ageSource,
    timber,
    land,
    capital: timber + land,
    carbon,
    canopyHeightM,
    canopySampleCount: en.canopySampleCount ?? 0,
    canopySource: en.canopySource ?? null,
    elevationM: en.elevationM ?? null,
    slopeDeg: en.slopeDeg ?? null,
    aspectDeg: en.aspectDeg ?? null,
    exposure: en.exposure ?? null,
    terrainSource: en.terrainSource ?? null,
    enrichStatus: en.status ?? 'idle',
    heightSource: f.properties.__hSource || 'est',
    nation: en.nation ?? null,
    coverageNote: en.coverageNote ?? null,
    coverKey: f.properties.__cover || null,
    heightHint: heightPlausibilityHint(canopyHeightM, age, ageSource),
    windthrow,
    fire
  };
}

export function exportPayload() {
  const rows = [...state.selected.keys()].map(valueParcel).filter(Boolean);
  const money = rows.reduce(
    (a, r) => ({
      ha: a.ha + r.ha,
      timber: a.timber + r.timber,
      land: a.land + r.land,
      capital: a.capital + r.capital,
      carbonPerYr: a.carbonPerYr + r.carbon
    }),
    { ha: 0, timber: 0, land: 0, capital: 0, carbonPerYr: 0 }
  );
  const clientLink = clientLinkExport();
  const lossSummary = state.lossPlay?.summary
    ? {
        hazard: state.lossPlay.hazard,
        scenario: state.lossPlay.scenario,
        ...state.lossPlay.summary
      }
    : null;
  return {
    generated: new Date().toISOString(),
    source: state.live ? 'NFI live' : 'sample data',
    ...(clientLink ? { clientLink } : {}),
    ...(lossSummary ? { lossPlay: lossSummary } : {}),
    assumptions: {
      ...state.rates,
      windthrow: state.rates.windthrow,
      fire: state.rates.fire,
      loss: state.rates.loss
    },
    parcels: rows,
    totals: {
      ...money,
      risk: selectionRiskSummary(rows)
    }
  };
}
