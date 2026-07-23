# Woodland Atlas — Technical Specification

**Purpose of this document:** drop into a Cursor project (e.g. as `docs/SPEC.md`, referenced from `.cursorrules`) as the canonical build spec. It defines (1) the existing Woodland Atlas v1 so it can be rebuilt as a proper repo, and (2) the v2 enrichment extension adding **windthrow** and **fire** risk layers from open GB data.

**Product in one line:** a static website that draws GB woodland from open public data on a stylised 2.5D map, lets the user click-select parcels into a basket, and prices the selection (timber + land + indicative carbon) with a transparent, editable model — extended in v2 with per-parcel windthrow and fire risk scores.

**Non-negotiable context:** internal briefing tool; no client directory or PII in the browser; optional opaque typed group refs for handoff only; everything labelled *indicative*; must degrade gracefully on locked-down corporate networks (the demo must never die because an endpoint is blocked).

---

## 1. Architecture & repo layout

Static site, no backend, deployable to GitHub Pages. No framework — vanilla ES modules. Optional Vite for local dev server only; the build output must remain plain static files.

```
woodland-atlas/
├── index.html
├── styles.css
├── src/
│   ├── main.js            # boot, wiring, state
│   ├── state.js           # single app state object + pub/sub render trigger
│   ├── map.js             # MapLibre init, style, layers, interaction
│   ├── data/
│   │   ├── nfi.js         # NFI discovery + viewport fetch + normalisation
│   │   ├── clientLink.js  # opaque group ref + lat/lon/radius guide + touch-select
│   │   ├── geocode.js     # GB place search (Open-Meteo → Photon fallback)
│   │   ├── lidar.js       # EA Vegetation Object Model (canopy height) sampler
│   │   ├── terrain.js     # EA DTM sampler → elevation, slope, aspect, exposure
│   │   ├── fsi.js         # Met Office Fire Severity Index (dynamic overlay)
│   │   └── demo.js        # procedural sample parcels (offline fallback)
│   ├── scoring/
│   │   ├── windthrow.js   # windthrow score (ForestGALES-inspired, rebuilt)
│   │   ├── fire.js        # fire susceptibility score
│   │   └── lossScenario.js # indicative storm/fire path + SI loss play
│   ├── valuation.js       # timber/land/carbon model
│   └── ui/
│       ├── panel.js       # selection basket, totals, per-parcel cards
│       ├── search.js      # place + session client search
│       ├── assumptions.js # editable rates drawer
│       └── pills.js       # data-source status pills
├── docs/
│   └── SPEC.md            # this file
└── .cursorrules           # points at this spec; see §9
```

### Core invariants (apply to every phase)

1. **Fail soft, always.** Every external fetch has a timeout (8–10s), a `catch`, and a defined fallback. A blocked endpoint downgrades a feature and updates its status pill; it never throws to the user or blanks the map.
2. **Status pills are honest.** Each data source has a pill: `LIVE` (green), `OFFLINE — FALLBACK` (amber), or `UNAVAILABLE` (grey). The pills are part of the product — the tool exists partly to show off which open data is reachable.
3. **No client directory or PII.** Do not fetch private client directories, names, or book SIs. A session-only opaque **group ref** (typed by the user) plus an optional lat/lon/radius guide is allowed — see §6.1. Public woodland data + user clicks remain the source of truth for geometry.
4. **Indicative labelling.** Footer carries: model is indicative; heights/scores are estimated from open data, not surveyed; internal briefing only.
5. **All model numbers are editable** in the assumptions drawer and exported alongside results. No hidden constants in scoring or valuation.
6. **Verify endpoints at build time.** Service names and layer IDs on public ArcGIS servers go stale. Never hardcode a full service name without a discovery or fallback path (see the NFI pattern in §3.1 — this exact failure has already happened once).

---

## 2. Design system (fixed — do not restyle)

```css
--ink:#11150E;  --ink-2:#1A2015; --ink-3:#232B1C;
--amber:#F2B63C; --amber-dim:#B98A2C;
--paper:#EDE8DA; --moss:#7C8A6A;  --line:#3A4430;
--conifer:#3E7C4F; --broadleaf:#8FBF6F; --mixed:#6BA35B; --other:#4A5340;
```

Fonts: **Familjen Grotesk** (display/body), **IBM Plex Mono** (labels, data, pills) via Google Fonts. Dark canvas; amber is the selection/emphasis colour only. Sentence case in UI copy; mono uppercase micro-labels with letter-spacing for kickers/pills. Respect `prefers-reduced-motion`. Buttons and cards: 1px `--line` borders, 6–12px radii, translucent ink backgrounds with backdrop blur over the map.

Layout: full-bleed map; masthead card top-left (title, source pills, place/client search, hint line); control stack bottom-left (tilt / satellite / fly-to-sample / clear); legend strip; right-hand panel (~390px) for selection & value, collapsing to a bottom sheet ≤820px; thin mono footer with source attributions and the indicative disclaimer.

---

## 3. Data sources

### 3.1 National Forest Inventory (v1 — implemented)

- **What:** authoritative GB woodland polygons (Forestry Commission, OGL). Every wood ≥0.5 ha, ≥20% canopy, ≥20 m wide. Annual updates, ~1 yr imagery lag. Parcels segment by forest type, **not ownership** — they merge across boundaries.
- **Where:** ArcGIS REST, org root `https://services2.arcgis.com/mHXjwgl3OARRqqD4/ArcGIS/rest/services`.
- **Discovery (required):** fetch the root with `?f=json`, filter `services[]` for `/forest|nfi|woodland/i` with `type === "FeatureServer"`, take layer 0 of the first viable service. Do not hardcode the dated service name.
- **Fetch:** on `moveend` at zoom ≥ ~11.3, `query` with the viewport envelope: `f=geojson, where=1=1, geometryType=esriGeometryEnvelope, inSR=4326, outSR=4326, outFields=*, resultRecordCount=2000`. Dedupe by OBJECTID; cap the in-memory store (~6,000 features, never evicting selected ones).
- **Fields to normalise** (names vary by vintage — detect, don't assume): `OBJECTID`, `IFT_IOA` (interpreted forest type: Conifer, Broadleaved, Mixed mainly conifer, Mixed mainly broadleaved, Young trees, Felled, Coppice, Shrub, Ground prep, Windblow, …), `CATEGORY`, area (`Area_ha`/`AREA_HA`/absent → compute spherical geodesic area from geometry).
- **Normalised parcel schema** (everything downstream reads only this):

```js
{
  id: "nfi-<OBJECTID>",
  type: "Conifer",             // raw IFT_IOA string
  group: "conifer",            // conifer | broadleaf | mixed | other
  ha: 12.4,
  centroid: [lon, lat],
  geometry: <GeoJSON>,
  enrich: {                    // v2, all nullable — null = not yet sampled / unavailable
    canopyHeightM: null,       // median from EA VOM
    elevationM: null, slopeDeg: null, aspectDeg: null,
    exposure: null,            // 0–1 topographic exposure proxy
    fsiLevel: null,            // 1–5 dynamic
    windthrow: null,           // {score, band, components:{...}}
    fire: null                 // {score, band, components:{...}}
  }
}
```

### 3.2 Sample data fallback (v1 — implemented)

Procedural generator (seeded PRNG, fixed seed) producing ~14 irregular parcels around **Dalby Forest**, North Yorkshire (`[-0.677, 54.283]`), covering all type groups, `type` suffixed `" (sample)"`. Loaded only when NFI discovery fails (offline fallback) — when NFI is live the map shows real inventory only. The fly-to control centres on Dalby Forest so users can explore real Yorkshire woodland. v2: sample parcels also get plausible fixed enrichment values so the scoring UI can be demonstrated offline.

### 3.3 EA LiDAR — canopy height (v2, the keystone)

- **Dataset:** Environment Agency **National LiDAR Programme — Vegetation Object Model (VOM)**, 1 m resolution, England: first-return surface minus terrain = vegetation height, i.e. canopy height directly. Open (OGL). Sister datasets: **LiDAR Composite DTM** and **DSM** (1 m).
- **Where:** Defra/EA publish these via the Defra Data Services Platform (`environment.data.gov.uk`) as ArcGIS REST **ImageServer** services and as downloadable tiles. ⚠️ **Verify the exact ImageServer URLs at build time** — browse `https://environment.data.gov.uk/spatialdata/` (or its ArcGIS REST directory) and confirm the VOM and DTM ImageServer endpoints before wiring them in; record the confirmed URLs as constants with a comment dated when verified.
- **Coverage honesty:** England has EA VOM (vegetation height) + DTM via WCS. Scotland: open NLP 1 km DTM/DSM on AWS where published — canopy derived as DSM−DTM; national cover still incomplete through 2027. Wales: open LiDAR exists (DataMapWales) but Azure blob CORS blocks browser sampling — UI shows a plain-language gap and falls back to estimates. Parcels outside usable coverage get `canopyHeightM: null` and `NO LIDAR`, never a fake number.
- **Sampling strategy (browser-feasible):** per selected parcel, don't fetch rasters wholesale. Use ImageServer point sampling:
  1. Generate ≤ 25 sample points inside the parcel polygon (centroid + grid clipped to the polygon; fewer for small parcels).
  2. `getSamples` (batch) or `identify` per point against the VOM ImageServer.
  3. Take the **median** of returned heights > 0.5 m as `canopyHeightM`; record sample count.
  Cache results per parcel id in `localStorage`-free memory (state only) — sampling runs on selection, not on viewport load, to keep request volume tiny.
- **Uses:** replaces the type-based estimated extrusion height for enriched parcels (visual upgrade: estimated vs measured shown in the parcel card as `est.`/`LiDAR`); feeds windthrow (§4); sanity-checks stated age (tall "young" stands are a flag).

### 3.4 EA DTM — terrain attributes (v2)

Same ImageServer pattern against the **Composite DTM**. Per parcel, sample the same point grid plus 8 ring points ~250 m outside the boundary, then derive:

- `elevationM` — median parcel elevation.
- `slopeDeg`, `aspectDeg` — from a 3-point plane fit or ImageServer's slope/aspect rendering rule if exposed (prefer computing locally from elevations: simpler, no dependency on server rendering rules).
- `exposure` (0–1) — cheap **topex-style proxy**: mean of `max(0, elevation_parcel − elevation_ring_point)` normalised over ~50 m; high = parcel sits proud of its surroundings. Document clearly that this is a proxy for DAMS/topex, not the real thing, and is replaced by a proper server-side calculation in the Stage 2 pipeline.

### 3.5 Met Office Fire Severity Index (v2, dynamic)

- **What:** 5-level forecast fire severity for England & Wales (Met Office, published in connection with open-access land restrictions; Level 5 = exceptional). Coarse grid, updated daily-ish.
- **Where:** historically served as an ArcGIS REST service (Natural England / Met Office hosting has moved before). ⚠️ **Verify at build time**: search the Natural England ArcGIS open data portal and `environment.data.gov.uk` for the current FSI service; if no reachable open service is found, implement the interface with a **manual override** — a dropdown in the assumptions drawer, "Current FSI level (manual)", defaulting to 2 — so the fire score still works and the pill reads `FSI · MANUAL`.
- **Fallback chain:** live service → manual level → default 2. The fire score must never be blocked on this feed.
- **EU alternative (optional stretch):** Copernicus EFFIS Fire Weather Index WMS — coarser but reliable; acceptable substitute if the Met Office service is unreachable, labelled accordingly.

### 3.6 Already-integrated valuation inputs (v1)

No external source — user-editable rates (see §5). Do not add live timber-price feeds in v2; a manual rates table is more defensible and network-proof.

---

## 4. Risk scoring (v2)

Both scores are **transparent composites**: 0–100, banded LOW (<25) / MODERATE (25–50) / ELEVATED (50–75) / HIGH (>75), with every component and weight visible in the parcel card (expandable breakdown) and included in exports. Weights live in the assumptions drawer with the same editability as valuation rates. Scores compute on selection (after enrichment sampling resolves) and show a spinner → value or `N/A (no LiDAR)` state.

### 4.1 Windthrow score (`scoring/windthrow.js`)

ForestGALES-inspired, rebuilt from open inputs — explicitly **not** the ForestGALES model, and the code comments must say so. Components (default weights in brackets, editable):

| Component | Input | Contribution (0–1 before weight) |
|---|---|---|
| Canopy height [0.30] | `canopyHeightM` (VOM) | 0 below 10 m, linear to 1.0 at 28 m+. Taller = more leverage on the root plate. If no LiDAR: estimate from type+age table, flag `est.` |
| Species/rooting [0.20] | `group` + type string | conifer 0.9 (shallow plating, esp. Sitka-type), mixed 0.6, broadleaf 0.35, felled/other 0.05 |
| Exposure [0.20] | `exposure` proxy + `elevationM` | 0.6 × exposure + 0.4 × elevation ramp (0 at 50 m → 1 at 450 m) |
| Age/stage [0.15] | selected age band | young 0.2, establishing 0.5, semi 0.9 (tall, unthinned, un-acclimated edges), mature 0.7 |
| Wind-direction vulnerability [0.15] | `aspectDeg` + storm-direction assumption | see below |

**Wind-direction component (the differentiating idea):** root systems acclimate to the prevailing south-westerlies; storms from the **north/north-east** (Arwen-type) load stands from their untrained direction and are disproportionately destructive despite comparable gust speeds (Arwen vs Éowyn is the reference pair). Implementation: assumptions drawer has a "storm direction scenario" control — `Prevailing SW (default)` / `Northerly (Arwen-type)` / `Any (worst case)`. The component scores the misalignment between the scenario direction and the stand's sheltered aspect: under `SW` it contributes ~0.3 baseline; under `Northerly`, north-facing and exposed parcels ramp toward 1.0; `Any` takes the max. Show the active scenario as a pill on the totals card, because it changes the numbers.

Output: `{score, band, components: {height, species, exposure, age, direction}, inputsUsed: {canopy:'lidar'|'estimated', ...}, scenario}`.

### 4.2 Fire score (`scoring/fire.js`)

Static susceptibility blended with the dynamic FSI:

`fireScore = 100 × (0.55 × susceptibility + 0.45 × fsiNorm)` where `fsiNorm = (fsiLevel − 1)/4`.

Susceptibility components (editable weights):

| Component | Input | Contribution |
|---|---|---|
| Fuel type [0.45] | `group` + type | conifer 0.9 (resinous, ladder fuels), young plantation 0.8, mixed 0.55, broadleaf 0.3, felled (brash) 0.6 |
| Slope & aspect [0.25] | DTM | south-ish aspect (135–225°) up to 0.6 + slope ramp (0 flat → 0.4 at 25°+); no DTM → 0.3 default, flagged |
| Canopy continuity [0.15] | parcel `ha` | log ramp: bigger contiguous fuel beds score higher (1 ha ≈ 0.2 → 100 ha ≈ 0.9) |
| Ignition proximity [0.15] | placeholder | fixed 0.5 with an `assumed` flag in v2. Real inputs (rights of way, CRoW access, roads/rail) are a known reliability trap (fragmented LA data) — parked for the Stage 2 pipeline, and the breakdown UI must show this component as assumed, not measured |

Output mirrors windthrow: `{score, band, components, inputsUsed, fsi: {level, source:'live'|'manual'|'default'}}`.

### 4.3 UI integration

- Parcel card gains a two-chip row: `WIND 62 · ELEVATED` / `FIRE 31 · MODERATE`, colour-ramped moss→amber→a restrained red only at HIGH (introduce `--risk:#C4553B` for HIGH bands only; nothing else uses red).
- Chips expand to the component breakdown with each input's provenance (`LiDAR`, `DTM`, `estimated`, `assumed`, `manual`).
- **Area summary first:** the selection panel leads with parcels / ha / capital (+ one-line wind & fire means). Timber/land split, carbon, band counts, and coverage notes sit in a collapsed **Value & risk detail** fold. Per-parcel cards sit in a collapsed **Parcels** fold (open state preserved across re-renders).
- Totals card gains area-weighted mean scores for the selection and a count of parcels per band.
- Map: optional "risk view" toggle recolouring extrusions by windthrow band (selection glow stays amber).
- Exports (CSV + JSON) gain score columns plus the full component breakdown and scenario in the JSON.

---

## 5. Valuation model (v1 — keep as is)

Per parcel: `timber = rate[group][age] × ha`, `land = landRate × ha`, `capital = timber + land`, `carbon = seq[age] × carbonPrice × ha` (£/yr, kept separate from capital — never summed into it). Age band is user-set per parcel (default semi-mature; `Young trees` type defaults young). Defaults are placeholder round numbers and the drawer says so:

```js
timber: { conifer:{young:800, establishing:3000, semi:7000, mature:14000},
          broadleaf:{young:300, establishing:1200, semi:3000, mature:7000},
          mixed:{young:550, establishing:2100, semi:5000, mature:10500},
          other:{young:0, establishing:0, semi:0, mature:0} },
land: 9000,                       // £/ha
cprice: 25,                       // £/tCO2e
seq: {young:5, establishing:9, semi:6, mature:2.5}   // tCO2e/ha/yr; ×0.3 for group 'other'
```

v2 addition: when `canopyHeightM` exists, show a passive hint on the card if measured height is implausible for the selected age band (e.g. >20 m on `young`) — a nudge, not an auto-correction.

---

## 6. Map behaviour (v1 — keep as is)

MapLibre GL (cdnjs, pin a known version). Style layers: dark background → CARTO `dark_nolabels` raster (opacity ~0.55, desaturated) → Esri World Imagery raster (hidden until satellite toggle) → NFI `fill-extrusion` → NFI outline. Extrusion height = `baseHeight(type) × 6` exaggeration (v2: `canopyHeightM × 6` when sampled); selected parcels: amber, height ×1.35, via `feature-state` with `promoteId:'__id'`. Pitch 55° / bearing −18° default, tilt toggle to flat. Swallow tile errors (`map.on('error', …)`) so blocked basemaps degrade to the dark canvas with parcels still rendered. Start view North York Moors; "fly to Dalby Forest" button. Colour control cycles **public data → forest type → off** (off hides NFI woodland layers so the basemap / satellite / client guide stand alone).

### 6.1 Group woodlands guide (handoff aid)

Atlas keeps accurate NFI parcel selection and optionally attaches a coarse area guide for briefing handoff:

- **Group ref** — free-text opaque id typed by the user (briefing / policy id). Session-only; never fetched from a client directory; no names or book SIs.
- **Location** — paste `lat, lon`, or when **Colour · off** (woodlands hidden) click the map to set the centre and draw the guide (no fly — the click is the pick).
- **Area (ha)** — editable guide size in whole hectares (default 80). Converted to a circle radius via `r = √(ha × 10 000 / π)` for the amber guide and touch-select. Drawn as that circle + centre on the map.
- **Select woods that touch** — after fitting the map to the guide and loading the viewport, add every loaded parcel whose geometry intersects the circle to the selection (and run enrichment as for a click).
- **Export** — JSON includes `clientLink: { ref, center, areaHa, radiusM }` (`radiusM` derived). CSV gains a `client_ref` column on each row when a ref is set.

### 6.2 Place / client search

Masthead search bar (sentence-case placeholder). Queries:

- **Places** — GB cities, towns, villages, regions via Open-Meteo geocoding with Photon fallback (timeout + catch; toast if both fail). Selecting a hit flies the map; place bounding boxes fit when available.
- **Groups** — session-only: matches opaque refs already grouped this session (and the current guide) that have a saved centre; restores the guide and flies to it. No external client directory.
- **Direct** — pasted `lat, lon`.

Keyboard: ↑/↓, Enter, Escape. Fail soft — a blocked geocoder never blanks the map.

### 6.3 Show a loss (indicative)

Briefing aid — **not a claims model**. Requires a parcel selection. User picks hazard (**storm path** or **fire spread**) and one of three named example scenarios (or random / force worst case), then plays an animated path:

**Storms (three examples):** Prevailing SW (moderate) · Northerly Arwen-type (severe) · Worst case any direction.
**Fires (three examples):** Contained ground fire · Crown fire run · Worst case FSI 5.

- Start at a high-risk parcel in the selection; path grows with seeded randomness (storms bias a bearing corridor; fires bias fuel/risk neighbours).
- Tiered severity along the path: HIGH → ELEVATED → MODERATE → LOW (worst scenarios keep more of the path in HIGH). Map recolours path parcels; a trail line marks the route. Red only on HIGH (design token `--risk`).
- **SI** = capital (timber + land). Indicative loss = SI × tier fraction × scenario multiplier. Fractions and multipliers live in `state.rates.loss` (assumptions drawer).
- Panel shows running / final indicative loss, SI on path, and tier counts. Clear selection clears the play. `prefers-reduced-motion` skips the step animation.

---

## 7. Exports

- **CSV:** one row per parcel — id, type, group, age, hectares, timber, land, capital, carbon/yr, + v2: windthrow score/band, fire score/band, canopy height, provenance flags; optional `client_ref` when linked; TOTAL row.
- **JSON:** `{generated, source, clientLink?, lossPlay?, assumptions (full rates + weights + scenario + loss), parcels[…with component breakdowns], totals}`. This file is the proto build-a-wood artefact — treat its schema as semi-stable once shipped. `lossPlay` is present only after an indicative show-a-loss run.

---

## 8. Build phases for Cursor

Work strictly in order; each phase ends green before the next starts.

1. **Phase 0 — scaffold:** repo layout per §1, extract v1 single-file into modules with zero behaviour change. Acceptance: feature parity with v1 (selection, valuation, exports, offline fallback), Pages deploy works.
2. **Phase 1 — endpoint verification:** small `docs/endpoints.md` listing the *confirmed* NFI, VOM, DTM, FSI URLs with verification dates and a curl/fetch snippet each. Anything unverifiable gets its fallback documented instead.
3. **Phase 2 — LiDAR sampling:** `data/lidar.js` + `data/terrain.js`, sampling on selection, provenance flags in cards, measured extrusion heights. Acceptance: selecting an England parcel shows `canopyHeightM` with sample count ≤ 2 s on a normal connection; non-England or blocked → clean `NO LIDAR` state, nothing breaks.
4. **Phase 3 — windthrow:** scoring module, chips, breakdown UI, storm-direction scenario control, risk-view recolour toggle. Acceptance: scores recompute live when weights/scenario change; every component shows provenance.
5. **Phase 4 — fire:** FSI feed with manual fallback, fire scoring, chips/breakdown, export columns. Acceptance: works with FSI service unreachable (manual mode pill).
6. **Phase 5 — polish:** area-weighted selection scores on totals card, plausibility hints, mobile pass, reduced-motion audit, footer/attribution check (OGL attribution for FC/EA/Met Office data).

---

## 9. `.cursorrules` starter

```
Read docs/SPEC.md before any change; it is canonical.
Vanilla ES modules, no framework, no build-time dependency required to deploy.
Never remove the graceful-degradation paths or status pills.
Never hardcode an ArcGIS service name without the discovery fallback pattern (SPEC §3.1).
All scoring/valuation constants live in the assumptions state and are user-editable; no magic numbers in scoring functions.
Preserve the design tokens in SPEC §2 exactly; amber = selection/emphasis only; red only for HIGH risk bands.
No client directory or PII; opaque typed group refs + lat/lon guide only (SPEC §6.1). No analytics; no persistence beyond in-memory state.
Every external fetch: timeout, catch, defined fallback, pill update.
UI copy: sentence case, plain verbs; mono uppercase only for micro-labels.
```

---

## 10. Known limitations to carry honestly (footer / docs)

Heights and terrain are sampled estimates from open LiDAR, not survey; the exposure metric is a topex proxy, not DAMS; the windthrow model is ForestGALES-*inspired*, not ForestGALES; FSI may be manual; ignition proximity is assumed in v2; NFI parcels don't follow ownership so selections approximate insured woods; the lat/lon + radius guide is a coarse find-aid only — it is not the wood boundary; LiDAR coverage is England-only (Scotland partial, Wales browser-blocked). All of these are Stage 2 pipeline upgrades — the browser tool's job is to prove the joins are possible and show what the open data already supports.
