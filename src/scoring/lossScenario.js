/**
 * Indicative "show a loss" scenarios — NOT a claims model.
 * Three named storms and three named fires; one of each is worst case.
 * Path + tiered severity → SI (sum insured ≈ capital) loss fractions.
 * All knobs live in assumptions (`state.rates.loss`).
 */

import { state, DEFAULT_LOSS } from '../state.js';
import { valueParcel } from '../valuation.js';
import { haversineM } from '../data/clientLink.js';

function cfg() {
  return state.rates.loss || DEFAULT_LOSS;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/** Seeded PRNG for reproducible-ish random paths within a run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parcelCentroid(f) {
  const c = f?.properties?.__centroid;
  if (Array.isArray(c) && c.length >= 2) return [c[0], c[1]];
  // Fallback: average of outer ring
  const g = f?.geometry;
  if (!g) return null;
  const ring =
    g.type === 'Polygon'
      ? g.coordinates[0]
      : g.type === 'MultiPolygon'
        ? g.coordinates[0]?.[0]
        : null;
  if (!ring?.length) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of ring) {
    sx += p[0];
    sy += p[1];
    n++;
  }
  return n ? [sx / n, sy / n] : null;
}

function bearingDeg(from, to) {
  const [lon1, lat1] = from;
  const [lon2, lat2] = to;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDelta(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

function riskScore(row, hazard) {
  if (hazard === 'fire') return row.fire?.score ?? 40;
  return row.windthrow?.score ?? 40;
}

/**
 * Pick a scenario from the three examples.
 * @param {'storm'|'fire'} hazard
 * @param {'random'|'worst'|string|number} choice — id, index, 'random', or 'worst'
 */
export function pickScenario(hazard, choice = 'random', rand = Math.random) {
  const list = hazard === 'fire' ? cfg().fires : cfg().storms;
  if (!list?.length) return null;
  if (choice === 'worst') {
    return list.find((s) => s.severity === 'worst') || list[list.length - 1];
  }
  if (choice === 'random' || choice == null || choice === '') {
    return list[Math.floor(rand() * list.length)];
  }
  if (typeof choice === 'number' || /^\d+$/.test(String(choice))) {
    return list[+choice] || list[0];
  }
  return list.find((s) => s.id === choice) || list[0];
}

export function listScenarios(hazard) {
  return hazard === 'fire' ? cfg().fires || [] : cfg().storms || [];
}

/**
 * Assign severity tiers along an ordered path.
 * Worst scenarios push more parcels into HIGH; moderate keeps a longer fringe.
 */
export function assignTiers(pathLen, scenario) {
  const sev = scenario?.severity || 'moderate';
  // Cumulative share of path at each tier (end of HIGH, ELEVATED, MODERATE).
  const cuts =
    sev === 'worst'
      ? [0.35, 0.65, 0.88]
      : sev === 'severe'
        ? [0.22, 0.5, 0.78]
        : [0.12, 0.35, 0.65];
  const tiers = [];
  for (let i = 0; i < pathLen; i++) {
    const t = pathLen <= 1 ? 0 : i / (pathLen - 1);
    if (t <= cuts[0]) tiers.push('HIGH');
    else if (t <= cuts[1]) tiers.push('ELEVATED');
    else if (t <= cuts[2]) tiers.push('MODERATE');
    else tiers.push('LOW');
  }
  return tiers;
}

/**
 * Build an ordered storm / fire path through the selection.
 * Storm: directional corridor with noise. Fire: fuel-seeking radial spread.
 */
export function buildLossPath(hazard, scenario, seed = Date.now()) {
  const rand = mulberry32(seed >>> 0);
  const ids = [...state.selected.keys()];
  const rows = ids.map(valueParcel).filter(Boolean);
  if (!rows.length) return { path: [], seed, scenario };

  const maxN = Math.min(rows.length, cfg().maxParcels ?? DEFAULT_LOSS.maxParcels);
  const nodes = rows.map((r) => {
    const f = state.features.get(r.id);
    return {
      id: r.id,
      row: r,
      center: parcelCentroid(f),
      risk: riskScore(r, hazard)
    };
  }).filter((n) => n.center);

  if (!nodes.length) return { path: [], seed, scenario };

  // Start: bias to highest risk, with a little randomness among the top few.
  nodes.sort((a, b) => b.risk - a.risk);
  const top = nodes.slice(0, Math.min(3, nodes.length));
  let current = top[Math.floor(rand() * top.length)];
  const used = new Set([current.id]);
  const path = [current];
  const preferBearing = hazard === 'storm' ? scenario?.bearing : null;

  while (path.length < maxN) {
    let best = null;
    let bestScore = -Infinity;
    for (const cand of nodes) {
      if (used.has(cand.id)) continue;
      const dist = haversineM(
        current.center[0],
        current.center[1],
        cand.center[0],
        cand.center[1]
      );
      // Prefer nearby parcels (soft max ~4 km).
      const near = 1 - clamp01(dist / 4000);
      let align = 0.5;
      if (preferBearing != null && Number.isFinite(preferBearing)) {
        const b = bearingDeg(current.center, cand.center);
        align = 1 - clamp01(angleDelta(b, preferBearing) / 180);
      } else if (hazard === 'fire') {
        // Fire: prefer higher fuel/risk and slight outward spread.
        align = clamp01(cand.risk / 100);
      }
      const noise = rand() * 0.35;
      const score = near * 0.45 + align * 0.35 + (cand.risk / 100) * 0.2 + noise;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    if (!best) break;
    used.add(best.id);
    path.push(best);
    current = best;
  }

  const tiers = assignTiers(path.length, scenario);
  const steps = path.map((n, i) => ({
    id: n.id,
    center: n.center,
    tier: tiers[i],
    risk: n.risk,
    ha: n.row.ha,
    si: n.row.capital,
    timber: n.row.timber,
    land: n.row.land
  }));

  return { path: steps, seed, scenario, hazard };
}

/**
 * Indicative SI loss for one parcel step.
 * SI ≈ capital (timber + land). Fraction = tierFraction × scenario.multiplier.
 */
export function lossForStep(step, scenario) {
  const fracs = cfg().tierFraction || DEFAULT_LOSS.tierFraction;
  const tierFrac = fracs[step.tier] ?? 0;
  const mult = scenario?.multiplier ?? 1;
  const fraction = clamp01(tierFrac * mult);
  const si = step.si ?? 0;
  return {
    fraction,
    lossGbp: si * fraction,
    siGbp: si
  };
}

export function summariseLoss(steps, scenario, hazard) {
  const byTier = { LOW: 0, MODERATE: 0, ELEVATED: 0, HIGH: 0 };
  const haByTier = { LOW: 0, MODERATE: 0, ELEVATED: 0, HIGH: 0 };
  let siTotal = 0;
  let lossTotal = 0;
  let haTotal = 0;
  const parcels = [];

  for (const step of steps) {
    const L = lossForStep(step, scenario);
    byTier[step.tier] = (byTier[step.tier] || 0) + 1;
    haByTier[step.tier] = (haByTier[step.tier] || 0) + step.ha;
    siTotal += L.siGbp;
    lossTotal += L.lossGbp;
    haTotal += step.ha;
    parcels.push({
      id: step.id,
      tier: step.tier,
      ha: step.ha,
      siGbp: L.siGbp,
      lossGbp: L.lossGbp,
      fraction: L.fraction
    });
  }

  return {
    hazard,
    scenario,
    parcelCount: steps.length,
    haTotal,
    siTotal,
    lossTotal,
    lossPct: siTotal > 0 ? (lossTotal / siTotal) * 100 : 0,
    byTier,
    haByTier,
    parcels,
    indicative: true
  };
}
