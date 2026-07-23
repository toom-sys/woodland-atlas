import {
  state,
  START,
  SAMPLE,
  SAMPLE_LABEL,
  GROUP_COLORS,
  RISK_BAND_COLORS,
  MIN_FETCH_ZOOM,
  DEFAULT_CLIENT_AREA_HA,
  DEFAULT_LOSS,
  notify
} from './state.js';
import { discoverNFI, queryViewport, capFeatures, selectionAgeState } from './data/nfi.js';
import { loadDemo } from './data/demo.js';
import { enrichParcel, initEnrichmentPills } from './data/enrich.js';
import { emptyEnrich } from './data/lidar.js';
import { COVER_COLORS, applyCoverProps } from './data/nation.js';
import {
  circlePolygon,
  circleBounds,
  geometryTouchesCircle,
  resolveLocation,
  emptyClientLink,
  guideRadiusM,
  clampAreaHa,
  radiusMToHa
} from './data/clientLink.js';
import { syncWindthrowProps } from './scoring/windthrow.js';
import {
  pickScenario,
  buildLossPath,
  summariseLoss,
  lossForStep
} from './scoring/lossScenario.js';
import { setPill, toast } from './ui/pills.js';

const $ = (id) => document.getElementById(id);

let map;
let fetching = false;
let fetchQueued = false;

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Ensure Esri imagery source/layer exist and match `state.satellite`. */
function applySatelliteBasemap() {
  if (!map) return;
  if (state.satellite && !map.getSource('sat')) {
    map.addSource('sat', {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
      ],
      tileSize: 256,
      attribution: 'Imagery © Esri'
    });
    map.addLayer(
      {
        id: 'base-sat',
        type: 'raster',
        source: 'sat',
        paint: { 'raster-opacity': 0.85 }
      },
      'nfi-fill'
    );
  }
  if (map.getLayer('base-sat')) {
    map.setLayoutProperty('base-sat', 'visibility', state.satellite ? 'visible' : 'none');
  }
  if (map.getLayer('base-dark')) {
    map.setLayoutProperty('base-dark', 'visibility', state.satellite ? 'none' : 'visible');
  }
  const btn = $('btn-sat');
  if (btn) {
    btn.textContent = state.satellite ? '▦ SATELLITE · ON' : '▦ SATELLITE · OFF';
    btn.classList.toggle('active', state.satellite);
    btn.setAttribute('aria-pressed', String(state.satellite));
  }
  setPill(
    'pill-base',
    'ok',
    state.satellite ? 'BASEMAP · SATELLITE' : 'BASEMAP · CARTO DARK'
  );
}

/** MapLibre camera move — instant when the user prefers reduced motion. */
function cameraTo(opts, mode = 'fly') {
  if (!map) return;
  if (prefersReducedMotion()) {
    map.jumpTo({
      center: opts.center ?? map.getCenter(),
      zoom: opts.zoom ?? map.getZoom(),
      pitch: opts.pitch ?? map.getPitch(),
      bearing: opts.bearing ?? map.getBearing()
    });
    return;
  }
  if (mode === 'ease') map.easeTo(opts);
  else map.flyTo(opts);
}

function typeColorExpr() {
  return [
    'match',
    ['get', '__group'],
    'conifer',
    GROUP_COLORS.conifer,
    'broadleaf',
    GROUP_COLORS.broadleaf,
    'mixed',
    GROUP_COLORS.mixed,
    GROUP_COLORS.other
  ];
}

function coverageColorExpr() {
  return [
    'match',
    ['get', '__cover'],
    'ea-lidar',
    COVER_COLORS['ea-lidar'],
    'ea-zone',
    COVER_COLORS['ea-zone'],
    'scot-lidar',
    COVER_COLORS['scot-lidar'],
    'scot-zone',
    COVER_COLORS['scot-zone'],
    'scot-gap',
    COVER_COLORS['scot-gap'],
    'wales-blocked',
    COVER_COLORS['wales-blocked'],
    'estimate',
    COVER_COLORS.estimate,
    'sample',
    COVER_COLORS.sample,
    COVER_COLORS.unknown
  ];
}

function riskColorExpr() {
  return [
    'match',
    ['get', '__windBand'],
    'LOW',
    RISK_BAND_COLORS.LOW,
    'MODERATE',
    RISK_BAND_COLORS.MODERATE,
    'ELEVATED',
    RISK_BAND_COLORS.ELEVATED,
    'HIGH',
    RISK_BAND_COLORS.HIGH,
    RISK_BAND_COLORS.NONE
  ];
}

function parcelColorExpr() {
  return [
    'case',
    ['==', ['feature-state', 'loss'], 'HIGH'],
    RISK_BAND_COLORS.HIGH,
    ['==', ['feature-state', 'loss'], 'ELEVATED'],
    RISK_BAND_COLORS.ELEVATED,
    ['==', ['feature-state', 'loss'], 'MODERATE'],
    RISK_BAND_COLORS.MODERATE,
    ['==', ['feature-state', 'loss'], 'LOW'],
    RISK_BAND_COLORS.LOW,
    ['boolean', ['feature-state', 'sel'], false],
    '#F2B63C',
    state.riskView
      ? riskColorExpr()
      : state.colorMode === 'coverage'
        ? coverageColorExpr()
        : typeColorExpr()
  ];
}

function buildStyle() {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      dark: {
        type: 'raster',
        tiles: ['https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OSM © CARTO · NFI © Forestry Commission · LiDAR © EA · FSI © Met Office (OGL)',
        maxzoom: 19
      },
      nfi: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        promoteId: '__id'
      },
      'client-guide': {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      },
      'loss-path': {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#11150E' } },
      {
        id: 'base-dark',
        type: 'raster',
        source: 'dark',
        paint: { 'raster-opacity': 0.55, 'raster-saturation': -0.4 }
      },
      {
        id: 'nfi-fill',
        type: 'fill-extrusion',
        source: 'nfi',
        paint: {
          'fill-extrusion-color': parcelColorExpr(),
          'fill-extrusion-height': [
            'case',
            ['boolean', ['feature-state', 'sel'], false],
            ['*', ['get', '__h'], 1.35],
            ['get', '__h']
          ],
          'fill-extrusion-opacity': 0.82,
          'fill-extrusion-vertical-gradient': true
        }
      },
      {
        id: 'nfi-line',
        type: 'line',
        source: 'nfi',
        paint: {
          'line-color': [
            'case',
            ['boolean', ['feature-state', 'sel'], false],
            '#F8C65C',
            '#243020'
          ],
          'line-width': ['case', ['boolean', ['feature-state', 'sel'], false], 1.6, 0.6],
          'line-opacity': 0.9
        }
      },
      {
        id: 'client-guide-fill',
        type: 'fill',
        source: 'client-guide',
        filter: ['==', ['get', 'kind'], 'radius'],
        paint: {
          'fill-color': '#F2B63C',
          'fill-opacity': 0.12
        }
      },
      {
        id: 'client-guide-line',
        type: 'line',
        source: 'client-guide',
        filter: ['==', ['get', 'kind'], 'radius'],
        paint: {
          'line-color': '#F2B63C',
          'line-width': 1.8,
          'line-opacity': 0.9,
          'line-dasharray': [2, 1.5]
        }
      },
      {
        id: 'client-guide-point',
        type: 'circle',
        source: 'client-guide',
        filter: ['==', ['get', 'kind'], 'centre'],
        paint: {
          'circle-radius': 5,
          'circle-color': '#F2B63C',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#11150E'
        }
      },
      {
        id: 'loss-path-line',
        type: 'line',
        source: 'loss-path',
        filter: ['==', ['get', 'kind'], 'path'],
        paint: {
          'line-color': [
            'match',
            ['get', 'hazard'],
            'fire',
            '#C4553B',
            '#B98A2C'
          ],
          'line-width': 3,
          'line-opacity': 0.9,
          'line-blur': 0.2
        }
      },
      {
        id: 'loss-path-start',
        type: 'circle',
        source: 'loss-path',
        filter: ['==', ['get', 'kind'], 'start'],
        paint: {
          'circle-radius': 7,
          'circle-color': '#EDE8DA',
          'circle-stroke-width': 2,
          'circle-stroke-color': [
            'match',
            ['get', 'hazard'],
            'fire',
            '#C4553B',
            '#B98A2C'
          ]
        }
      }
    ]
  };
}

export function applyColorMode() {
  if (!map || !map.getLayer('nfi-fill')) return;
  const hide = state.colorMode === 'off';
  map.setLayoutProperty('nfi-fill', 'visibility', hide ? 'none' : 'visible');
  map.setLayoutProperty('nfi-line', 'visibility', hide ? 'none' : 'visible');
  if (!hide) {
    map.setPaintProperty('nfi-fill', 'fill-extrusion-color', parcelColorExpr());
  }
  syncPickCursor();
  renderLegend();
}

function syncPickCursor() {
  if (!map) return;
  map.getCanvas().style.cursor = state.colorMode === 'off' ? 'crosshair' : '';
}

function colourModeLabel(mode) {
  if (mode === 'type') return '▣ COLOUR · FOREST TYPE';
  if (mode === 'off') return '▣ COLOUR · OFF';
  return '▣ COLOUR · PUBLIC DATA';
}

function colourModeHint(mode) {
  if (mode === 'type') {
    return 'Zoom to a wood, then click parcels to select. Click again to remove.';
  }
  if (mode === 'off') {
    return 'Woodlands hidden — click the map to set the client-link centre (lat, lon). Cycle Colour to bring parcels back.';
  }
  return 'Colours show which public LiDAR each wood can use — green England, blue Scotland, stone Wales (blocked), dark = estimate only.';
}

/**
 * Colour · off: map click sets client-link centre from the click (lat, lon into the panel).
 * Does not fly — the user already picked the spot.
 */
function pickClientLinkAt(lngLat) {
  const lon = +lngLat.lng;
  const lat = +lngLat.lat;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  const link = state.clientLink;
  link.center = [lon, lat];
  link.w3w = '';
  if (!(link.areaHa > 0)) link.areaHa = DEFAULT_CLIENT_AREA_HA;
  link.status = 'shown';
  rememberClientInHistory();
  pushClientGuide();
  if (state.live) fetchView();
  notify();
  if (window.innerWidth <= 820) {
    const panel = $('panel');
    panel.classList.add('open');
    const tog = $('panel-toggle');
    if (tog) {
      tog.setAttribute('aria-expanded', 'true');
      tog.textContent = '▼ SELECTION & VALUE';
    }
  }
  toast(`Client centre · ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
}

function renderLegend() {
  const el = $('legend');
  if (!el) return;
  if (state.lossPlay) {
    const haz = state.lossPlay.hazard === 'fire' ? 'FIRE LOSS' : 'STORM LOSS';
    el.innerHTML = `
      <span class="legend-kicker">${haz} · INDICATIVE</span>
      <span><i style="background:${RISK_BAND_COLORS.HIGH}"></i>HIGH</span>
      <span><i style="background:${RISK_BAND_COLORS.ELEVATED}"></i>ELEVATED</span>
      <span><i style="background:${RISK_BAND_COLORS.MODERATE}"></i>MODERATE</span>
      <span><i style="background:${RISK_BAND_COLORS.LOW}"></i>LOW</span>
      <span><i style="background:var(--amber)"></i>SELECTED</span>`;
    return;
  }
  if (state.colorMode === 'off') {
    el.innerHTML = `
      <span class="legend-kicker">WOODLANDS</span>
      <span>HIDDEN</span>`;
    return;
  }
  if (state.riskView) {
    el.innerHTML = `
      <span class="legend-kicker">WINDTHROW RISK</span>
      <span><i style="background:${RISK_BAND_COLORS.LOW}"></i>LOW</span>
      <span><i style="background:${RISK_BAND_COLORS.MODERATE}"></i>MODERATE</span>
      <span><i style="background:${RISK_BAND_COLORS.ELEVATED}"></i>ELEVATED</span>
      <span><i style="background:${RISK_BAND_COLORS.HIGH}"></i>HIGH</span>
      <span><i style="background:${RISK_BAND_COLORS.NONE}"></i>UNSCORED</span>
      <span><i style="background:var(--amber)"></i>SELECTED</span>`;
  } else if (state.colorMode === 'coverage') {
    const demoBit = state.live
      ? ''
      : `<span><i style="background:${COVER_COLORS.sample}"></i>DEMO</span>`;
    el.innerHTML = `
      <span class="legend-kicker">PUBLIC DATA</span>
      <span><i style="background:${COVER_COLORS['ea-zone']}"></i>ENGLAND · EA</span>
      <span><i style="background:${COVER_COLORS['scot-zone']}"></i>SCOTLAND · PARTIAL</span>
      <span><i style="background:${COVER_COLORS['scot-gap']}"></i>SCOTLAND · NO TILE</span>
      <span><i style="background:${COVER_COLORS['wales-blocked']}"></i>WALES · BLOCKED</span>
      <span><i style="background:${COVER_COLORS.estimate}"></i>ESTIMATE ONLY</span>
      ${demoBit}
      <span><i style="background:var(--amber)"></i>SELECTED</span>`;
  } else {
    el.innerHTML = `
      <span class="legend-kicker">FOREST TYPE</span>
      <span><i style="background:var(--conifer)"></i>CONIFER</span>
      <span><i style="background:var(--broadleaf)"></i>BROADLEAF</span>
      <span><i style="background:var(--mixed)"></i>MIXED</span>
      <span><i style="background:var(--other)"></i>OTHER/FELLED</span>
      <span><i style="background:var(--amber)"></i>SELECTED</span>`;
  }
}

export function pushSource() {
  if (!map) return;
  if (state.riskView) syncWindthrowProps();
  capFeatures(state.features, state.selected);
  map.getSource('nfi').setData({
    type: 'FeatureCollection',
    features: [...state.features.values()]
  });
  for (const id of state.selected.keys()) {
    map.setFeatureState({ source: 'nfi', id }, { sel: true });
  }
}

async function fetchView() {
  if (!state.live || map.getZoom() < MIN_FETCH_ZOOM) return;
  if (fetching) {
    fetchQueued = true;
    return;
  }
  fetching = true;
  try {
    const added = await queryViewport(state.layerUrl, map.getBounds(), state.features);
    if (added) pushSource();
  } catch {
    /* transient — keep what we have */
  }
  fetching = false;
  if (fetchQueued) {
    fetchQueued = false;
    fetchView();
  }
}

export function setFeatureSelected(id, sel) {
  map.setFeatureState({ source: 'nfi', id }, { sel });
}

export function clearSelectionVisuals() {
  for (const id of state.selected.keys()) {
    map.setFeatureState({ source: 'nfi', id }, { sel: false });
  }
}

export function getMap() {
  return map;
}

function selectParcelById(id) {
  const full = state.features.get(id);
  if (!full) return false;
  if (!full.enrich) full.enrich = emptyEnrich();
  applyCoverProps(
    full,
    full.enrich?.status && full.enrich.status !== 'idle' ? full.enrich : null
  );
  if (!state.selected.has(id)) {
    state.selected.set(id, selectionAgeState(full));
  }
  if (map) map.setFeatureState({ source: 'nfi', id }, { sel: true });
  enrichParcel(id);
  return true;
}

/** Push the amber guide circle + centre from `state.clientLink`. */
export function pushClientGuide() {
  if (!map || !map.getSource('client-guide')) return;
  const link = state.clientLink;
  const r = guideRadiusM(link);
  if (!link?.center || !(r > 0)) {
    map.getSource('client-guide').setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  const [lon, lat] = link.center;
  const poly = circlePolygon(lon, lat, r);
  map.getSource('client-guide').setData({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { kind: 'radius' },
        geometry: poly
      },
      {
        type: 'Feature',
        properties: { kind: 'centre' },
        geometry: { type: 'Point', coordinates: [lon, lat] }
      }
    ]
  });
}

export function clearClientGuideVisual() {
  if (!map || !map.getSource('client-guide')) return;
  map.getSource('client-guide').setData({ type: 'FeatureCollection', features: [] });
}

function fitToClientGuide() {
  const link = state.clientLink;
  const r = guideRadiusM(link);
  if (!map || !link?.center || !(r > 0)) return Promise.resolve();
  const bounds = circleBounds(link.center[0], link.center[1], r);
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      map.off('moveend', done);
      resolve();
    };
    map.on('moveend', done);
    if (prefersReducedMotion()) {
      map.fitBounds(bounds, { padding: 72, maxZoom: 14, duration: 0 });
    } else {
      map.fitBounds(bounds, { padding: 72, maxZoom: 14, duration: 900 });
    }
    // Safety if moveend already fired / no camera change.
    setTimeout(done, 1200);
  });
}

/**
 * Resolve location → draw guide → fly to it.
 * `locationRaw` is w3w or lat,lon; radius/ref read from state.clientLink (already updated by UI).
 */
export async function showClientGuide(locationRaw) {
  const link = state.clientLink;
  const result = await resolveLocation(locationRaw, state.w3wApiKey);
  if (result.error) {
    link.status = 'error';
    link.center = null;
    clearClientGuideVisual();
    notify();
    toast(result.error);
    return false;
  }
  link.center = result.center;
  if (result.w3w) link.w3w = result.w3w;
  link.status = 'shown';
  rememberClientInHistory();
  pushClientGuide();
  await fitToClientGuide();
  if (state.live) await fetchView();
  notify();
  const ha = link.areaHa > 0 ? link.areaHa : DEFAULT_CLIENT_AREA_HA;
  toast(
    result.source === 'w3w'
      ? `Guide shown · ///${result.w3w} · ${ha} ha`
      : `Guide shown · ${ha} ha`
  );
  return true;
}

/** Keep a short session list of linked client refs for search. */
export function rememberClientInHistory() {
  const link = state.clientLink;
  const ref = (link?.ref || '').trim();
  if (!ref || !link.center) return;
  const entry = {
    ref,
    w3w: (link.w3w || '').trim(),
    center: [link.center[0], link.center[1]],
    areaHa: link.areaHa > 0 ? link.areaHa : DEFAULT_CLIENT_AREA_HA
  };
  state.clientHistory = [
    entry,
    ...state.clientHistory.filter((c) => c.ref.toLowerCase() !== ref.toLowerCase())
  ].slice(0, 24);
}

/**
 * Fly the map to a search hit (place coords or bbox).
 * @param {{ center:[number,number], zoom?:number, bounds?:number[][] }} hit
 */
export function flyToSearchHit(hit) {
  if (!map || !hit?.center) return;
  const pitch = state.tilted ? 55 : 0;
  const bearing = state.tilted ? -18 : 0;
  if (hit.bounds) {
    if (prefersReducedMotion()) {
      map.fitBounds(hit.bounds, { padding: 64, maxZoom: hit.zoom ?? 13, duration: 0 });
    } else {
      map.fitBounds(hit.bounds, { padding: 64, maxZoom: hit.zoom ?? 13, duration: 1100 });
    }
    return;
  }
  cameraTo({
    center: hit.center,
    zoom: hit.zoom ?? 11.5,
    pitch,
    bearing
  });
}

/**
 * Restore a session client from history / search and show its guide.
 * @param {{ ref:string, w3w?:string, center:[number,number], areaHa?:number, radiusM?:number }} entry
 */
export async function flyToClientEntry(entry) {
  if (!entry?.center) {
    toast('That client has no saved location yet');
    return false;
  }
  const link = state.clientLink;
  link.ref = entry.ref || '';
  link.w3w = entry.w3w || '';
  link.center = [entry.center[0], entry.center[1]];
  const fromHa = clampAreaHa(entry.areaHa);
  const fromRadius =
    entry.radiusM > 0 ? clampAreaHa(radiusMToHa(entry.radiusM)) : null;
  link.areaHa = fromHa || fromRadius || DEFAULT_CLIENT_AREA_HA;
  link.status = 'shown';
  rememberClientInHistory();
  pushClientGuide();
  await fitToClientGuide();
  if (state.live) await fetchView();
  notify();
  toast(`Client · ${link.ref}`);
  return true;
}

/** Add every loaded parcel that touches the guide circle to the selection. */
export async function selectParcelsTouchingGuide() {
  const link = state.clientLink;
  const r = guideRadiusM(link);
  if (!link?.center || !(r > 0)) {
    toast('Show the w3w guide first');
    return 0;
  }
  pushClientGuide();
  await fitToClientGuide();
  if (state.live) await fetchView();

  let added = 0;
  for (const [id, f] of state.features) {
    if (state.selected.has(id)) continue;
    if (!geometryTouchesCircle(f.geometry, link.center, r)) continue;
    if (selectParcelById(id)) added++;
  }
  pushSource();
  if (window.innerWidth <= 820 && added) {
    const panel = $('panel');
    panel.classList.add('open');
    const tog = $('panel-toggle');
    if (tog) {
      tog.setAttribute('aria-expanded', 'true');
      tog.textContent = '▼ SELECTION & VALUE';
    }
  }
  notify();
  if (!added) {
    toast('No loaded parcels touch the guide — zoom or widen the area');
  } else {
    toast(`Selected ${added} parcel${added > 1 ? 's' : ''} that touch the guide`);
  }
  return added;
}

export function resetClientLink() {
  Object.assign(state.clientLink, emptyClientLink());
  clearClientGuideVisual();
  notify();
}

let lossAnimToken = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pushLossPathGeo(coords, hazard, partial = true) {
  if (!map || !map.getSource('loss-path')) return;
  const features = [];
  if (coords.length >= 2) {
    features.push({
      type: 'Feature',
      properties: { kind: 'path', hazard },
      geometry: { type: 'LineString', coordinates: coords }
    });
  } else if (coords.length === 1 && partial) {
    features.push({
      type: 'Feature',
      properties: { kind: 'path', hazard },
      geometry: { type: 'LineString', coordinates: [coords[0], coords[0]] }
    });
  }
  if (coords.length) {
    features.push({
      type: 'Feature',
      properties: { kind: 'start', hazard },
      geometry: { type: 'Point', coordinates: coords[0] }
    });
  }
  map.getSource('loss-path').setData({ type: 'FeatureCollection', features });
}

export function clearLossPlay() {
  lossAnimToken++;
  if (state.lossPlay?.pathIds && map) {
    for (const id of state.lossPlay.pathIds) {
      try {
        map.removeFeatureState({ source: 'nfi', id }, 'loss');
      } catch {
        /* feature may be gone */
      }
    }
  }
  if (map?.getSource('loss-path')) {
    map.getSource('loss-path').setData({ type: 'FeatureCollection', features: [] });
  }
  state.lossPlay = null;
  applyColorMode();
  notify();
}

/**
 * Play an indicative storm path or fire spread across the selection.
 * @param {'storm'|'fire'} hazard
 * @param {'random'|'worst'|string} choice
 */
export async function playLossScenario(hazard, choice = 'random') {
  if (!state.selected.size) {
    toast('Select parcels first — loss plays across the selection');
    return null;
  }
  if (state.colorMode === 'off') {
    state.colorMode = 'coverage';
    applyColorMode();
    const btn = $('btn-colour');
    if (btn) {
      btn.textContent = colourModeLabel('coverage');
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
    }
  }

  clearLossPlay();
  const token = ++lossAnimToken;
  const scenario = pickScenario(hazard, choice);
  if (!scenario) {
    toast('No loss scenarios configured');
    return null;
  }

  const built = buildLossPath(hazard, scenario);
  if (!built.path.length) {
    toast('Could not build a path through the selection');
    return null;
  }

  state.lossPlay = {
    running: true,
    hazard,
    scenario,
    pathIds: built.path.map((s) => s.id),
    summary: null,
    runningLoss: 0,
    runningSi: 0
  };
  applyColorMode();
  notify();

  const reduced = prefersReducedMotion();
  const stepMs = reduced
    ? 0
    : state.rates.loss?.stepMs ?? DEFAULT_LOSS.stepMs;
  const coords = [];

  for (const step of built.path) {
    if (token !== lossAnimToken) return null;
    coords.push(step.center);
    map?.setFeatureState({ source: 'nfi', id: step.id }, { loss: step.tier });
    pushLossPathGeo(coords, hazard);
    const L = lossForStep(step, scenario);
    state.lossPlay.runningLoss += L.lossGbp;
    state.lossPlay.runningSi += L.siGbp;
    notify();
    if (stepMs > 0) await sleep(stepMs);
  }

  if (token !== lossAnimToken) return null;

  const summary = summariseLoss(built.path, scenario, hazard);
  state.lossPlay = {
    running: false,
    hazard,
    scenario,
    pathIds: built.path.map((s) => s.id),
    summary,
    runningLoss: summary.lossTotal,
    runningSi: summary.siTotal
  };
  applyColorMode();
  notify();
  toast(
    `${hazard === 'fire' ? 'Fire' : 'Storm'} · ${scenario.label} · indicative loss ${formatLossGbp(summary.lossTotal)}`
  );
  return summary;
}

function formatLossGbp(n) {
  return '£' + Math.round(n).toLocaleString('en-GB');
}

function markNfiOffline(reasonToast = true) {
  state.live = false;
  state.layerUrl = null;
  setPill('pill-nfi', 'warn', 'NFI · OFFLINE — SAMPLE DATA');
  const hint = $('hint');
  if (hint) {
    hint.textContent =
      `Live NFI unavailable — showing built-in sample parcels around ${SAMPLE_LABEL}. Selection and valuation work the same.`;
  }
  if (reasonToast) toast('Live NFI unavailable — using sample parcels');
  loadDemo(state.features);
  if (map && map.loaded && map.loaded()) {
    pushSource();
    cameraTo({ ...SAMPLE, pitch: 55, bearing: -18 });
  }
}

/** Start NFI discovery immediately; do not wait for map style load. */
async function connectNFI() {
  try {
    state.layerUrl = await discoverNFI();
    state.live = true;
    setPill('pill-nfi', 'ok', 'NFI · LIVE');
    toast('Connected to the live National Forest Inventory');
    if (map && map.loaded && map.loaded()) fetchView();
  } catch (err) {
    console.warn('NFI discovery failed', err);
    markNfiOffline(true);
  }
}

export function initMap() {
  // NFI discovery is independent of the map library.
  const nfiReady = connectNFI();
  initEnrichmentPills();

  if (typeof maplibregl === 'undefined') {
    setPill('pill-base', 'warn', 'BASEMAP · UNAVAILABLE');
    loadDemo(state.features);
    return null;
  }

  map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(),
    center: START.center,
    zoom: START.zoom,
    pitch: 55,
    bearing: -18,
    antialias: true,
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.on('error', () => {
    /* swallow tile errors so a blocked basemap doesn't blank the map */
  });

  map.on('load', async () => {
    applySatelliteBasemap();
    applyColorMode();
    await nfiReady;
    if (state.live) {
      pushSource();
      applyColorMode();
      fetchView();
    } else {
      if (![...state.features.keys()].some((id) => String(id).startsWith('demo-'))) {
        loadDemo(state.features);
      }
      pushSource();
      cameraTo({
        ...SAMPLE,
        pitch: state.tilted ? 55 : 0,
        bearing: state.tilted ? -18 : 0
      });
    }
  });

  map.on('moveend', fetchView);

  map.on('mouseenter', 'nfi-fill', () => {
    if (state.colorMode === 'off') return;
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'nfi-fill', () => {
    syncPickCursor();
  });

  map.on('click', 'nfi-fill', (e) => {
    if (state.colorMode === 'off') return;
    const f = e.features && e.features[0];
    if (!f) return;
    const id = f.properties.__id;
    if (state.selected.has(id)) {
      state.selected.delete(id);
      map.setFeatureState({ source: 'nfi', id }, { sel: false });
    } else {
      const full = state.features.get(id);
      if (full && !full.enrich) full.enrich = emptyEnrich();
      if (full) {
        applyCoverProps(
          full,
          full.enrich?.status && full.enrich.status !== 'idle' ? full.enrich : null
        );
      }
      state.selected.set(id, selectionAgeState(full || f));
      map.setFeatureState({ source: 'nfi', id }, { sel: true });
      enrichParcel(id);
      if (window.innerWidth <= 820) {
        const panel = $('panel');
        panel.classList.add('open');
        const tog = $('panel-toggle');
        if (tog) {
          tog.setAttribute('aria-expanded', 'true');
          tog.textContent = '▼ SELECTION & VALUE';
        }
      }
      pushSource();
    }
    notify();
  });

  /* Colour · off: click any spot → client-link lat, lon (+ guide). */
  map.on('click', (e) => {
    if (state.colorMode !== 'off') return;
    pickClientLinkAt(e.lngLat);
  });

  syncPickCursor();
  return map;
}

export function bindMapControls() {
  if (!map) return;

  $('btn-tilt').onclick = () => {
    state.tilted = !state.tilted;
    cameraTo(
      {
        pitch: state.tilted ? 55 : 0,
        bearing: state.tilted ? -18 : 0,
        duration: 600
      },
      'ease'
    );
    $('btn-tilt').textContent = state.tilted ? '◪ TILT · ON' : '◪ TILT · OFF';
    $('btn-tilt').classList.toggle('active', state.tilted);
    $('btn-tilt').setAttribute('aria-pressed', state.tilted);
    setPill('pill-mode', state.tilted ? 'ok' : '', state.tilted ? '2.5D' : 'FLAT');
  };

  $('btn-sat').onclick = () => {
    state.satellite = !state.satellite;
    applySatelliteBasemap();
  };

  $('btn-demo').onclick = () =>
    cameraTo({
      ...SAMPLE,
      pitch: state.tilted ? 55 : 0,
      bearing: state.tilted ? -18 : 0
    });
  if ($('btn-demo')) {
    $('btn-demo').textContent = `✦ FLY TO ${SAMPLE_LABEL.toUpperCase()}`;
  }

  $('btn-clear').onclick = () => {
    clearLossPlay();
    clearSelectionVisuals();
    state.selected.clear();
    notify();
  };

  const btnColour = $('btn-colour');
  if (btnColour) {
    btnColour.onclick = () => {
      state.colorMode =
        state.colorMode === 'coverage'
          ? 'type'
          : state.colorMode === 'type'
            ? 'off'
            : 'coverage';
      btnColour.textContent = colourModeLabel(state.colorMode);
      btnColour.classList.toggle('active', state.colorMode === 'coverage');
      btnColour.setAttribute('aria-pressed', state.colorMode !== 'off');
      applyColorMode();
      if (!state.riskView || state.colorMode === 'off') {
        const hint = $('hint');
        if (hint) hint.textContent = colourModeHint(state.colorMode);
      }
    };
  }

  const btnRisk = $('btn-risk');
  if (btnRisk) {
    btnRisk.onclick = () => {
      state.riskView = !state.riskView;
      btnRisk.textContent = state.riskView ? '◈ RISK VIEW · ON' : '◈ RISK VIEW · OFF';
      btnRisk.classList.toggle('active', state.riskView);
      btnRisk.setAttribute('aria-pressed', state.riskView);
      if (state.riskView) syncWindthrowProps();
      pushSource();
      applyColorMode();
      const hint = $('hint');
      if (hint) {
        hint.textContent =
          state.colorMode === 'off'
            ? colourModeHint('off')
            : state.riskView
              ? 'Colours show windthrow risk bands (ForestGALES-inspired). Selection stays amber. Change storm scenario in model assumptions.'
              : colourModeHint(state.colorMode);
      }
      notify();
    };
  }

  $('panel-toggle').onclick = () => {
    const panel = $('panel');
    panel.classList.toggle('open');
    const open = panel.classList.contains('open');
    $('panel-toggle').setAttribute('aria-expanded', open);
    $('panel-toggle').textContent = open ? '▼ SELECTION & VALUE' : '▲ SELECTION & VALUE';
  };

  renderLegend();
}
