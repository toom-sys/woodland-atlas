/**
 * Masthead search: GB places (geocode) + session group refs.
 */

import { state, SAMPLE, SAMPLE_LABEL } from '../state.js';
import { searchPlaces, parseDirectLocation } from '../data/geocode.js';
import { flyToSearchHit, flyToClientEntry } from '../map.js';
import { toast } from './pills.js';

const $ = (id) => document.getElementById(id);

let debounceT = null;
let activeIdx = -1;
let currentHits = [];
let reqId = 0;

function clientHits(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 1) return [];
  const seen = new Set();
  const out = [];

  const consider = (entry) => {
    if (!entry?.ref) return;
    const key = entry.ref.toLowerCase();
    if (seen.has(key)) return;
    if (!key.includes(q)) return;
    if (!entry.center) return;
    seen.add(key);
    out.push({
      id: `client-${key}`,
      kind: 'client',
      kindLabel: 'group',
      label: entry.ref,
      name: entry.ref,
      center: entry.center,
      areaHa: entry.areaHa,
      radiusM: entry.radiusM,
      source: 'client'
    });
  };

  // Current group first if it matches.
  const cur = state.clientLink;
  if (cur?.ref && cur.center) {
    consider({
      ref: cur.ref,
      center: cur.center,
      areaHa: cur.areaHa
    });
  }
  for (const c of state.clientHistory) consider(c);
  return out.slice(0, 6);
}

function builtinHits(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const label = SAMPLE_LABEL.toLowerCase();
  if (!label.includes(q) && !q.includes('dalby')) return [];
  return [
    {
      id: 'builtin-sample',
      kind: 'place',
      kindLabel: 'woodland',
      label: `${SAMPLE_LABEL}, North Yorkshire`,
      name: SAMPLE_LABEL,
      center: SAMPLE.center,
      zoom: SAMPLE.zoom,
      source: 'builtin'
    }
  ];
}

function renderResults(hits, meta = {}) {
  const list = $('search-results');
  const input = $('search-input');
  if (!list) return;
  currentHits = hits;
  activeIdx = hits.length ? 0 : -1;

  if (!hits.length) {
    if (meta.emptyMessage) {
      list.hidden = false;
      list.innerHTML = `<li class="search-empty" role="presentation">${meta.emptyMessage}</li>`;
      input?.setAttribute('aria-expanded', 'true');
    } else {
      list.hidden = true;
      list.innerHTML = '';
      input?.setAttribute('aria-expanded', 'false');
    }
    return;
  }

  list.hidden = false;
  input?.setAttribute('aria-expanded', 'true');
  list.innerHTML = hits
    .map(
      (h, i) => `
    <li role="option" id="search-opt-${i}" class="search-option${i === 0 ? ' active' : ''}" data-idx="${i}" aria-selected="${i === 0}">
      <span class="search-kind">${h.kindLabel}</span>
      <span class="search-label">${escapeHtml(h.label)}</span>
    </li>`
    )
    .join('');

  list.querySelectorAll('.search-option').forEach((el) => {
    el.onmousedown = (e) => {
      e.preventDefault();
      pickHit(+el.dataset.idx);
    };
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setActive(idx) {
  const list = $('search-results');
  if (!list || !currentHits.length) return;
  activeIdx = ((idx % currentHits.length) + currentHits.length) % currentHits.length;
  list.querySelectorAll('.search-option').forEach((el, i) => {
    const on = i === activeIdx;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const active = list.querySelector('.search-option.active');
  active?.scrollIntoView({ block: 'nearest' });
}

function hideResults() {
  const list = $('search-results');
  if (!list) return;
  list.hidden = true;
  list.innerHTML = '';
  currentHits = [];
  activeIdx = -1;
  $('search-input')?.setAttribute('aria-expanded', 'false');
}

async function runSearch(raw) {
  const q = raw.trim();
  const myId = ++reqId;
  if (q.length < 2) {
    hideResults();
    return;
  }

  const hits = [...clientHits(q), ...builtinHits(q)];
  const direct = parseDirectLocation(q);
  if (direct) hits.unshift(direct);

  renderResults(hits.length ? hits : [], {
    emptyMessage: hits.length ? null : 'Searching…'
  });

  const { results, error } = await searchPlaces(q);
  if (myId !== reqId) return;

  const merged = [...clientHits(q), ...builtinHits(q)];
  if (direct) merged.unshift(direct);
  // Dedupe places by approx centre
  const seen = new Set(merged.map((h) => h.id));
  for (const r of results) {
    if (seen.has(r.id)) continue;
    const key = `${r.center[0].toFixed(3)},${r.center[1].toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(r.id);
    seen.add(key);
    merged.push(r);
  }

  if (!merged.length) {
    renderResults([], {
      emptyMessage: error || 'No places or clients matched'
    });
    if (error) toast(error);
    return;
  }
  renderResults(merged.slice(0, 10));
}

async function pickHit(idx) {
  const hit = currentHits[idx];
  if (!hit) return;
  hideResults();
  const input = $('search-input');
  if (input) input.value = hit.label;

  if (hit.source === 'client') {
    await flyToClientEntry({
      ref: hit.name,
      center: hit.center,
      areaHa: hit.areaHa,
      radiusM: hit.radiusM
    });
    return;
  }

  flyToSearchHit(hit);
  toast(hit.label);
}

export function initSearch() {
  const input = $('search-input');
  const list = $('search-results');
  if (!input || !list) return;

  input.addEventListener('input', () => {
    clearTimeout(debounceT);
    const v = input.value;
    debounceT = setTimeout(() => runSearch(v), 280);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (currentHits.length) setActive(activeIdx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (currentHits.length) setActive(activeIdx - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0) pickHit(activeIdx);
      else if (input.value.trim().length >= 2) runSearch(input.value).then(() => {
        if (currentHits.length) pickHit(0);
      });
    } else if (e.key === 'Escape') {
      hideResults();
      input.blur();
    }
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2 && currentHits.length) {
      $('search-results').hidden = false;
    }
  });

  document.addEventListener('click', (e) => {
    const root = $('search');
    if (root && !root.contains(e.target)) hideResults();
  });
}
