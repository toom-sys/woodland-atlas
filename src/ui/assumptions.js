import { state, AGES, STORM_SCENARIOS, FSI_LEVELS, notify } from '../state.js';
import { syncWindthrowProps } from '../scoring/windthrow.js';
import { syncFireProps } from '../scoring/fire.js';
import { refreshFsiPillFromState } from '../data/fsi.js';

const $ = (id) => document.getElementById(id);

function onWindthrowChange() {
  syncWindthrowProps();
  import('../map.js')
    .then((m) => {
      if (state.riskView) m.pushSource();
      m.applyColorMode?.();
    })
    .catch(() => {});
  notify();
}

function onFireChange() {
  syncFireProps();
  refreshFsiPillFromState();
  notify();
}

export function buildAssumeUI() {
  const tg = $('timber-grid');
  for (const [ageKey, ageLbl] of AGES) {
    const lbl = document.createElement('span');
    lbl.className = 'rowlbl';
    lbl.textContent = ageLbl.split(' ')[0].toUpperCase();
    tg.appendChild(lbl);
    for (const g of ['conifer', 'broadleaf', 'mixed']) {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = 100;
      inp.value = state.rates.timber[g][ageKey];
      inp.oninput = () => {
        state.rates.timber[g][ageKey] = +inp.value || 0;
        notify();
      };
      inp.setAttribute('aria-label', `Timber £/ha, ${g}, ${ageKey}`);
      tg.appendChild(inp);
    }
  }
  $('rate-land').value = state.rates.land;
  $('rate-land').oninput = (e) => {
    state.rates.land = +e.target.value || 0;
    notify();
  };
  $('rate-cprice').value = state.rates.cprice;
  $('rate-cprice').oninput = (e) => {
    state.rates.cprice = +e.target.value || 0;
    notify();
  };
  const sg = $('seq-grid');
  for (const [ageKey] of AGES) {
    const d = document.createElement('div');
    d.innerHTML = `<label>SEQ ${ageKey.toUpperCase()} t/ha/yr</label>`;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = 0.5;
    inp.value = state.rates.seq[ageKey];
    inp.oninput = () => {
      state.rates.seq[ageKey] = +inp.value || 0;
      notify();
    };
    d.appendChild(inp);
    sg.appendChild(d);
  }

  buildWindthrowUI();
  buildFireUI();
  buildLossUI();
}

/** Indicative loss tier fractions — editable, no magic numbers in scoring. */
function buildLossUI() {
  const fireRoot = $('fire-assume');
  if (!fireRoot?.parentElement) return;
  const root = fireRoot.parentElement;
  const loss = state.rates.loss;
  if (!loss) return;

  const h = document.createElement('h4');
  h.textContent = 'SHOW A LOSS · SI FRACTIONS';
  root.appendChild(h);

  const note = document.createElement('p');
  note.className = 'assume-note';
  note.textContent =
    'Indicative only. Loss = capital (timber + land) × tier fraction × scenario multiplier. Three example storms and three fires; one of each is worst case.';
  root.appendChild(note);

  const grid = document.createElement('div');
  grid.className = 'pair weight-grid';
  for (const [key, label] of [
    ['LOW', 'LOW'],
    ['MODERATE', 'MOD'],
    ['ELEVATED', 'ELEV'],
    ['HIGH', 'HIGH']
  ]) {
    const d = document.createElement('div');
    d.innerHTML = `<label>${label}</label>`;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = 0.05;
    inp.min = 0;
    inp.max = 1;
    inp.value = loss.tierFraction[key];
    inp.setAttribute('aria-label', `Loss fraction ${label}`);
    inp.oninput = () => {
      loss.tierFraction[key] = +inp.value || 0;
      notify();
    };
    d.appendChild(inp);
    grid.appendChild(d);
  }
  root.appendChild(grid);
}

function buildWindthrowUI() {
  const root = $('windthrow-assume');
  if (!root) return;
  const wt = state.rates.windthrow;

  const scenario = document.createElement('div');
  scenario.className = 'assume-block';
  scenario.innerHTML = `<label for="storm-scenario">Storm direction scenario</label>`;
  const sel = document.createElement('select');
  sel.id = 'storm-scenario';
  sel.setAttribute('aria-label', 'Storm direction scenario');
  for (const [k, label] of STORM_SCENARIOS) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = label;
    if (k === wt.stormScenario) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onchange = () => {
    wt.stormScenario = sel.value;
    onWindthrowChange();
  };
  scenario.appendChild(sel);
  const note = document.createElement('p');
  note.className = 'assume-note';
  note.textContent =
    'Root systems acclimate to prevailing south-westerlies. Northerly (Arwen-type) loads stands from their untrained direction. This is ForestGALES-inspired, not ForestGALES.';
  scenario.appendChild(note);
  root.appendChild(scenario);

  const weightsWrap = document.createElement('div');
  weightsWrap.className = 'assume-block';
  weightsWrap.innerHTML = `<label>Windthrow weights (normalised on score)</label>`;
  const grid = document.createElement('div');
  grid.className = 'pair weight-grid';
  const weightKeys = [
    ['height', 'HEIGHT'],
    ['species', 'SPECIES'],
    ['exposure', 'EXPOSURE'],
    ['age', 'AGE'],
    ['direction', 'DIRECTION']
  ];
  for (const [key, label] of weightKeys) {
    const d = document.createElement('div');
    d.innerHTML = `<label>${label}</label>`;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = 0.05;
    inp.min = 0;
    inp.max = 1;
    inp.value = wt.weights[key];
    inp.setAttribute('aria-label', `Windthrow weight ${label}`);
    inp.oninput = () => {
      wt.weights[key] = +inp.value || 0;
      onWindthrowChange();
    };
    d.appendChild(inp);
    grid.appendChild(d);
  }
  weightsWrap.appendChild(grid);
  root.appendChild(weightsWrap);
}

function buildFireUI() {
  const root = $('fire-assume');
  if (!root) return;
  const fire = state.rates.fire;

  const fsiBlock = document.createElement('div');
  fsiBlock.className = 'assume-block';
  fsiBlock.innerHTML = `<label for="fsi-manual">Current FSI level (manual)</label>`;
  const sel = document.createElement('select');
  sel.id = 'fsi-manual';
  sel.setAttribute('aria-label', 'Current FSI level (manual)');
  for (const [level, label] of FSI_LEVELS) {
    const opt = document.createElement('option');
    opt.value = String(level);
    opt.textContent = label;
    if (level === fire.fsiLevelManual) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onchange = () => {
    fire.fsiLevelManual = +sel.value || 2;
    onFireChange();
  };
  fsiBlock.appendChild(sel);
  const fsiNote = document.createElement('p');
  fsiNote.className = 'assume-note';
  fsiNote.textContent =
    'Used when the Met Office / Natural England FSI feed is unreachable. Live grid ratings override this per parcel when available. Pill reads FSI · MANUAL in fallback.';
  fsiBlock.appendChild(fsiNote);
  root.appendChild(fsiBlock);

  const blendWrap = document.createElement('div');
  blendWrap.className = 'assume-block';
  blendWrap.innerHTML = `<label>Susceptibility / FSI blend</label>`;
  const blendGrid = document.createElement('div');
  blendGrid.className = 'pair weight-grid';
  for (const [key, label] of [
    ['susceptibilityBlend', 'SUSCEPT.'],
    ['fsiBlend', 'FSI']
  ]) {
    const d = document.createElement('div');
    d.innerHTML = `<label>${label}</label>`;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = 0.05;
    inp.min = 0;
    inp.max = 1;
    inp.value = fire[key];
    inp.setAttribute('aria-label', `Fire blend ${label}`);
    inp.oninput = () => {
      fire[key] = +inp.value || 0;
      onFireChange();
    };
    d.appendChild(inp);
    blendGrid.appendChild(d);
  }
  blendWrap.appendChild(blendGrid);
  root.appendChild(blendWrap);

  const weightsWrap = document.createElement('div');
  weightsWrap.className = 'assume-block';
  weightsWrap.innerHTML = `<label>Susceptibility weights (normalised)</label>`;
  const grid = document.createElement('div');
  grid.className = 'pair weight-grid';
  const weightKeys = [
    ['fuel', 'FUEL'],
    ['slopeAspect', 'SLOPE'],
    ['continuity', 'SIZE'],
    ['ignition', 'IGNITION']
  ];
  for (const [key, label] of weightKeys) {
    const d = document.createElement('div');
    d.innerHTML = `<label>${label}</label>`;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = 0.05;
    inp.min = 0;
    inp.max = 1;
    inp.value = fire.weights[key];
    inp.setAttribute('aria-label', `Fire weight ${label}`);
    inp.oninput = () => {
      fire.weights[key] = +inp.value || 0;
      onFireChange();
    };
    d.appendChild(inp);
    grid.appendChild(d);
  }
  weightsWrap.appendChild(grid);
  root.appendChild(weightsWrap);
}
