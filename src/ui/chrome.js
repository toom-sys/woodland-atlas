/** Group / ungroup map overlays (atlas, map tools, selection panel). */

import { hideResults } from './search.js';

const $ = (id) => document.getElementById(id);

const GLYPH_EXPANDED = '▾';
const GLYPH_COLLAPSED = '▸';

function syncToggle(btn, collapsed, expandLabel, collapseLabel) {
  if (!btn) return;
  btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  btn.setAttribute('aria-label', collapsed ? expandLabel : collapseLabel);
  btn.textContent = collapsed ? GLYPH_COLLAPSED : GLYPH_EXPANDED;
}

function bindBarFold(root, sync) {
  const bar = root?.querySelector('.chrome-bar');
  bar?.addEventListener('click', (e) => {
    e.preventDefault();
    root.classList.toggle('collapsed');
    sync();
  });
}

function syncMasthead() {
  const masthead = $('masthead');
  const body = $('masthead-body');
  const collapsed = masthead?.classList.contains('collapsed');
  if (body) body.hidden = !!collapsed;
  syncToggle($('masthead-toggle'), collapsed, 'Expand atlas', 'Collapse atlas');
  if (collapsed) hideResults();
}

function syncMapTools() {
  const root = $('map-tools');
  const body = $('map-tools-body');
  const collapsed = root?.classList.contains('collapsed');
  if (body) body.hidden = !!collapsed;
  syncToggle($('map-tools-toggle'), collapsed, 'Expand map tools', 'Collapse map tools');
}

function syncPanel() {
  const panel = $('panel');
  const collapsed = panel?.classList.contains('collapsed');
  document.body.classList.toggle('panel-collapsed', !!collapsed);
  syncToggle($('panel-collapse'), collapsed, 'Expand selection', 'Collapse selection');
}

export function initChrome() {
  const masthead = $('masthead');
  const mapTools = $('map-tools');
  const panel = $('panel');
  const panelToggle = $('panel-collapse');
  const panelHead = panel?.querySelector('.panel-head');

  bindBarFold(masthead, syncMasthead);
  bindBarFold(mapTools, syncMapTools);

  panelToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    panel?.classList.toggle('collapsed');
    syncPanel();
  });

  panelHead?.addEventListener('click', () => {
    if (!panel?.classList.contains('collapsed')) return;
    panel.classList.remove('collapsed');
    syncPanel();
  });

  syncMasthead();
  syncMapTools();
  syncPanel();
}
