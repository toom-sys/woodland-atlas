# Endpoint verification

**Verified:** 2026-07-22  
**Scope:** Phase 1 — confirm reachable URLs for NFI, EA VOM, EA DTM, and Met Office / Natural England FSI before wiring enrichment (SPEC §8).

Re-run the snippets below whenever a service starts failing. Dated service names go stale; prefer discovery / capabilities documents over hardcoding.

---

## Summary

| Source | Status | Confirmed access | Pill when blocked |
|---|---|---|---|
| **NFI** (Forestry Commission) | LIVE | ArcGIS FeatureServer via org directory discovery | `NFI · OFFLINE — SAMPLE DATA` |
| **EA VOM** (canopy height) | LIVE via **WCS** | Defra DSP WCS 2.0.1 (ImageServer retired) | `NO LIDAR` / `LIDAR · UNAVAILABLE` |
| **EA DTM** (terrain) | LIVE via **WCS** | Defra DSP WCS 2.0.1 (ImageServer retired) | terrain fields `null`, score components flagged |
| **FSI** (Met Office → NE) | LIVE | Natural England `OASYS_FSI_PRD_VIEW` FeatureServer | `FSI · MANUAL` (assumptions dropdown, default 2) |
| **Place search** | OPTIONAL | Open-Meteo geocoding → Photon fallback | toast; map unchanged |

---

## 1. National Forest Inventory (NFI)

### Confirmed

| Item | Value |
|---|---|
| Org root | `https://services2.arcgis.com/mHXjwgl3OARRqqD4/ArcGIS/rest/services` |
| Preferred service (today) | `National_Forest_Inventory_GB_2024` FeatureServer |
| Layer 0 name | `NFI_GB_IFT_Data_20250826` |
| Geometry | polygon |
| Useful fields | `FID`, `IFT_IOA`, `CATEGORY`, `Area_Ha`, `COUNTRY` |
| Licence | OGL (Forestry Commission) |

Do **not** hardcode the dated GB service name in app code. Discover at runtime: `GET {root}?f=json`, filter `services[]` for `/National_Forest_Inventory/i` (prefer GB over nation splits) with `type === "FeatureServer"`, then take layer 0. A bare `/forest|nfi|woodland/i` filter matches many non-inventory services (woodland creation, grants, officer boundaries, …).

### Fallback

Procedural sample parcels (`src/data/demo.js`) around Dalby Forest `[-0.677, 54.283]`. Loaded only when NFI is offline. Fly-to control centres on Dalby Forest; pill `NFI · OFFLINE — SAMPLE DATA` when fallback is active.

### Curl / fetch snippets

**Directory discovery**

```bash
curl -sS -m 15 \
  'https://services2.arcgis.com/mHXjwgl3OARRqqD4/ArcGIS/rest/services?f=json' \
  | python3 -c "import sys,json,re; d=json.load(sys.stdin); \
  [print(s['name']) for s in d['services'] \
   if re.search(r'National_Forest_Inventory', s['name'], re.I) \
   and s['type']=='FeatureServer']"
```

**Layer metadata**

```bash
curl -sS -m 20 \
  'https://services2.arcgis.com/mHXjwgl3OARRqqD4/ArcGIS/rest/services/National_Forest_Inventory_GB_2024/FeatureServer/0?f=json'
```

**Viewport query** (envelope as `xmin,ymin,xmax,ymax`; omit `spatialRel` — see notes)

```bash
curl -sS -m 60 -G \
  'https://services2.arcgis.com/mHXjwgl3OARRqqD4/ArcGIS/rest/services/National_Forest_Inventory_GB_2024/FeatureServer/0/query' \
  --data-urlencode 'f=geojson' \
  --data-urlencode 'where=1=1' \
  --data-urlencode 'geometry=-3.05,54.45,-2.95,54.55' \
  --data-urlencode 'geometryType=esriGeometryEnvelope' \
  --data-urlencode 'inSR=4326' \
  --data-urlencode 'outSR=4326' \
  --data-urlencode 'outFields=*' \
  --data-urlencode 'resultRecordCount=5'
```

```js
const root = 'https://services2.arcgis.com/mHXjwgl3OARRqqD4/ArcGIS/rest/services';
const dir = await fetch(`${root}?f=json`).then((r) => r.json());
// Prefer National_Forest_Inventory_* FeatureServers; take layer 0 of first viable.
```

### Verification notes (2026-07-22)

- Directory returns 200 with 200+ services; inventory services include `National_Forest_Inventory_GB_2024` and nation/year variants.
- `outFields=*` query without geometry returns features; envelope query around Lake District returned parcels (`IFT_IOA`, `Area_Ha`, …).
- Field casing today is `Area_Ha` (not `AREA_HA` / `Area_ha`) and object id is `FID` (not `OBJECTID`) — normalisers must keep detecting aliases.
- Passing `spatialRel=esriIntersects` currently returns **HTTP 400** `"spatialRel parameter is invalid"` on this host. Queries work without it. Runtime NFI fetch must not send a rejected `spatialRel`.

---

## 2. EA Vegetation Object Model (VOM) — canopy height

### Confirmed (WCS — use this)

| Item | Value |
|---|---|
| Dataset page | `https://environment.data.gov.uk/dataset/ecae3bef-1e1d-4051-887b-9dc613c928ec` |
| WCS endpoint | `https://environment.data.gov.uk/spatialdata/vegetation-object-model/wcs` |
| CoverageId (elevation) | `ecae3bef-1e1d-4051-887b-9dc613c928ec__Vegetation_Object_Model_Elevation_2022` |
| CRS | EPSG:27700 (British National Grid); axis labels `E N` |
| Native format | `image/tiff` (32-bit float heights, metres) |
| Envelope (BNG) | ~`133914, 11000` → `655654, 657600` |
| Licence | OGL (Environment Agency) |
| Coverage | England only |

### Not available (do not wire)

| Candidate | Result 2026-07-22 |
|---|---|
| `…/image/rest/services/SURVEY/VegetationObjectModel/ImageServer` | HTTP 200 body `Invalid URL` |
| `…/image/rest/services/SURVEY/VegetationObjectModel/MapServer` | Timed out / unreachable |
| `…/image/rest/services` root | `Invalid URL` |

Defra DSP retired Esri Image services in favour of open WCS/WMS. Phase 2 sampling must use **WCS GetCoverage** (small BNG subsets around sample points), not `getSamples` / `identify` on ImageServer.

Sister WMS (display only): `https://environment.data.gov.uk/spatialdata/vegetation-object-model/wms`

### Fallback

Parcels outside England or on WCS failure → `enrich.canopyHeightM = null`, UI `NO LIDAR`. Sample parcels keep fixed offline enrichment values.

### Curl snippets

**GetCapabilities**

```bash
curl -sS -m 20 \
  'https://environment.data.gov.uk/spatialdata/vegetation-object-model/wcs?service=WCS&request=GetCapabilities'
```

**DescribeCoverage**

```bash
curl -sS -m 25 -G \
  'https://environment.data.gov.uk/spatialdata/vegetation-object-model/wcs' \
  --data-urlencode 'service=WCS' \
  --data-urlencode 'version=2.0.1' \
  --data-urlencode 'request=DescribeCoverage' \
  --data-urlencode 'CoverageId=ecae3bef-1e1d-4051-887b-9dc613c928ec__Vegetation_Object_Model_Elevation_2022'
```

**GetCoverage** — ~20 m × 20 m chip near Nidderdale (BNG ≈ 404000 E, 471000 N)

```bash
curl -sS -m 40 -G \
  'https://environment.data.gov.uk/spatialdata/vegetation-object-model/wcs' \
  --data-urlencode 'service=WCS' \
  --data-urlencode 'version=2.0.1' \
  --data-urlencode 'request=GetCoverage' \
  --data-urlencode 'CoverageId=ecae3bef-1e1d-4051-887b-9dc613c928ec__Vegetation_Object_Model_Elevation_2022' \
  --data-urlencode 'subset=E(404000,404020)' \
  --data-urlencode 'subset=N(471000,471020)' \
  --data-urlencode 'format=image/tiff' \
  -o vom_sample.tif
# Expect: TIFF, 32-bit, ~20×20 px
```

```js
const VOM_WCS = 'https://environment.data.gov.uk/spatialdata/vegetation-object-model/wcs';
const VOM_COVERAGE =
  'ecae3bef-1e1d-4051-887b-9dc613c928ec__Vegetation_Object_Model_Elevation_2022';
// Verified 2026-07-22 — re-check CoverageId via GetCapabilities if GetCoverage 404s.
```

---

## 3. EA LiDAR Composite DTM — terrain

### Confirmed (WCS — use this)

| Item | Value |
|---|---|
| Dataset page | `https://environment.data.gov.uk/dataset/13787b9a-26a4-4775-8523-806d13af58fc` |
| WCS endpoint | `https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs` |
| CoverageId (elevation) | `13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m` |
| CRS | EPSG:27700; axis labels `E N` |
| Native format | `image/tiff` |
| Envelope (BNG) | ~`80000, 4000` → `656000, 665000` |
| Licence | OGL (Environment Agency) |
| Coverage | England (~99%) |

Hillshade coverage also advertised: `…__Lidar_Composite_Hillshade_DTM_1m` (not needed for scoring).

### Not available

Legacy ImageServer paths such as  
`…/image/rest/services/SURVEY/LIDAR_Composite_1m_DTM_2020_Elevation/ImageServer` → `Invalid URL` (same ImageServer retirement as VOM).

### Fallback

`elevationM` / `slopeDeg` / `aspectDeg` / `exposure` stay `null`; fire slope/aspect component uses the SPEC default (0.3, flagged).

### Curl snippets

**GetCapabilities**

```bash
curl -sS -m 20 \
  'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs?service=WCS&request=GetCapabilities'
```

**GetCoverage** (same Nidderdale chip)

```bash
curl -sS -m 40 -G \
  'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs' \
  --data-urlencode 'service=WCS' \
  --data-urlencode 'version=2.0.1' \
  --data-urlencode 'request=GetCoverage' \
  --data-urlencode 'CoverageId=13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m' \
  --data-urlencode 'subset=E(404000,404020)' \
  --data-urlencode 'subset=N(471000,471020)' \
  --data-urlencode 'format=image/tiff' \
  -o dtm_sample.tif
```

```js
const DTM_WCS =
  'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs';
const DTM_COVERAGE =
  '13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m';
// Verified 2026-07-22
```

---

## 4. Fire Severity Index (FSI)

### Confirmed (live FeatureServer)

Natural England hosts the operational FSI map (Met Office model) as an ArcGIS Online FeatureServer referenced by the public Experience app.

| Item | Value |
|---|---|
| FeatureServer | `https://services.arcgis.com/JJzESW51TqeY9uat/arcgis/rest/services/OASYS_FSI_PRD_VIEW/FeatureServer` |
| Layer 0 | `FSI_AGOL` — 10 km grid polygons |
| Layer 1 | `FSI_AGOL_META` — ingest metadata (no geometry) |
| Rating field | `rating` (observed 1–4 today; scale is 1–5 per Met Office / CRoW docs) |
| Date fields | `dow_date` (ISO date), `data_date_offset_pk` (0 = today … 5 = +5 day forecast) |
| Grid id | `square_reference_pk` (e.g. `SE06`) |
| Public map | `https://experience.arcgis.com/experience/328554206f114fc98c707bfc1b880cf7` |
| NE landing | `https://openaccess.naturalengland.org.uk/` (human UI; not an API) |
| Met Office explainer | `https://www.metoffice.gov.uk/services/government/environmental-hazard-resilience/fire-severity-index` |

No open FeatureServer was listed on the Natural England Open Data Hub search UI; the working URL was recovered from the Experience item data. Treat the FeatureServer URL as a **constant with discovery comment**, and keep the manual fallback mandatory.

### Fallback chain (SPEC §3.5)

1. Live `OASYS_FSI_PRD_VIEW` layer 0 query → pill `FSI · LIVE`
2. Else assumptions drawer **"Current FSI level (manual)"** → pill `FSI · MANUAL`
3. Else default level **2** → pill `FSI · MANUAL` / default

Fire score must never block on this feed.

### Optional stretch — Copernicus EFFIS FWI WMS

Reachable GetCapabilities (2026-07-22):

`https://maps.effis.emergency.copernicus.eu/effis?service=WMS&request=GetCapabilities`

Relevant layer name includes `mf010.fwi`. Coarser than Met Office FSI; only use if NE service is unreachable and label the pill accordingly (e.g. `FSI · EFFIS`). Manual override remains preferred for network-proof demos.

### Curl snippets

**Service + layer metadata**

```bash
curl -sS -m 15 \
  'https://services.arcgis.com/JJzESW51TqeY9uat/arcgis/rest/services/OASYS_FSI_PRD_VIEW/FeatureServer?f=json'
curl -sS -m 15 \
  'https://services.arcgis.com/JJzESW51TqeY9uat/arcgis/rest/services/OASYS_FSI_PRD_VIEW/FeatureServer/0?f=json'
```

**Today’s rating for a viewport** (omit `spatialRel`)

```bash
curl -sS -m 30 -G \
  'https://services.arcgis.com/JJzESW51TqeY9uat/arcgis/rest/services/OASYS_FSI_PRD_VIEW/FeatureServer/0/query' \
  --data-urlencode 'f=json' \
  --data-urlencode 'where=data_date_offset_pk=0' \
  --data-urlencode 'geometry=-1.95,54.12,-1.90,54.15' \
  --data-urlencode 'geometryType=esriGeometryEnvelope' \
  --data-urlencode 'inSR=4326' \
  --data-urlencode 'outFields=square_reference_pk,dow_date,data_date_offset_pk,rating' \
  --data-urlencode 'returnGeometry=false' \
  --data-urlencode 'resultRecordCount=5'
# Example 2026-07-22 Nidderdale: SE06 rating 3, SE07 rating 2
```

```js
const FSI_LAYER =
  'https://services.arcgis.com/JJzESW51TqeY9uat/arcgis/rest/services/OASYS_FSI_PRD_VIEW/FeatureServer/0';
// Verified 2026-07-22 via NE Experience item 328554206f114fc98c707bfc1b880cf7
// Fallback: assumptions.fsiLevelManual ?? 2
```

---

## 5. Implications for later phases

1. **Phase 2 (LiDAR / terrain):** England uses **WCS GetCoverage** (VOM + DTM). Scotland uses **S3 1 km NLP tiles** (DSM−DTM) where published. Wales open LiDAR exists but **Azure blob CORS blocks browser reads** — UI explains the gap; Stage 2 proxy unlocks it.
2. **Phase 4 (fire):** prefer `OASYS_FSI_PRD_VIEW`; ship manual override first so the pill path is real even if AGOL blocks corporate networks.
3. **NFI runtime:** tighten discovery to `National_Forest_Inventory` names; drop broken `spatialRel` on FC/NE hosts; accept `FID` / `Area_Ha` / `COUNTRY` aliases.
4. **Re-verify** CoverageIds and the FSI FeatureServer URL if Defra or NE republish — dates in this file are the audit trail.

---

## 6. Scotland & Wales LiDAR (coverage honesty)

### Scotland — LIVE where tiles exist

| Item | Value |
|---|---|
| Portal | `https://remotesensingdata.gov.scot/data` |
| Open object store | `https://srsp-open-data.s3.eu-west-2.amazonaws.com` (CORS `*`, Range OK) |
| Programme | Scottish Land LiDAR Programme 2025–2027 (Bluesky); first blocks Jan 2026 |
| Browser path | 1 km NLP GeoTIFFs: `lidar/national-lidar-programme/{dsm\|dtm}/27700/gridded/{OS1km}_50cm_{DSM\|DTM}_ScotlandNationalLiDAR.tif` |
| Canopy | **DSM − DTM** (no VOM / vegetation-only product) |
| Gaps | Most of Scotland still unpublished; older phase tiles are huge 5 km files — not used in-browser |

**What users are missing (plain English):** England has a ready-made “tree height” layer. Scotland only publishes ground and surface models, and only for areas flown so far. Where both 1 km tiles exist we subtract them to estimate tree height; elsewhere we say so and use estimates.

### Wales — open data, not browser-reachable

| Item | Value |
|---|---|
| Portal | DataMapWales LiDAR download / viewer |
| National COGs | `https://dmwproductionblob.blob.core.windows.net/cogs/lidar/wales_{dtm\|dsm}_32bit_cog.tif` (~48 GB BigTIFF, Deflate) |
| Per-tile TIFFs | Catalogue via WFS `geonode:welsh_government_lidar_tile_catalogue_2020_2023` → `dtm_link` / `dsm_link` on same Azure host |
| CORS (2026-07-22) | **Not enabled** — OPTIONS 403; GET has no `Access-Control-Allow-Origin` |
| WCS on GeoServer | Noise maps only — no LiDAR coverages |

**What users are missing (plain English):** Wales already has good open LiDAR covering the country. We just cannot open those files from this website because the storage server refuses browser access. A tiny proxy (or the host enabling CORS) would unlock Wales the same way as England/Scotland.

---

## 7. Attribution (footer / exports)

- National Forest Inventory © Forestry Commission, contains public sector information licensed under the Open Government Licence v3.0.
- LIDAR VOM & Composite DTM © Environment Agency, OGL v3.0.
- Scottish Public Sector / National Land LiDAR © Scottish Government & partners, OGL v3.0 (via JNCC / AWS Open Data).
- Welsh Government / NRW LiDAR © OGL v3.0 (not yet live in-browser).
- Fire Severity Index © Crown copyright / Met Office; published via Natural England Open Access mapping.
