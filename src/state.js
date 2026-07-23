/** Shared app state + pub/sub render trigger. In-memory only — no persistence. */

/** North York Moors overview — real NFI woodland nearby. */
/** Initial camera — Dalby Forest (North Yorkshire). */
export const START = { center: [-0.677, 54.283], zoom: 12.8 };
/**
 * Dalby Forest (North Yorkshire) — well-known FC woodland for the fly-to control.
 * Offline demo parcels are also centred here when NFI is unreachable.
 */
export const SAMPLE = { center: [-0.677, 54.283], zoom: 12.8 };
export const SAMPLE_LABEL = 'Dalby Forest';
export const MIN_FETCH_ZOOM = 11.3;
export const HEIGHT_X = 6;

export const GROUP_COLORS = {
  conifer: '#3E7C4F',
  broadleaf: '#8FBF6F',
  mixed: '#6BA35B',
  other: '#4A5340'
};

/** Default map colour mode: public-data coverage (showcase) or forest type. */
export const AGES = [
  ['young', 'Young (<15y)'],
  ['establishing', 'Establishing (15–30y)'],
  ['semi', 'Semi-mature (30–60y)'],
  ['mature', 'Mature (60y+)']
];

/** Default windthrow model knobs — all editable in assumptions (SPEC §4.1). */
export const DEFAULT_WINDTHROW = {
  weights: {
    height: 0.3,
    species: 0.2,
    exposure: 0.2,
    age: 0.15,
    direction: 0.15
  },
  /** Estimated canopy (m) when no LiDAR — type × age table. */
  estimatedCanopyM: {
    conifer: { young: 6, establishing: 14, semi: 22, mature: 28 },
    broadleaf: { young: 5, establishing: 12, semi: 18, mature: 24 },
    mixed: { young: 5.5, establishing: 13, semi: 20, mature: 26 },
    other: { young: 2, establishing: 3, semi: 4, mature: 5 }
  },
  heightFloorM: 10,
  heightCeilM: 28,
  elevFloorM: 50,
  elevCeilM: 450,
  exposureBlend: 0.6,
  elevBlend: 0.4,
  species: { conifer: 0.9, mixed: 0.6, broadleaf: 0.35, other: 0.05 },
  age: { young: 0.2, establishing: 0.5, semi: 0.9, mature: 0.7 },
  directionSwBaseline: 0.3,
  /** 'sw' | 'northerly' | 'any' */
  stormScenario: 'sw'
};

export const STORM_SCENARIOS = [
  ['sw', 'Prevailing SW (default)'],
  ['northerly', 'Northerly (Arwen-type)'],
  ['any', 'Any (worst case)']
];

/** Default fire model knobs — all editable in assumptions (SPEC §4.2). */
export const DEFAULT_FIRE = {
  weights: {
    fuel: 0.45,
    slopeAspect: 0.25,
    continuity: 0.15,
    ignition: 0.15
  },
  /** Susceptibility vs FSI blend on the final score. */
  susceptibilityBlend: 0.55,
  fsiBlend: 0.45,
  fuel: {
    conifer: 0.9,
    young: 0.8,
    mixed: 0.55,
    broadleaf: 0.3,
    felled: 0.6,
    other: 0.4
  },
  defaultSlopeAspect: 0.3,
  southAspectMin: 135,
  southAspectMax: 225,
  aspectMax: 0.6,
  slopeFloorDeg: 0,
  slopeCeilDeg: 25,
  slopeMax: 0.4,
  haFloor: 1,
  haCeil: 100,
  haContribFloor: 0.2,
  haContribCeil: 0.9,
  ignitionAssumed: 0.5,
  /** Used when live FSI is unreachable (SPEC §3.5). */
  fsiLevelManual: 2
};

export const FSI_LEVELS = [
  [1, '1 — Very low'],
  [2, '2 — Low (default)'],
  [3, '3 — Moderate'],
  [4, '4 — High'],
  [5, '5 — Exceptional']
];

/**
 * Indicative "show a loss" knobs — illustration only, not a claims model.
 * Three example storms and three example fires; one of each is worst case.
 */
export const DEFAULT_LOSS = {
  /** SI basis: capital = timber + land (sum insured proxy). */
  siBasis: 'capital',
  /** Fraction of SI written off at each severity tier (before scenario multiplier). */
  tierFraction: {
    LOW: 0.08,
    MODERATE: 0.28,
    ELEVATED: 0.55,
    HIGH: 0.85
  },
  storms: [
    {
      id: 'sw',
      label: 'Prevailing SW',
      severity: 'moderate',
      multiplier: 0.55,
      bearing: 225
    },
    {
      id: 'arwen',
      label: 'Northerly (Arwen-type)',
      severity: 'severe',
      multiplier: 0.82,
      bearing: 20
    },
    {
      id: 'worst-storm',
      label: 'Worst case (any direction)',
      severity: 'worst',
      multiplier: 1,
      bearing: null
    }
  ],
  fires: [
    {
      id: 'ground',
      label: 'Contained ground fire',
      severity: 'moderate',
      multiplier: 0.5,
      fsi: 3
    },
    {
      id: 'crown',
      label: 'Crown fire run',
      severity: 'severe',
      multiplier: 0.8,
      fsi: 4
    },
    {
      id: 'worst-fire',
      label: 'Worst case (FSI 5)',
      severity: 'worst',
      multiplier: 1,
      fsi: 5
    }
  ],
  /** Animation step (ms); ignored when prefers-reduced-motion. */
  stepMs: 220,
  maxParcels: 40
};

export const RISK_BAND_COLORS = {
  LOW: '#7C8A6A',
  MODERATE: '#A89B5C',
  ELEVATED: '#B98A2C',
  HIGH: '#C4553B',
  NONE: '#4A5340'
};

/** Default guide area (ha) — converted to a circle radius for the map. ~80 ha ≈ 500 m radius. */
export const DEFAULT_CLIENT_AREA_HA = 80;

export const state = {
  rates: {
    timber: {
      conifer: { young: 800, establishing: 3000, semi: 7000, mature: 14000 },
      broadleaf: { young: 300, establishing: 1200, semi: 3000, mature: 7000 },
      mixed: { young: 550, establishing: 2100, semi: 5000, mature: 10500 },
      other: { young: 0, establishing: 0, semi: 0, mature: 0 }
    },
    land: 9000,
    cprice: 25,
    seq: { young: 5, establishing: 9, semi: 6, mature: 2.5 },
    /** Soft UI nudge when measured canopy exceeds age-band expectation (SPEC §5). */
    heightPlausibilityMaxM: {
      young: 20,
      establishing: 28,
      semi: 40,
      mature: 55
    },
    windthrow: structuredClone(DEFAULT_WINDTHROW),
    fire: structuredClone(DEFAULT_FIRE),
    loss: structuredClone(DEFAULT_LOSS)
  },
  features: new Map(),
  selected: new Map(),
  live: false,
  layerUrl: null,
  satellite: true,
  tilted: true,
  /** 'coverage' | 'type' | 'off' — off hides NFI woodland layers */
  colorMode: 'coverage',
  /** When true, extrusions recolour by windthrow band (selection stays amber). */
  riskView: false,
  /**
   * Session-only client link (opaque typed ref + optional w3w/area guide).
   * User edits area in hectares; circle radius is derived for the map.
   * No Recorder fetch; never persisted. See SPEC §6.1.
   */
  clientLink: {
    ref: '',
    w3w: '',
    center: null,
    areaHa: DEFAULT_CLIENT_AREA_HA,
    status: 'idle'
  },
  /** Optional what3words API key — session only, never exported. */
  w3wApiKey: '6UKJVW33',
  /**
   * Session history of linked clients (opaque ref + last known centre).
   * Searchable; never persisted; no Recorder directory.
   */
  clientHistory: [],
  /** Active indicative loss play — in-memory only. */
  lossPlay: null,
  /**
   * Parent NFI ids hidden after a manual split (pieces replace them on the map).
   * Parents stay in `features` so viewport refresh does not resurrect full polygons.
   */
  suppressed: new Set(),
  /** Manual split draw session — null when idle. */
  splitDraw: null
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of listeners) fn();
}
