/** Collapse / expand the two map overlays (masthead + selection panel). */

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

function syncMasthead() {
  const masthead = $('masthead');
  const body = $('masthead-body');
  const collapsed = masthead?.classList.contains('collapsed');
  if (body) body.hidden = !!collapsed;
  syncToggle($('masthead-toggle'), collapsed, 'Expand atlas', 'Collapse atlas');
  if (collapsed) hideResults();
}

function syncPanel() {
  const panel = $('panel');
  const collapsed = panel?.classList.contains('collapsed');
  document.body.classList.toggle('panel-collapsed', !!collapsed);
  syncToggle($('panel-collapse'), collapsed, 'Expand selection', 'Collapse selection');
}

export function initChrome() {
  const masthead = $('masthead');
  const mastToggle = $('masthead-toggle');
  const panel = $('panel');
  const panelToggle = $('panel-collapse');

  mastToggle?.addEventListener('click', () => {
    masthead?.classList.toggle('collapsed');
    syncMasthead();
  });

  panelToggle?.addEventListener('click', () => {
    panel?.classList.toggle('collapsed');
    syncPanel();
  });

  syncMasthead();
  syncPanel();
}
