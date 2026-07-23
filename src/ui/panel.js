import { state, AGES, GROUP_COLORS, RISK_BAND_COLORS, subscribe } from '../state.js';
import { valueParcel, exportPayload, selectionRiskSummary } from '../valuation.js';
import {
  setFeatureSelected,
  pushSource,
  applyColorMode,
  showClientGuide,
  selectParcelsTouchingGuide,
  resetClientLink,
  pushClientGuide,
  playLossScenario,
  clearLossPlay,
  beginSplitMode
} from '../map.js';
import { COVER_COLORS, COVER_LABELS } from '../data/nation.js';
import { AGE_SOURCE_LABELS } from '../data/nfi.js';
import { listScenarios } from '../scoring/lossScenario.js';
import { syncWindthrowProps } from '../scoring/windthrow.js';
import { syncFireProps } from '../scoring/fire.js';
import { clampAreaHa } from '../data/clientLink.js';
import { toast } from './pills.js';

const $ = (id) => document.getElementById(id);
const gbp = (n) => '£' + Math.round(n).toLocaleString('en-GB');
const fmtHa = (n) => n.toLocaleString('en-GB', { maximumFractionDigits: 1 });

const WIND_LABELS = {
  height: 'Canopy height',
  species: 'Species / rooting',
  exposure: 'Exposure',
  age: 'Age / stage',
  direction: 'Wind direction'
};

const FIRE_LABELS = {
  fuel: 'Fuel type',
  slopeAspect: 'Slope & aspect',
  continuity: 'Canopy continuity',
  ignition: 'Ignition proximity'
};

function riskClass(band) {
  if (!band) return 'risk-none';
  return 'risk-' + band.toLowerCase();
}

function enrichLabel(r) {
  const st = r.enrichStatus;
  if (st === 'loading') {
    return `<span class="enrich-chip loading">HEIGHT · sampling…</span>`;
  }

  const chips = [];
  if (r.canopyHeightM != null) {
    const prov =
      r.canopySource === 'lidar'
        ? r.nation === 'scotland'
          ? 'Scot LiDAR'
          : 'LiDAR'
        : r.canopySource === 'sample'
          ? 'sample'
          : 'est.';
    const n =
      r.canopySampleCount > 0
        ? ` · ${r.canopySampleCount} pts`
        : r.canopySource === 'sample'
          ? ' · fixed'
          : '';
    chips.push(`<span class="enrich-chip">${r.canopyHeightM} m · ${prov}${n}</span>`);
  } else if (st === 'none' || st === 'error' || st === 'ok' || st === 'partial') {
    chips.push(`<span class="enrich-chip muted">NO LIDAR</span>`);
  } else {
    chips.push(`<span class="enrich-chip muted">HEIGHT · est.</span>`);
  }

  if (r.coverKey && COVER_LABELS[r.coverKey]) {
    const col = COVER_COLORS[r.coverKey] || COVER_COLORS.unknown;
    chips.push(
      `<span class="enrich-chip cover" style="border-color:${col};color:${col}">${COVER_LABELS[r.coverKey]}</span>`
    );
  }

  if (r.elevationM != null) {
    const tprov =
      r.terrainSource === 'dtm'
        ? r.nation === 'scotland'
          ? 'Scot DTM'
          : 'DTM'
        : r.terrainSource === 'sample'
          ? 'sample'
          : 'est.';
    chips.push(`<span class="enrich-chip">${Math.round(r.elevationM)} m · ${tprov}</span>`);
  }

  return chips.join('');
}

function riskChipHtml(kind, result, label) {
  const dataRisk = kind;
  if (!result || result.pending) {
    return `<button type="button" class="risk-chip loading" aria-expanded="false" data-risk="${dataRisk}">${label} · scoring…</button>`;
  }
  if (result.score == null || !result.band) {
    return `<button type="button" class="risk-chip muted" aria-expanded="false" data-risk="${dataRisk}">${label} · N/A</button>`;
  }
  return `<button type="button" class="risk-chip ${riskClass(result.band)}" aria-expanded="false" data-risk="${dataRisk}">${label} ${result.score} · ${result.band}</button>`;
}

function breakdownRows(components, labels) {
  return Object.entries(components)
    .map(([key, c]) => {
      const pct = Math.round((c.value || 0) * 100);
      const w = c.weight != null ? Number(c.weight).toFixed(2) : '—';
      return `<div class="risk-row">
        <span class="risk-comp">${labels[key] || key}</span>
        <span class="risk-val">${pct}%</span>
        <span class="risk-w">×${w}</span>
        <span class="risk-prov">${c.provenance || '—'}</span>
      </div>`;
    })
    .join('');
}

function windthrowBreakdownHtml(wt) {
  if (!wt || wt.pending || !wt.components) {
    return `<p class="risk-empty">Waiting for enrichment…</p>`;
  }
  return `
    <div class="risk-breakdown-head">
      <span>Component</span><span>Contrib</span><span>Wt</span><span>Source</span>
    </div>
    ${breakdownRows(wt.components, WIND_LABELS)}
    <p class="risk-scenario">Scenario · ${wt.scenarioLabel || wt.scenario}</p>`;
}

function fireBreakdownHtml(fire) {
  if (!fire || fire.pending || !fire.components) {
    return `<p class="risk-empty">Waiting for enrichment…</p>`;
  }
  const fsi = fire.fsi;
  const blend = fire.blends || {};
  const susW = blend.susceptibility != null ? Number(blend.susceptibility).toFixed(2) : '—';
  const fsiW = blend.fsi != null ? Number(blend.fsi).toFixed(2) : '—';
  const fsiLine = fsi
    ? `Blend · suscept. ×${susW} + FSI ×${fsiW} · level ${fsi.level} (${fsi.source}${fsi.square ? ` · ${fsi.square}` : ''})`
    : '';
  return `
    <div class="risk-breakdown-head">
      <span>Component</span><span>Contrib</span><span>Wt</span><span>Source</span>
    </div>
    ${breakdownRows(fire.components, FIRE_LABELS)}
    <p class="risk-scenario">${fsiLine}</p>
    <p class="risk-scenario risk-note">Ignition proximity is assumed in v2 — not measured from access data.</p>`;
}

function download(name, text, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function scenarioPill() {
  const wt = state.rates.windthrow;
  const key = wt.stormScenario || 'sw';
  const label =
    key === 'northerly' ? 'NORTHERLY' : key === 'any' ? 'ANY · WORST' : 'PREVAILING SW';
  return `<span class="scenario-pill"><i></i>STORM · ${label}</span>`;
}

function fsiPill() {
  // Prefer a selected parcel's live stamp; else show manual level.
  let source = 'manual';
  let level = state.rates.fire?.fsiLevelManual ?? 2;
  for (const id of state.selected.keys()) {
    const en = state.features.get(id)?.enrich;
    if (en?.fsiSource === 'live' && en.fsiLevel != null) {
      source = 'live';
      level = en.fsiLevel;
      break;
    }
    if (en?.fsiSource === 'sample' && en.fsiLevel != null) {
      source = 'sample';
      level = en.fsiLevel;
    }
  }
  const tag =
    source === 'live' ? 'LIVE' : source === 'sample' ? 'SAMPLE' : 'MANUAL';
  return `<span class="scenario-pill fsi-pill"><i></i>FSI · ${level} · ${tag}</span>`;
}

function bandCountLine(bands) {
  if (!bands) return '';
  const parts = ['LOW', 'MODERATE', 'ELEVATED', 'HIGH']
    .map((b) => {
      const n = bands[b] || 0;
      if (!n) return null;
      const short = b === 'MODERATE' ? 'MOD' : b === 'ELEVATED' ? 'ELEV' : b;
      return `${n} ${short}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : 'none scored yet';
}

function riskTotalsHtml(summary) {
  if (!summary) return '';
  const row = (label, block) => {
    if (!block || block.mean == null) {
      return `<div class="risk-tot">
        <span class="risk-tot-lbl">${label}</span>
        <span class="risk-tot-val muted">N/A</span>
        <span class="risk-tot-bands">${bandCountLine(block?.bands)}</span>
      </div>`;
    }
    return `<div class="risk-tot">
      <span class="risk-tot-lbl">${label}</span>
      <span class="risk-tot-val ${riskClass(block.band)}">${block.mean} · ${block.band}</span>
      <span class="risk-tot-bands">${bandCountLine(block.bands)}</span>
    </div>`;
  };
  return `<div class="risk-totals">
    <div class="risk-totals-kicker">AREA-WEIGHTED RISK</div>
    ${row('WIND', summary.windthrow)}
    ${row('FIRE', summary.fire)}
  </div>`;
}

/** One-line risk for the always-visible area summary. */
function riskSummaryLine(summary) {
  if (!summary) return '';
  const bit = (label, block) => {
    if (!block || block.mean == null) {
      return `<span class="sum-risk muted">${label} · N/A</span>`;
    }
    return `<span class="sum-risk ${riskClass(block.band)}">${label} ${block.mean} · ${block.band}</span>`;
  };
  return `<div class="totals-risk-line">${bit('WIND', summary.windthrow)}${bit('FIRE', summary.fire)}</div>`;
}

function clientLinkSummaryText() {
  const link = state.clientLink;
  if (!link) return '';
  const parts = [];
  const ref = (link.ref || '').trim();
  if (ref) parts.push(ref);
  if (link.w3w) parts.push(`///${link.w3w}`);
  else if (link.center) {
    parts.push(`${link.center[1].toFixed(5)}, ${link.center[0].toFixed(5)}`);
  }
  if (link.center && link.areaHa > 0) parts.push(`${Math.round(link.areaHa)} ha`);
  return parts.join(' · ');
}

function foldWasOpen(id) {
  const el = $(id);
  return el ? el.open : false;
}

export function render() {
  const n = state.selected.size;
  $('empty-state').style.display = n ? 'none' : 'block';
  const ref = (state.clientLink?.ref || '').trim();
  $('panel-title').textContent = n
    ? `${n} parcel${n > 1 ? 's' : ''} selected${ref ? ` · ${ref}` : ''}`
    : ref
      ? `Linked · ${ref}`
      : 'No parcels selected';

  const tag = $('client-link-tag');
  if (tag) {
    if (ref || state.clientLink?.status === 'shown') {
      tag.textContent = ref ? 'LINKED' : 'GUIDE';
      tag.classList.add('on');
    } else {
      tag.textContent = '';
      tag.classList.remove('on');
    }
  }

  const linkSum = $('client-link-sum');
  if (linkSum) {
    const text = clientLinkSummaryText();
    linkSum.textContent = text;
    linkSum.hidden = !text;
  }

  // Keep inputs in sync when state changes from Clear link (avoid fighting focus).
  const refInp = $('client-ref');
  const w3wInp = $('client-w3w');
  const areaInp = $('client-area');
  if (refInp && document.activeElement !== refInp) refInp.value = state.clientLink.ref || '';
  if (w3wInp && document.activeElement !== w3wInp) {
    w3wInp.value =
      state.clientLink.w3w ||
      (state.clientLink.center
        ? `${state.clientLink.center[1].toFixed(5)}, ${state.clientLink.center[0].toFixed(5)}`
        : '');
  }
  if (areaInp && document.activeElement !== areaInp) {
    areaInp.value = state.clientLink.areaHa || '';
  }

  renderLossSlot();

  const rows = [...state.selected.keys()].map(valueParcel).filter(Boolean);
  const tot = rows.reduce(
    (a, r) => ({
      ha: a.ha + r.ha,
      timber: a.timber + r.timber,
      land: a.land + r.land,
      carbon: a.carbon + r.carbon
    }),
    { ha: 0, timber: 0, land: 0, carbon: 0 }
  );
  const cap = tot.timber + tot.land;
  const riskSummary = selectionRiskSummary(rows);

  const coverageNotes = [];
  for (const r of rows) {
    if (r.coverageNote && !coverageNotes.includes(r.coverageNote)) coverageNotes.push(r.coverageNote);
  }

  const totalsMoreOpen = foldWasOpen('totals-more');
  const parcelsFoldOpen = foldWasOpen('parcels-fold');

  $('totals-slot').innerHTML = n
    ? `
    <div class="totals">
      <div class="totals-kicker">AREA SUMMARY</div>
      <div class="totals-hero">
        <div class="hero-stat">
          <span class="hs-l">Parcels</span>
          <span class="hs-v">${n}</span>
        </div>
        <div class="hero-stat">
          <span class="hs-l">Area</span>
          <span class="hs-v">${fmtHa(tot.ha)} <span class="hs-u">ha</span></span>
        </div>
        <div class="hero-stat hero-cap">
          <span class="hs-l">Capital</span>
          <span class="hs-v">${gbp(cap)}</span>
        </div>
      </div>
      ${riskSummaryLine(riskSummary)}
      <div class="totals-meta">${scenarioPill()}${fsiPill()}</div>
      <details class="totals-more" id="totals-more"${totalsMoreOpen ? ' open' : ''}>
        <summary><span class="glyph">▸</span>Value &amp; risk detail</summary>
        <div class="totals-more-body">
          <div class="row"><span class="lbl">Standing timber</span><span class="val">${gbp(tot.timber)}</span></div>
          <div class="row"><span class="lbl">Land</span><span class="val">${gbp(tot.land)}</span></div>
          <div class="row grand"><span class="lbl">Capital value</span><span class="val">${gbp(cap)}</span></div>
          <div class="bar">
            <i style="width:${cap ? (tot.timber / cap) * 100 : 0}%;background:var(--amber)"></i>
            <i style="width:${cap ? (tot.land / cap) * 100 : 0}%;background:var(--moss)"></i>
          </div>
          <div class="bar-key"><span><i style="background:var(--amber)"></i>TIMBER</span><span><i style="background:var(--moss)"></i>LAND</span></div>
          <div class="carbon-line"><span>Indicative carbon income</span><span class="val">${gbp(tot.carbon)} / yr</span></div>
          ${riskTotalsHtml(riskSummary)}
          ${
            coverageNotes.length
              ? `<div class="coverage-notes">${coverageNotes
                  .map((t) => `<p>${t}</p>`)
                  .join('')}</div>`
              : ''
          }
        </div>
      </details>
    </div>`
    : '';

  const parcelCards = rows
    .map((r) => {
      const enrichRow = enrichLabel(r);
      const note =
        r.coverageNote && r.canopyHeightM == null
          ? `<p class="parcel-note">${r.coverageNote}</p>`
          : '';
      const heightHint = r.heightHint
        ? `<p class="parcel-hint">${r.heightHint}</p>`
        : '';
      const swatch =
        state.riskView && r.windthrow?.band
          ? RISK_BAND_COLORS[r.windthrow.band]
          : state.colorMode === 'coverage' && r.coverKey
            ? COVER_COLORS[r.coverKey] || COVER_COLORS.unknown
            : GROUP_COLORS[r.group];
      return `
    <div class="parcel" data-id="${r.id}">
      <div class="parcel-top">
        <span class="swatch" style="background:${swatch}"></span>
        <span class="name">${r.type}${r.split ? ' · split' : ''}</span>
        <span class="ha">${fmtHa(r.ha)} ha</span>
        <button class="x" title="Remove" aria-label="Remove parcel">✕</button>
      </div>
      <div class="parcel-mid">
        <label>AGE</label>
        <select aria-label="Age band">${AGES.map(
          ([k, l]) => `<option value="${k}"${k === r.age ? ' selected' : ''}>${l}</option>`
        ).join('')}</select>
        <span class="age-source" title="NFI does not publish stand age — estimated from open data, override anytime">${AGE_SOURCE_LABELS[r.ageSource] || AGE_SOURCE_LABELS.default}</span>
      </div>
      ${
        r.split
          ? ''
          : `<div class="parcel-actions"><button type="button" class="split-btn" data-split="${r.id}">Split parcel</button></div>`
      }
      <div class="parcel-enrich">${enrichRow}</div>
      <div class="parcel-risk">
        <div class="risk-chips">
          ${riskChipHtml('wind', r.windthrow, 'WIND')}
          ${riskChipHtml('fire', r.fire, 'FIRE')}
        </div>
        <div class="risk-breakdown" data-for="wind" hidden>${windthrowBreakdownHtml(r.windthrow)}</div>
        <div class="risk-breakdown" data-for="fire" hidden>${fireBreakdownHtml(r.fire)}</div>
      </div>
      ${heightHint}
      ${note}
      <div class="parcel-vals">
        <span class="pv"><span class="l">TIMBER</span><span class="v">${gbp(r.timber)}</span></span>
        <span class="pv"><span class="l">LAND</span><span class="v">${gbp(r.land)}</span></span>
        <span class="pv"><span class="l">CARBON/YR</span><span class="v">${gbp(r.carbon)}</span></span>
        <span class="pv total"><span class="l">CAPITAL</span><span class="v">${gbp(r.capital)}</span></span>
      </div>
    </div>`;
    })
    .join('');

  $('parcels-slot').innerHTML = n
    ? `<details class="parcels-fold" id="parcels-fold"${parcelsFoldOpen ? ' open' : ''}>
        <summary><span class="glyph">▸</span>Parcels <span class="parcels-fold-count">${n}</span></summary>
        <div class="parcels-fold-body">${parcelCards}</div>
      </details>`
    : '';

  $('parcels-slot').querySelectorAll('.parcel').forEach((card) => {
    const id = card.dataset.id;
    card.querySelector('.x').onclick = () => {
      state.selected.delete(id);
      setFeatureSelected(id, false);
      render();
    };
    const splitBtn = card.querySelector('.split-btn');
    if (splitBtn) {
      splitBtn.onclick = (e) => {
        e.stopPropagation();
        beginSplitMode(id);
      };
    }
    card.querySelector('select').onchange = (e) => {
      const sel = state.selected.get(id);
      sel.age = e.target.value;
      sel.ageSource = 'user';
      sel.ageLocked = true;
      syncWindthrowProps();
      syncFireProps();
      if (state.riskView) {
        pushSource();
        applyColorMode();
      }
      render();
    };
    card.onmouseenter = () => setFeatureSelected(id, true);

    card.querySelectorAll('.risk-chip').forEach((chip) => {
      const kind = chip.dataset.risk;
      const breakdown = card.querySelector(`.risk-breakdown[data-for="${kind}"]`);
      if (!chip || !breakdown) return;
      chip.onclick = () => {
        const open = breakdown.hasAttribute('hidden');
        // Close sibling breakdowns on this card.
        card.querySelectorAll('.risk-breakdown').forEach((b) => b.setAttribute('hidden', ''));
        card.querySelectorAll('.risk-chip').forEach((c) => c.setAttribute('aria-expanded', 'false'));
        if (open) {
          breakdown.removeAttribute('hidden');
          chip.setAttribute('aria-expanded', 'true');
        }
      };
    });
  });
}

function renderLossSlot() {
  const slot = $('loss-slot');
  const tag = $('loss-play-tag');
  if (!slot) return;
  const play = state.lossPlay;
  if (tag) {
    if (play?.running) {
      tag.textContent = 'PLAYING';
      tag.classList.add('on');
    } else if (play?.summary) {
      tag.textContent = 'LOSS';
      tag.classList.add('on');
    } else {
      tag.textContent = '';
      tag.classList.remove('on');
    }
  }

  if (!play) {
    slot.innerHTML = '';
    return;
  }

  const name = play.scenario?.label || 'Scenario';
  const haz = play.hazard === 'fire' ? 'Fire spread' : 'Storm path';
  const loss = play.runningLoss || 0;
  const si = play.runningSi || 0;
  const pct = si > 0 ? ((loss / si) * 100).toFixed(0) : '0';
  const summary = play.summary;

  let tiersHtml = '';
  if (summary) {
    tiersHtml = ['HIGH', 'ELEVATED', 'MODERATE', 'LOW']
      .map((t) => {
        const n = summary.byTier[t] || 0;
        if (!n) return '';
        const col = RISK_BAND_COLORS[t];
        return `<span class="loss-tier" style="border-color:${col};color:${col}">${n} ${t}</span>`;
      })
      .filter(Boolean)
      .join('');
  }

  slot.innerHTML = `
    <div class="loss-card">
      <div class="loss-card-kicker">${play.running ? 'LOSS · PLAYING' : 'LOSS · INDICATIVE'}</div>
      <div class="loss-card-title">${haz} · ${name}</div>
      <div class="row"><span class="lbl">SI on path</span><span class="val">${gbp(si)}</span></div>
      <div class="row grand"><span class="lbl">Indicative loss</span><span class="val">${gbp(loss)}</span></div>
      <div class="row"><span class="lbl">Of SI on path</span><span class="val">${pct}%</span></div>
      ${
        summary
          ? `<div class="loss-tiers">${tiersHtml}</div>
             <p class="loss-card-note">${summary.parcelCount} parcels · ${fmtHa(summary.haTotal)} ha on path. Red is HIGH severity only. Not a claims estimate.</p>`
          : `<p class="loss-card-note">Path spreading…</p>`
      }
    </div>`;
}

function fillLossScenarioOptions() {
  const haz = $('loss-hazard')?.value || 'storm';
  const sel = $('loss-scenario');
  if (!sel) return;
  const prev = sel.value;
  const list = listScenarios(haz);
  sel.innerHTML =
    `<option value="random">Random of three</option>` +
    `<option value="worst">Worst case</option>` +
    list.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function bindLossPlay() {
  const haz = $('loss-hazard');
  const run = $('btn-loss-run');
  const clear = $('btn-loss-clear');
  if (!haz || !run || !clear) return;

  fillLossScenarioOptions();
  haz.onchange = fillLossScenarioOptions;

  run.onclick = async () => {
    if (!state.selected.size) return toast('Select at least one parcel first');
    const hazard = haz.value === 'fire' ? 'fire' : 'storm';
    const choice = $('loss-scenario')?.value || 'random';
    run.disabled = true;
    try {
      const details = $('loss-play');
      if (details) details.open = true;
      await playLossScenario(hazard, choice);
    } finally {
      run.disabled = false;
    }
  };

  clear.onclick = () => {
    clearLossPlay();
    toast('Loss scenario cleared');
  };
}

export function bindExports() {
  $('btn-export').onclick = () => {
    if (!state.selected.size) return toast('Select at least one parcel first');
    download('woodland-selection.json', JSON.stringify(exportPayload(), null, 2), 'application/json');
  };
  $('btn-csv').onclick = () => {
    if (!state.selected.size) return toast('Select at least one parcel first');
    const p = exportPayload();
    const clientRef = p.clientLink?.ref || '';
    const lines = [
      [
        'id',
        'type',
        'group',
        'age',
        'age_source',
        'hectares',
        'timber_gbp',
        'land_gbp',
        'capital_gbp',
        'carbon_gbp_per_yr',
        'canopy_height_m',
        'canopy_source',
        'elevation_m',
        'slope_deg',
        'aspect_deg',
        'exposure',
        'windthrow_score',
        'windthrow_band',
        'storm_scenario',
        'fire_score',
        'fire_band',
        'fsi_level',
        'fsi_source',
        'client_ref'
      ].join(',')
    ];
    for (const r of p.parcels) {
      const wt = r.windthrow;
      const fire = r.fire;
      lines.push(
        [
          r.id,
          `"${r.type}"`,
          r.group,
          r.age,
          r.ageSource ?? '',
          r.ha.toFixed(2),
          Math.round(r.timber),
          Math.round(r.land),
          Math.round(r.capital),
          Math.round(r.carbon),
          r.canopyHeightM ?? '',
          r.canopySource ?? '',
          r.elevationM ?? '',
          r.slopeDeg ?? '',
          r.aspectDeg ?? '',
          r.exposure ?? '',
          wt?.score ?? '',
          wt?.band ?? '',
          wt?.scenario ?? '',
          fire?.score ?? '',
          fire?.band ?? '',
          fire?.fsi?.level ?? '',
          fire?.fsi?.source ?? '',
          clientRef ? `"${String(clientRef).replace(/"/g, '""')}"` : ''
        ].join(',')
      );
    }
    lines.push(
      [
        'TOTAL',
        '',
        '',
        '',
        '',
        p.totals.ha.toFixed(2),
        Math.round(p.totals.timber),
        Math.round(p.totals.land),
        Math.round(p.totals.capital),
        Math.round(p.totals.carbonPerYr),
        '',
        '',
        '',
        '',
        '',
        '',
        p.totals.risk?.windthrow?.mean ?? '',
        p.totals.risk?.windthrow?.band ?? '',
        '',
        p.totals.risk?.fire?.mean ?? '',
        p.totals.risk?.fire?.band ?? '',
        '',
        '',
        ''
      ].join(',')
    );
    download('woodland-selection.csv', lines.join('\n'), 'text/csv');
  };
}

function bindClientLink() {
  const refInp = $('client-ref');
  const w3wInp = $('client-w3w');
  const areaInp = $('client-area');
  if (!refInp || !w3wInp || !areaInp) return;

  areaInp.value = state.clientLink.areaHa;

  const applyAreaFromInput = () => {
    const ha = clampAreaHa(areaInp.value);
    if (ha == null) return false;
    state.clientLink.areaHa = ha;
    if (state.clientLink.center) pushClientGuide();
    notifyClientChrome();
    return true;
  };

  refInp.oninput = () => {
    state.clientLink.ref = refInp.value;
    notifyClientChrome();
  };
  w3wInp.oninput = () => {
    state.clientLink.w3w = w3wInp.value.trim();
  };
  areaInp.oninput = () => {
    applyAreaFromInput();
  };

  $('btn-client-guide').onclick = async () => {
    const raw = w3wInp.value.trim();
    if (!raw) return toast('Enter a what3words or lat, lon first');
    state.clientLink.ref = refInp.value;
    applyAreaFromInput();
    const btn = $('btn-client-guide');
    btn.disabled = true;
    try {
      await showClientGuide(raw);
    } finally {
      btn.disabled = false;
    }
  };

  $('btn-client-touch').onclick = async () => {
    const btn = $('btn-client-touch');
    btn.disabled = true;
    try {
      if (!state.clientLink.center) {
        const raw = w3wInp.value.trim();
        if (!raw) return toast('Enter a what3words or lat, lon first');
        state.clientLink.ref = refInp.value;
        applyAreaFromInput();
        const ok = await showClientGuide(raw);
        if (!ok) return;
      }
      await selectParcelsTouchingGuide();
    } finally {
      btn.disabled = false;
    }
  };

  $('btn-client-clear').onclick = () => {
    resetClientLink();
    refInp.value = '';
    w3wInp.value = '';
    areaInp.value = state.clientLink.areaHa;
    toast('Group cleared');
  };
}

function notifyClientChrome() {
  const ref = (state.clientLink?.ref || '').trim();
  const n = state.selected.size;
  $('panel-title').textContent = n
    ? `${n} parcel${n > 1 ? 's' : ''} selected${ref ? ` · ${ref}` : ''}`
    : ref
      ? `Linked · ${ref}`
      : 'No parcels selected';
  const tag = $('client-link-tag');
  if (tag) {
    if (ref || state.clientLink?.status === 'shown') {
      tag.textContent = ref ? 'LINKED' : 'GUIDE';
      tag.classList.add('on');
    } else {
      tag.textContent = '';
      tag.classList.remove('on');
    }
  }
  const linkSum = $('client-link-sum');
  if (linkSum) {
    const text = clientLinkSummaryText();
    linkSum.textContent = text;
    linkSum.hidden = !text;
  }
}

export function initPanel() {
  subscribe(render);
  bindExports();
  bindClientLink();
  bindLossPlay();
  render();
}
