// WME RPP GIS Address Probe — main logic (loaded via the loader's @require).
//
// PURPOSE: a READ-ONLY diagnostic. For each visible RPP it asks the State of
// Colorado authoritative address-point GIS layer "is this house number real, and
// is the RPP sitting where that address actually is?", then logs a verdict.
// It NEVER edits the map — no geometry moves, no address writes. Safe in sandbox.
//
// DATA SOURCE — LOCAL-FIRST across Colorado (see the GIS source registry below):
//   Prefer a LOCAL county/city address-point service whose bbox covers the RPP
//   (e.g. City of Colorado Springs — gis.coloradosprings.gov), because local data
//   is fresher than the state aggregate. Where no local source is configured — or
//   the local one errors / returns nothing — fall back to the STATEWIDE composite
//   (gis.colorado.gov → Colorado_Public_Addresses, all CO counties). Each source
//   maps its own field names via its fields() fn; we query inSR=outSR=4326 so any
//   native SR is reprojected to WGS84. The "🔬 Probe" tab shows which source each
//   scan used (local / local→statewide fallback / statewide-no-local).
//
// USAGE: open the "🔬 Probe" tab in the WME scripts side panel and click
// "Probe visible RPPs" (or call rppGisProbe() in the console). The tab shows a
// live status (scanning N/N → done, with a "no issues" / issue summary) and the
// reviewable result rows. Grouped console output has the per-RPP detail; cross-
// check against the WME GIS Layers overlay.
//
// ── 🔢 HN FILLER (second tab, added 2026-07-21) ──────────────────────────────
// Select road segment(s) → "Scan selected" cross-references the street's
// EXISTING WME house numbers (SDK fetchHouseNumbers = server state) against the
// authoritative GIS address points along the segment (same local-first source
// registry as the probe) and lists the numbers that exist in GIS but are MISSING
// from the map. Each row has a reviewed one-click "Add" that creates the house
// number at the GIS point, snapped to the nearest same-street segment (SDK
// DataModel.HouseNumbers.addHouseNumber — lands in the normal WME save stack:
// review with the HN layer, then save/undo in WME itself). Street-mismatch GIS
// points in the corridor are listed report-only, never auto-added.

/* global W, turf, GM_xmlhttpRequest, getWmeSdk */

(function() {
    'use strict';

    const SCRIPT_NAME = 'WME RPP GIS Address Probe';
    const SCRIPT_VERSION = '2026.07.24.35';
    const LOG = '🔬 [RPP-GIS-Probe]';
    const HN_LOG = '🔢 [HN-Filler]';

    // Sidebar-tab UI references (populated by setupProbeTab once WME is ready).
    let probeStatusRef = null;
    let probeResultsRef = null;
    let probeButtonRef = null;

    // Immediate proof-of-load — fires the instant the file executes, before any WME gate.
    // If you don't even see THIS line, the script isn't loading (loader/file-access issue).
    console.log(`%c${LOG} script file executed — waiting for WME ready…`, 'color:#0a7');

    // ── GIS source registry (LOCAL-FIRST) ────────────────────────────────────
    // Local county/city authoritative address points are fresher than the state
    // aggregate, so we prefer them: the first LOCAL_SOURCES entry whose bbox
    // contains the RPP wins. If none matches — OR the chosen local service errors
    // / returns nothing — we fall back to the STATEWIDE source (all CO). The tab
    // shows which source a scan actually used (incl. "fallback"). `fields(a)` maps
    // a returned feature's raw attributes (we request outFields=* so each source
    // can use its own field names) to {hn, street, address, city, zip, subtype}.
    // bbox is [west, south, east, north] in WGS84.
    const STATEWIDE_SOURCE = {
        id: 'co-state',
        name: 'State of Colorado — Public Address Composite',
        url: 'https://gis.colorado.gov/public/rest/services/Address_and_Parcel/Colorado_Public_Addresses/MapServer/0/query',
        fields: (a) => ({
            // Some counties zero-pad AddrNum (Summit "0967") — emit plain.
            hn: String(a.AddrNum ?? '').trim().replace(/^0+(?=\d)/, ''),
            street: composeStreet(a),
            address: a.AddrFull || '',
            city: a.PlaceName || '',
            zip: a.Zipcode || '',
            county: a.County || '',
            subtype: a.Place_Type || '',
        }),
    };

    const LOCAL_SOURCES = [
        {
            id: 'cosp',
            name: 'El Paso County (COSP GIS)',
            url: 'https://gis.coloradosprings.gov/arcgis/rest/services/GeneralUse/LandRecords/MapServer/0/query',
            // ⚠️ 2026-07-21: this "city" service is actually EL PASO COUNTY-WIDE —
            // verified at Peyton (House Rock Dr: 44 points incl. the POST-replat
            // street names; the statewide composite only had the pre-replat
            // ARRIBA/NEDERLAND generation there). Old city-metro bbox was clipping
            // it to COSP and pushing county areas onto the stale statewide source.
            // bbox ≈ El Paso County; north edge 39.129 = the Douglas county line
            // (listed FIRST, so the boundary band resolves to El Paso, correctly).
            bbox: [-105.26, 38.52, -104.05, 39.129],
            fields: (a) => ({
                hn: a.Add_Number,
                street: a.FullStreet || '',
                address: a.FullAddress || '',
                city: a.City || '',
                zip: a.Post_Code || '',
                subtype: a.SUBTYPE || '',
            }),
        },
        {
            id: 'douglas',
            name: 'Douglas County',
            // ⚠️ 2026-07-21: the old Address/FeatureServer/0 (the one the WME GIS
            // Layers sheet still lists) now has ZERO layers — every query 400s
            // "Invalid URL". Replaced with the org's AddressSearch view: same
            // split-field schema (verified live), statuses only RECORDED/RELEASED.
            // STREET_NAME_FULL is still the full ADDRESS ("230 THIRD ST"), so build
            // the bare street from the split fields instead.
            url: 'https://services.arcgis.com/seTexOicoRXDvRsJ/ArcGIS/rest/services/AddressSearch/FeatureServer/0/query',
            // East edge = the real Douglas/Elbert county line (~-104.662), NOT the
            // old -104.55: the rectangle was claiming Elbert points (Loblolly Pine
            // Cir 2026-07-21) and mispicking Douglas for them.
            bbox: [-105.33, 39.12, -104.662, 39.57],
            fields: (a) => ({
                hn: a.ADDRESS_NUMBER,
                street: joinStreet([
                    a.STREET_PREDIRECTION_CODE, a.STREET_NAME, a.STREET_TYPE_CODE, a.STREET_POSTDIRECTION_CODE,
                ]),
                address: a.STREET_NAME_FULL || '',
                city: a.POSTAL_NAME || '',
                zip: a.ZIP_CODE || '',
                subtype: a.ADDRESS_USE || '',
            }),
        },
        // ── CO county bulk-add (2026-07-21, Josh's ruling: statewide = LAST
        // resort — it lags new construction and can carry pre-replat street
        // names). Wired from the WME GIS Layers sheet; every entry below was
        // schema-probed + live-queried (except Adams: Cloudflare-gated to curl,
        // schema from the sheet's label field — error/empty falls back to
        // statewide anyway). bboxes = each layer's own 4326 data extent, listed
        // MOST-SPECIFIC (smallest) FIRST so overlapping edges resolve narrow.
        // Excluded as dead/unusable upstream: Delta, Montrose, Rio Blanco,
        // Gilpin, Teller (DNS gone), Park (HTML at REST), Sedgwick + Commerce
        // City (timeouts), San Miguel (parcel-OWNERSHIP points, no addresses).
        {
            id: 'broomfield',
            name: 'Broomfield County',
            url: 'https://services1.arcgis.com/vXSRPZbyyOmH9pek/arcgis/rest/services/Addresses/FeatureServer/0/query',
            bbox: [-105.164, 39.889, -104.951, 40.044],
            fields: (a) => ({
                hn: a.ADDRESS_NUMBER,
                street: joinStreet([
                    a.STREET_PREDIRECTIONAL, a.STREET_PRETYPE, a.STREET_NAME,
                    a.STREET_POSTTYPE, a.STREET_POSTDIRECTIONAL,
                ]),
                address: a.FULL_ADDRESS || '',
                city: a.CITY || '',
                zip: a.ZIPCODE || '',
                subtype: a.FEATURE_TYPE || '',
            }),
        },
        {
            id: 'boulder',
            name: 'Boulder County',
            url: 'https://maps.bouldercounty.org/arcgis/rest/services/PARCELS/ADDRESS_POINTS/MapServer/0/query',
            bbox: [-105.646, 39.912, -105.051, 40.263],
            fields: (a) => ({
                hn: a.STREET_NUMBER,
                street: joinStreet([a.PREFIX, a.PRETYPE, a.STREETNAME, a.STREETTYPE, a.SUFFIX]),
                address: a.FULL_ADDRESS || '',
                city: a.POSTAL_CITY || a.CITY || '',
                zip: a.ZIPCODE || '',
                subtype: a.ADDRESS_SOURCE || '',
            }),
        },
        {
            id: 'jefferson',
            name: 'Jefferson County',
            // No bare house-number field — parse it off the full ADDRESS.
            url: 'https://mapservices2.jeffco.us/arcgis/rest/services/jMap/Address/MapServer/0/query',
            bbox: [-105.399, 39.182, -105.053, 39.914],
            fields: (a) => ({
                hn: String(a.ADDRESS || '').trim().split(' ')[0],
                street: joinStreet([
                    a.STREET_DIRECTION_PREFIX, a.STREET_NAME, a.STREET_TYPE, a.STREET_DIRECTION_SUFFIX,
                ]),
                address: a.ADDRESS || '',
                city: a.CITY_POSTAL || '',
                zip: a.ZIP || '',
                subtype: a.ADDRESS_TYPE || '',
            }),
        },
        {
            id: 'arapahoe',
            name: 'Arapahoe County',
            url: 'https://gis.arapahoegov.com/arcgis/rest/services/OpenDataService/MapServer/4/query',
            bbox: [-105.058, 39.549, -103.715, 39.787],
            fields: (a) => ({
                hn: a.Number,
                street: joinStreet([a.Pre_Direction, a.Street_Name, a.Street_Type, a.Suffix_Direction]),
                address: a.Full_Address || '',
                city: a.City_State || '',
                zip: a.Zip || '',
                subtype: a.Bldg_Type || '',
            }),
        },
        {
            id: 'pitkin',
            name: 'Pitkin County',
            url: 'https://gispub.cityofaspen.com/server/rest/services/PitkinCounty/Pitkin_Layers/MapServer/1/query',
            bbox: [-107.367, 38.997, -106.495, 39.401],
            fields: (a) => ({
                hn: a.STREET_NU,
                street: a.NAME || '',
                address: a.ADDRESS || '',
                city: '',
                zip: a.ZIP || '',
                subtype: a.AddressType || '',
            }),
        },
        {
            id: 'adams',
            name: 'Adams County',
            // ⚠️ Cloudflare-challenged to plain curl — schema from the GIS Layers
            // sheet (label field ADDR_FULL), NOT live-probed. bbox ≈ county
            // bounds. If the challenge also blocks GM_xmlhttpRequest, the
            // error/empty fallback rides statewide as before.
            url: 'https://gisapp.adcogov.org/arcgis/rest/services/AdamsCountyBasic/MapServer/32/query',
            bbox: [-105.053, 39.738, -103.706, 40.003],
            fields: (a) => ({
                hn: String(a.ADDR_FULL || '').trim().split(' ')[0],
                street: String(a.ADDR_FULL || '').trim().split(' ').slice(1).join(' '),
                address: a.ADDR_FULL || '',
                city: '',
                zip: '',
                subtype: '',
            }),
        },
        {
            id: 'montezuma',
            name: 'Montezuma County',
            url: 'https://gis-server.co.montezuma.co.us/arcgis/rest/services/Address_Verification_Viewer/MapServer/0/query',
            bbox: [-109.041, 37.217, -108.066, 37.632],
            fields: (a) => ({
                hn: a.StreetNo,
                street: joinStreet([a.StreetDir, a.StreetName, a.StreetSuf, a.StDirSuffx]),
                address: joinStreet([a.StreetNo, a.StreetDir, a.StreetName, a.StreetSuf]),
                city: a.City || '',
                zip: a.ZipCode || '',
                subtype: a.AddressUse || '',
            }),
        },
        {
            id: 'eagle',
            name: 'Eagle County',
            url: 'https://map.eaglecounty.us/arcgiswa/rest/services/FlexApp/Address_ForLabel/MapServer/0/query',
            bbox: [-107.125, 39.354, -106.227, 39.924],
            fields: (a) => ({
                hn: a.STREETNO,
                street: joinStreet([a.STREETDIR, a.STREETNAME, a.STREETSUF]),
                address: a.Address || '',
                city: a.LOCCITY || '',
                zip: '',
                subtype: '',
            }),
        },
        {
            id: 'summit',
            name: 'Summit County',
            // 2026-07-22 (Beeler Pl, Copper Mtn): the sheet's Address_Points layer
            // is EMPTY (0 records) — the live one, found via the org folder, is
            // AddressesForGeocoding (41.8k, split fields; the CR alias sits in its
            // own Alias column, not the street name). Summit zero-pads house
            // numbers ("0902") — we emit them PLAIN (902, Josh's call 2026-07-22).
            // bbox = data extent; listed AFTER Eagle, so the Vail Pass overlap
            // band resolves to Eagle (Vail is real Eagle territory) and Summit's
            // far west (Heeney) rides the empty-Eagle → statewide fallback, which
            // composeStreet's AddrFull parser now handles.
            url: 'https://services6.arcgis.com/dmNYNuTJZDtkcRJq/ArcGIS/rest/services/AddressesForGeocoding/FeatureServer/0/query',
            bbox: [-106.4201, 39.3596, -105.7989, 39.9264],
            fields: (a) => {
                let hn = String(a.HouseNumberValue ?? a.HouseNumber ?? '').trim().replace(/^0+(?=\d)/, '');
                const suffix = String(a.HouseSuffix ?? '').trim();
                if (suffix && !hn.toUpperCase().endsWith(suffix.toUpperCase())) {
                    hn += suffix;
                }
                const status = String(a.SitusStatusDescription ?? '').trim();
                return {
                    hn,
                    street: joinStreet([a.PrefixDirectionAbbreviation, a.StreetName,
                        a.SuffixAbbreviation, a.SuffixDirectionAbbreviation]),
                    address: a.FullAddress || '',
                    city: a.CityName || '',
                    zip: a.ZipCode != null ? String(a.ZipCode) : '',
                    subtype: (a.SitusAddressTypeDescription || '') + (status && status !== 'Current' ? ` (${status})` : ''),
                };
            },
        },
        {
            id: 'pueblo',
            name: 'Pueblo County',
            // The sheet's PuebloCounty_AddressPoints service is gone; the live
            // one (2026-07-21) is ..._AddressPointsLayer.
            url: 'https://maps.co.pueblo.co.us/outside/rest/services/Landbase/PuebloCounty_AddressPointsLayer/MapServer/0/query',
            bbox: [-105.052, 37.775, -104.051, 38.526],
            fields: (a) => ({
                hn: a.ADDRNUM,
                street: joinStreet([a.STPREDIR, a.STPRETYPE, a.STNAME, a.STTYPE, a.STDIR]),
                address: a.FULLADDR || '',
                city: '',
                zip: '',
                subtype: '',
            }),
        },
        {
            id: 'routt',
            name: 'Routt County',
            url: 'https://services6.arcgis.com/VxFGFP4XeHMTNgVs/ArcGIS/rest/services/Routt_County_Addresses/FeatureServer/0/query',
            bbox: [-107.458, 39.912, -106.639, 41.012],
            fields: (a) => ({
                hn: a.Add_Number,
                street: a.LSt_FullNm || a.St_FullNm || '',
                address: a.FullAddress || '',
                city: a.Post_Comm || '',
                zip: a.Post_Code || '',
                subtype: '',
            }),
        },
        {
            id: 'grand',
            name: 'Grand County',
            url: 'https://gis.co.grand.co.us:6443/arcgis/rest/services/Property/AddressPoints/MapServer/0/query',
            bbox: [-106.741, 39.702, -105.572, 40.539],
            fields: (a) => ({
                hn: a.STR_NUM,
                street: joinStreet([a.ST_PDIR, a.ROAD_NAME, a.ST_TYPE, a.ST_SDIR]),
                address: a.COMP_ADDR || '',
                city: a.CITY || '',
                zip: a.ZIP_CODE || '',
                subtype: a.ADDTYPE || '',
            }),
        },
        {
            id: 'weld',
            name: 'Weld County',
            url: 'https://services.arcgis.com/ewjSqmSyHJnkfBLL/ArcGIS/rest/services/Address_Points_open_data/FeatureServer/1/query',
            bbox: [-105.056, 40.001, -103.583, 41.001],
            fields: (a) => ({
                hn: a.HOUSENUM,
                street: a.CC_FULLNAME || joinStreet([a.PRE_DIR, a.PRETYPE, a.STR_NAME, a.STR_TYPE, a.SUF_DIR]),
                address: a.CC_FULLADDR || '',
                city: a.ZIP_COMM || '',
                zip: a.ZIPCODE || '',
                subtype: a.ADDR_TYPE || '',
            }),
        },
        {
            id: 'mesa',
            name: 'Mesa County (E911)',
            // Not in the GIS Layers sheet at all — found via the county's Open
            // Data hub 2026-07-21 (their old gis.mesacounty.us ArcGIS server is
            // retired; mcgis is current). E911 point set, ~90k addresses.
            url: 'https://mcgis.mesacounty.us/arcgis/rest/services/maps/Open_Data/FeatureServer/52/query',
            bbox: [-109.059, 38.502, -107.45, 39.366],
            fields: (a) => ({
                hn: a.COMB_HOUSE_NUMBER || a.HOUSE_NUMBER,
                street: joinStreet([
                    a.PREFIX_DIRECTION, a.PREFIX_TYPE, a.STREET_NAME, a.STREET_TYPE, a.SUFFIX_DIRECTION,
                ]),
                address: a.LOCATION || '',
                city: a.CITY || '',
                zip: a.ZIP || '',
                subtype: '',
            }),
        },
        {
            id: 'lasanimas',
            name: 'Las Animas County',
            // NENA-style coded fields: SAN = house number, StName = full street,
            // FSA = full address, MCN = community.
            url: 'https://services7.arcgis.com/NWWOCaXnjdetEWUz/ArcGIS/rest/services/LasAnimasAddressPts/FeatureServer/0/query',
            bbox: [-105.107, 36.972, -103.004, 37.803],
            fields: (a) => ({
                hn: a.SAN,
                street: a.StName || '',
                address: a.FSA || '',
                city: a.MCN || '',
                zip: a.ZIPCODE || '',
                subtype: a.STRUCTURE || '',
            }),
        },
    ];

    function pickLocalSource(lon, lat) {
        if (lon == null || lat == null || !isFinite(lon) || !isFinite(lat)) {
            return null;
        }
        return LOCAL_SOURCES.find((s) =>
            s.bbox && lon >= s.bbox[0] && lon <= s.bbox[2] && lat >= s.bbox[1] && lat <= s.bbox[3]) || null;
    }

    function sourceHost(src) {
        try {
            return new URL(src.url).hostname;
        } catch {
            return src.url;
        }
    }

    // Configured local jurisdictions, for the tab's persistent "source" line.
    const LOCAL_SOURCE_NAMES = LOCAL_SOURCES.map((s) => s.name).join(', ') || '(none configured yet)';

    // Tunables (Josh can dial these as we learn what the data looks like).
    const CONFIG = {
        // 60 was a suburban assumption — rural CO puts houses (and misplaced
        // pins) hundreds of meters from their GIS point, and a pin whose OWN
        // point isn't fetched can never be flagged `misplaced` (it dies as a
        // row-less no-match). Raised 60 → 500 for the 2026-07-21 Mesa County
        // case; the nearest-point rule is distance-ranked, so a bigger radius
        // doesn't loosen verdicts.
        queryRadiusM: 500,     // how far around an RPP to pull authoritative points
        // The nearest-point rule alone breaks in SPARSE country (2026-07-21,
        // Mesa Co): a pin 150m+ wrong can still have its own point nearest
        // because the next house is farther still. A correctly placed pin sits
        // at/near the structure whatever the driveway length, so beyond this
        // the pin is misplaced even with no closer neighbor. (100 → 50 same
        // day: field pin ~90-105m out sat at the 100 cap edge; Josh set 30 — the
        farOwnM: 30,
        wellPlacedM: 12,       // fast-path: matched point this close → definitely on the right lot, skip the neighbor check
        misplacedMarginM: 8,   // a DIFFERENT address must be at least this much closer than the RPP's own point to call it misplaced (robust to rooftop-vs-frontyard offset; tune up = more conservative)
        wrongHnCloseM: 8,      // a *different*-HN point this close suggests the RPP's HN is wrong
        minZoom: 17,           // below this, RPP data isn't reliably loaded
        maxListedPoints: 8,    // cap per-RPP point list in the console
        goZoomLevel: 19,          // zoom used by the "Go" button (house-level review)
    };

    // 🔢 HN Filler tunables (separate from the probe's — different geometry problem:
    // corridor along a street line, not a radius around a point).
    const HN_CONFIG = {
        // Rural lots set houses 60-120m back from the centerline (Loblolly Pine
        // Cir, Elbert Co 2026-07-21: real points sat 57-111m off the line).
        // DEFAULT only — the tab has a user-editable "Search distance" field
        // (persisted in localStorage) because big parcels put houses 200m+ out.
        corridorM: 150,         // on-street match corridor (default)
        corridorMinM: 30,       // sanity clamp for the user field
        corridorMaxM: 1000,
        mismatchCorridorM: 55,  // street-MISMATCH reporting stays tight: another street 100m out is normal, not a discrepancy
        sampleStepM: 80,        // spacing of GIS query samples along the segment
        maxSegmentsPerScan: 10, // selection cap per scan
        saveQueueLimit: 50,     // WME only saves 50 queued edits — gate on the LIVE unsaved count
        //   (a per-scan cap resets on rescan and can overfill the queue; Josh hit this)
        minZoom: 17,            // same rationale as the probe: model not reliably loaded below this
        selectionPollMs: 300,   // WME fires no reachable selection event (Segment City Tool finding) → poll
    };

    // Street-type normalization so "Springnite Drive" (WME) matches "SPRINGNITE DR"
    // (GIS) — and "Way" matches "Wy", "View" matches "Vw", etc. Every VARIANT maps
    // to one canonical form (USPS Pub 28 App C1 abbreviations); tokens equal to a
    // canonical form pass through untouched. Deliberately NO identity entries
    // (PARK→PARK etc.) — they'd only widen streetCore's trailing-type stripping.
    // 2026-07-21: expanded from 19 full-word pairs after "Way" vs GIS "Wy" broke
    // the HN Filler (and "View"/"Vw" would have too — WME uses both forms).
    const STREET_TYPES = {
        DRIVE: 'DR', DRV: 'DR', STREET: 'ST', STR: 'ST', AVENUE: 'AVE', AV: 'AVE', AVEN: 'AVE',
        ROAD: 'RD', COURT: 'CT', CRT: 'CT', LANE: 'LN', CIRCLE: 'CIR', CIRC: 'CIR',
        BOULEVARD: 'BLVD', BOUL: 'BLVD', PLACE: 'PL', TRAIL: 'TRL', TR: 'TRL',
        PARKWAY: 'PKWY', PKY: 'PKWY', TERRACE: 'TER', TERR: 'TER', POINT: 'PT', POINTE: 'PT',
        HEIGHTS: 'HTS', SQUARE: 'SQ', SQR: 'SQ', HIGHWAY: 'HWY', HIWAY: 'HWY',
        CRESCENT: 'CRES', GROVE: 'GRV', VIEW: 'VW', WY: 'WAY', LP: 'LOOP',
        ALLEY: 'ALY', BEND: 'BND', BLUFF: 'BLF', BLUFFS: 'BLFS', BRANCH: 'BR', BRIDGE: 'BRG',
        BROOK: 'BRK', CANYON: 'CYN', CAPE: 'CPE', CENTER: 'CTR', CENTRE: 'CTR',
        CLIFF: 'CLF', CLIFFS: 'CLFS', COMMON: 'CMN', COMMONS: 'CMNS', CORNER: 'COR',
        CORNERS: 'CORS', COURSE: 'CRSE', COVE: 'CV', CREEK: 'CRK', CREST: 'CRST',
        CROSSING: 'XING', DALE: 'DL', ESTATE: 'EST', ESTATES: 'ESTS', EXPRESSWAY: 'EXPY',
        EXTENSION: 'EXT', FALLS: 'FLS', FIELD: 'FLD', FIELDS: 'FLDS', FOREST: 'FRST',
        FORK: 'FRK', FREEWAY: 'FWY', GARDEN: 'GDN', GARDENS: 'GDNS', GATEWAY: 'GTWY',
        GLEN: 'GLN', GREEN: 'GRN', HARBOR: 'HBR', HILL: 'HL', HILLS: 'HLS', HOLLOW: 'HOLW',
        ISLAND: 'IS', JUNCTION: 'JCT', KNOLL: 'KNL', KNOLLS: 'KNLS', LAKE: 'LK',
        LANDING: 'LNDG', MANOR: 'MNR', MEADOW: 'MDW', MEADOWS: 'MDWS', MILL: 'ML',
        MOUNT: 'MT', MOUNTAIN: 'MTN', ORCHARD: 'ORCH', PLAZA: 'PLZ', RANCH: 'RNCH',
        RIDGE: 'RDG', RIVER: 'RIV', SHORE: 'SHR', SHORES: 'SHRS', SPRING: 'SPG',
        SPRINGS: 'SPGS', SUMMIT: 'SMT', TRACE: 'TRCE', TUNNEL: 'TUNL', TURNPIKE: 'TPKE',
        VALLEY: 'VLY', VILLAGE: 'VLG', VISTA: 'VIS', VSTA: 'VIS',
    };

    let wmeSdk = null;

    // ---- geometry / model helpers --------------------------------------------

    function distMeters(lon1, lat1, lon2, lat2) {
        return turf.distance(turf.point([lon1, lat1]), turf.point([lon2, lat2]), { units: 'kilometers' }) * 1000;
    }

    function getZoom() {
        try {
            if (wmeSdk && wmeSdk.Map && wmeSdk.Map.getZoomLevel) {
                return wmeSdk.Map.getZoomLevel();
            }
        } catch { /* fall through to legacy */ }
        try {
            return W.map.getZoom();
        } catch {
            return null;
        }
    }

    // WGS84 [west, south, east, north] for the current view, or null.
    function getMapExtentBbox() {
        try {
            if (wmeSdk && wmeSdk.Map && wmeSdk.Map.getMapExtent) {
                const e = wmeSdk.Map.getMapExtent();
                if (Array.isArray(e) && e.length === 4) {
                    return e;
                }
            }
        } catch { /* fall through to legacy */ }
        try {
            const e = W.map.getExtent();   // WME v2.354: returns a WGS84 [w, s, e, n] array
            if (Array.isArray(e) && e.length === 4) {
                return e;
            }
        } catch { /* no extent available — caller will skip the in-view filter */ }
        return null;
    }

    function venueCentroidLonLat(venue) {
        try {
            const geom = venue.getOLGeometry();
            if (!geom) {
                return null;
            }
            const centroid = geom.getCentroid ? geom.getCentroid() : geom;
            const gj = W.userscripts.toGeoJSONGeometry(centroid);
            const lon = gj.coordinates[0];
            const lat = gj.coordinates[1];
            if (!isFinite(lon) || !isFinite(lat)) {
                return null;
            }
            return [lon, lat];
        } catch {
            return null;
        }
    }

    function getVisibleRPPs() {
        const bbox = getMapExtentBbox();
        const out = [];
        const venues = (W && W.model && W.model.venues && W.model.venues.objects) ? W.model.venues.objects : {};
        for (const id in venues) {
            const venue = W.model.venues.getObjectById(id);
            if (!venue || !venue.attributes || !venue.attributes.categories) {
                continue;
            }
            if (!venue.attributes.categories.includes('RESIDENCE_HOME')) {
                continue;
            }
            const pt = venueCentroidLonLat(venue);
            if (!pt) {
                continue;
            }
            if (bbox && (pt[0] < bbox[0] || pt[0] > bbox[2] || pt[1] < bbox[1] || pt[1] > bbox[3])) {
                continue;
            }
            out.push(venue);
        }
        return out;
    }

    function getRppInfo(venue) {
        const pt = venueCentroidLonLat(venue) || [NaN, NaN];
        let street = '';
        try {
            const st = W.model.streets.getObjectById(venue.attributes.streetID);
            street = st?.attributes?.name || '';   // WME street name lives on .attributes.name, not .name
        } catch { /* no street resolvable */ }
        return {
            id: venue.attributes.id,
            hn: venue.attributes.houseNumber,
            street,
            lon: pt[0],
            lat: pt[1],
        };
    }

    // ---- street matching ------------------------------------------------------

    // Numbered-route canonicalization (2026-07-21): WME Colorado conventions are
    // CR-123 (county road), SH-23 (state highway — GIS says CO-23 / COLORADO 23 /
    // STATE HIGHWAY 23), WCR-45 (Weld's county roads — same road GIS calls plain
    // COUNTY ROAD 45, so WCR folds into CR; corridor geometry keeps counties
    // apart), US-85, I-25. Patterns are anchored prefix+number, so real names
    // that merely contain these words ("Highway View Dr") never match. Leading
    // zeros in the number are dropped ("COUNTY ROAD 007" = CR-7).
    // Known gap: directional-prefixed county roads ("E County Road 30") pass
    // through unrouted.  Order matters: CR forms (incl. "CO RD") before the SH
    // catch-all that claims bare CO/HWY.
    // Bare HIGHWAY/HWY is system-AMBIGUOUS (could be a US or state route) —
    // canonical 'HWY n' acts as a wildcard against SH/US in parseRoute below
    // (v.22: GIS "HIGHWAY 6 AND 50" vs WME "US-50" — the Mesa County US-6/US-50
    // concurrency; the old HWY→SH mapping made "HIGHWAY 50" conflict with US-50).
    const ROUTE_FORMS = [
        [/^(?:US (?:HIGHWAY|HWY|ROUTE)|U S HIGHWAY|US|HIGHWAY|HWY) 0*(\d+[A-Z]?) (?:AND|&) 0*(\d+[A-Z]?)$/, 'HWY', 2],
        [/^(?:WELD COUNTY (?:ROAD|RD)|WELD CR|WCR) 0*(\d+[A-Z]?)$/, 'CR'],
        [/^(?:COUNTY (?:ROAD|RD)|CNTY RD|CO RD|CR) 0*(\d+[A-Z]?)$/, 'CR'],
        [/^(?:US (?:HIGHWAY|HWY|ROUTE)|U S HIGHWAY|US) 0*(\d+[A-Z]?)$/, 'US'],
        [/^(?:INTERSTATE|IH|I) 0*(\d+[A-Z]?)$/, 'I'],
        [/^(?:STATE (?:HIGHWAY|HWY|ROUTE)|ST HWY|SR|SH|COLORADO|COLO|CO) 0*(\d+[A-Z]?)$/, 'SH'],
        [/^(?:HIGHWAY|HWY) 0*(\d+[A-Z]?)$/, 'HWY'],
    ];

    function canonicalizeRoute(cleaned) {
        for (const [re, prefix, two] of ROUTE_FORMS) {
            const m = cleaned.match(re);
            if (m) {
                return two ? `${prefix} ${m[1]}&${m[2]}` : `${prefix} ${m[1]}`;
            }
        }
        return null;
    }

    // {dir, sys, nums} for a canonical route string ('US 50', 'W CR 4',
    // 'HWY 6&50'), else null. dir is the optional leading directional a
    // directional-prefixed county road carries (v.35 — the old "E County
    // Road 30 passes through unrouted" gap).
    function parseRoute(n) {
        const m = n.match(/^(?:(N|S|E|W|NE|NW|SE|SW) )?(CR|SH|US|I|HWY) (\d+[A-Z]?)(?:&(\d+[A-Z]?))?$/);
        if (!m) {
            return null;
        }
        const nums = new Set([m[3]]);
        if (m[4]) {
            nums.add(m[4]);
        }
        return { dir: m[1] || null, sys: m[2], nums };
    }

    // Ordinal street names (2026-07-21): GIS spells them out (FIRST, SECOND,
    // TWENTY FIRST) while road signs — and therefore WME — use 1st/2nd/21st.
    // Everything canonicalizes to the digit form; compounds are merged from
    // their two tokens (hyphens already became spaces upstream).
    const ORDINAL_WORDS = {
        FIRST: '1ST', SECOND: '2ND', THIRD: '3RD', FOURTH: '4TH', FIFTH: '5TH',
        SIXTH: '6TH', SEVENTH: '7TH', EIGHTH: '8TH', NINTH: '9TH', TENTH: '10TH',
        ELEVENTH: '11TH', TWELFTH: '12TH', THIRTEENTH: '13TH', FOURTEENTH: '14TH',
        FIFTEENTH: '15TH', SIXTEENTH: '16TH', SEVENTEENTH: '17TH', EIGHTEENTH: '18TH',
        NINETEENTH: '19TH', TWENTIETH: '20TH', THIRTIETH: '30TH', FORTIETH: '40TH',
        FIFTIETH: '50TH', SIXTIETH: '60TH', SEVENTIETH: '70TH', EIGHTIETH: '80TH',
        NINETIETH: '90TH',
    };
    const ORDINAL_TENS = {
        TWENTY: 20, THIRTY: 30, FORTY: 40, FIFTY: 50, SIXTY: 60, SEVENTY: 70, EIGHTY: 80, NINETY: 90,
    };
    const ORDINAL_UNITS = {
        FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5, SIXTH: 6, SEVENTH: 7, EIGHTH: 8, NINTH: 9,
    };

    function ordinalSuffix(unit) {
        if (unit === 1) {
            return 'ST';
        }
        if (unit === 2) {
            return 'ND';
        }
        return unit === 3 ? 'RD' : 'TH';
    }

    // "TWENTY FIRST" → "21ST", "FOURTH" → "4TH"; non-ordinal tokens pass through.
    function canonicalizeOrdinals(tokens) {
        const out = [];
        for (let i = 0; i < tokens.length; i++) {
            const tens = ORDINAL_TENS[tokens[i]];
            const unit = i + 1 < tokens.length ? ORDINAL_UNITS[tokens[i + 1]] : undefined;
            if (tens && unit) {
                out.push(`${tens + unit}${ordinalSuffix(unit)}`);
                i++;
                continue;
            }
            out.push(ORDINAL_WORDS[tokens[i]] || tokens[i]);
        }
        return out;
    }

    // Cardinal directionals (2026-07-21): TRANSLATE spelled-out forms at the
    // name's ends (EAST WOODMEN → E WOODMEN — positional, so a mid-name "North"
    // is never touched), then in streetsMatch: a directional present on ONE side
    // only is IGNORED (source omitted it — Josh: "in some cases just ignore"),
    // while CONFLICTING directionals refuse (E Woodmen ≠ W Woodmen).
    const DIR_CANON = {
        NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
        NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
    };
    const DIR_SET = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

    function normalizeStreet(name) {
        if (!name) {
            return '';
        }
        // Hyphens count as spaces ("CR-123", "Smith-Jones Rd") — both sides get
        // the same treatment, and the space-squash fallback covers merged forms.
        const cleaned = String(name).toUpperCase()
            .replace(/\./g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
        const route = canonicalizeRoute(cleaned);
        if (route) {
            return route;
        }
        const tokens = canonicalizeOrdinals(cleaned.split(' '));
        if (tokens.length > 1 && DIR_CANON[tokens[0]]) {
            tokens[0] = DIR_CANON[tokens[0]];
        }
        if (tokens.length > 1 && DIR_CANON[tokens[tokens.length - 1]]) {
            tokens[tokens.length - 1] = DIR_CANON[tokens[tokens.length - 1]];
        }
        // Directional-prefixed/suffixed numbered routes (v.35 — closes the old
        // "E County Road 30 passes through unrouted" gap; hit live on Berthoud's
        // "W CR-4" vs GIS "W COUNTY ROAD 4"): peel the directional, route the
        // remainder, carry the directional in front ('W CR 4'). Anchored route
        // regexes keep real names ("N Highway View Dr") untouched.
        if (tokens.length > 2) {
            if (DIR_SET.has(tokens[0])) {
                const r = canonicalizeRoute(tokens.slice(1).join(' '));
                if (r) {
                    return `${tokens[0]} ${r}`;
                }
            }
            if (DIR_SET.has(tokens[tokens.length - 1])) {
                const r = canonicalizeRoute(tokens.slice(0, -1).join(' '));
                if (r) {
                    return `${tokens[tokens.length - 1]} ${r}`;
                }
            }
        }
        return tokens.map((tok) => STREET_TYPES[tok] || tok).join(' ');
    }

    // The directional a normalized name carries (leading preferred, else
    // trailing post-directional), or null.
    function dirOf(n) {
        const t = n.split(' ');
        if (t.length > 1 && DIR_SET.has(t[0])) {
            return t[0];
        }
        if (t.length > 1 && DIR_SET.has(t[t.length - 1])) {
            return t[t.length - 1];
        }
        return null;
    }

    function stripDirs(n) {
        const t = n.split(' ');
        if (t.length > 1 && DIR_SET.has(t[0])) {
            t.shift();
        }
        if (t.length > 1 && DIR_SET.has(t[t.length - 1])) {
            t.pop();
        }
        return t.join(' ');
    }

    const TYPE_ABBREVS = new Set(Object.values(STREET_TYPES));

    function coreFromNorm(n) {
        const tokens = n.split(' ');
        if (tokens.length > 1 && TYPE_ABBREVS.has(tokens[tokens.length - 1])) {
            tokens.pop();
        }
        return tokens.join(' ');
    }

    function streetCore(name) {
        return coreFromNorm(normalizeStreet(name));
    }

    // Two NORMALIZED names: exact match, OR one side minus its trailing type
    // equals the OTHER SIDE IN FULL (one-sided strip, v.3: accepts an omitted
    // type AND names ending in type-looking words, refuses conflicting types),
    // each also tried space-squashed (v.4: "Needle Leaf" vs "NEEDLELEAF").
    function pairMatches(x, y) {
        if (x === y || coreFromNorm(x) === y || coreFromNorm(y) === x) {
            return true;
        }
        const sq = (s) => s.replace(/ /g, '');
        return sq(x) === sq(y) || sq(coreFromNorm(x)) === sq(y) || sq(coreFromNorm(y)) === sq(x);
    }

    // v.14 directional layer on top: conflicting directionals refuse outright;
    // a directional on ONE side only is ignored (one-sided strip, same doctrine
    // as types); same directional on BOTH sides also matches position-blind
    // ("N ACADEMY BLVD" vs "ACADEMY BLVD N").
    function streetsMatch(a, b) {
        const na = normalizeStreet(a);
        const nb = normalizeStreet(b);
        // Routes match on SYSTEM + NUMBER-SET intersection: a concurrency
        // ("HWY 6&50") matches either member route; the ambiguous HWY system
        // wildcards against SH/US (never CR/I). Route vs non-route never match.
        const ra = parseRoute(na);
        const rb = parseRoute(nb);
        if (ra || rb) {
            if (!ra || !rb) {
                return false;
            }
            // Same directional doctrine as real names (v.35): conflicting
            // sides refuse ("W CR 4" ≠ "E CR 4"), one-sided is ignored.
            if (ra.dir && rb.dir && ra.dir !== rb.dir) {
                return false;
            }
            const wildcardOk = (x, y) => x.sys === 'HWY' && (y.sys === 'SH' || y.sys === 'US' || y.sys === 'HWY');
            if (ra.sys !== rb.sys && !wildcardOk(ra, rb) && !wildcardOk(rb, ra)) {
                return false;
            }
            return [...ra.nums].some((n) => rb.nums.has(n));
        }
        const da = dirOf(na);
        const db = dirOf(nb);
        if (da && db && da !== db) {
            return false;
        }
        if (pairMatches(na, nb)) {
            return true;
        }
        if (da && !db) {
            return pairMatches(stripDirs(na), nb);
        }
        if (db && !da) {
            return pairMatches(na, stripDirs(nb));
        }
        if (da && db) {
            return pairMatches(stripDirs(na), stripDirs(nb));
        }
        return false;
    }

    // ---- GIS query ------------------------------------------------------------

    // Join non-empty street parts in reading order, e.g. ["N","ACADEMY","BLVD"] →
    // "N ACADEMY BLVD". Used by sources whose schema splits the street into
    // directional/name/type columns. (streetsMatch/normalizeStreet handle case +
    // type abbreviations downstream.)
    function joinStreet(parts) {
        return parts.map((p) => (p == null ? '' : String(p).trim())).filter(Boolean).join(' ');
    }

    // The statewide composite's component column names. Some counties publish
    // NULL components with the street only inside AddrFull (Summit, found
    // 2026-07-22: "0967 Beeler PL (CR 1194)" — zero-padded HN + parenthetical
    // county-road alias) — fall back to parsing AddrFull: drop the trailing
    // "(...)" alias, strip the leading house-number token, and if nothing is
    // left the alias itself IS the street ("0050 CR 1201"-style records keep
    // "CR 1201" via the normal strip).
    function composeStreet(a) {
        const joined = joinStreet([a.PreDir, a.PreType, a.StreetName, a.PostType, a.PostDir]);
        if (joined) {
            return joined;
        }
        const full = String(a.AddrFull ?? '').trim();
        if (!full) {
            return '';
        }
        const alias = (full.match(/\(([^)]+)\)\s*$/) || [])[1] || '';
        const street = full
            .replace(/\s*\([^)]*\)\s*$/, '')
            .replace(/^\d+[A-Za-z]?(?:\s+(?:1\/2|½))?\s+/, '')
            .trim();
        return street || alias.trim();
    }

    // Query ONE source's address-point service around (lon,lat). Resolves to
    // { error, points: [{hn, street, address, city, zip, subtype, lon, lat}] }.
    // outFields=* so each source's own field names are available to its fields()
    // mapper; we query inSR=outSR=4326 so any native SR (State Plane, etc.) is
    // reprojected to WGS84 server-side for distance math.
    function queryOneSource(source, lon, lat, radiusMeters) {
        const params = new URLSearchParams({
            f: 'json',
            where: '1=1',
            geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
            geometryType: 'esriGeometryPoint',
            inSR: '4326',
            outSR: '4326',
            distance: String(radiusMeters),
            units: 'esriSRUnit_Meter',
            spatialRel: 'esriSpatialRelIntersects',
            outFields: '*',
            returnGeometry: 'true',
        });
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${source.url}?${params.toString()}`,
                timeout: 15000,
                onload: (res) => {
                    if (res.status >= 400) {
                        resolve({ error: `HTTP ${res.status}`, points: [] });
                        return;
                    }
                    try {
                        const data = JSON.parse(res.responseText);
                        if (data.error) {
                            resolve({ error: data.error.message || 'ArcGIS error', points: [] });
                            return;
                        }
                        const points = (data.features || []).map((ft) => {
                            const mapped = source.fields(ft.attributes || {});
                            return {
                                hn: mapped.hn,
                                street: mapped.street || '',
                                address: mapped.address || '',
                                city: mapped.city || '',
                                zip: mapped.zip || '',
                                county: mapped.county || '',
                                subtype: mapped.subtype || '',
                                lon: ft.geometry ? ft.geometry.x : null,
                                lat: ft.geometry ? ft.geometry.y : null,
                            };
                        });
                        resolve({ error: null, points });
                    } catch (e) {
                        resolve({ error: `parse error: ${e.message}`, points: [] });
                    }
                },
                onerror: () => resolve({ error: 'network error (check @connect grant)', points: [] }),
                ontimeout: () => resolve({ error: 'timeout', points: [] }),
            });
        });
    }

    // ---- verdict logic --------------------------------------------------------

    function rppHnString(info) {
        return (info.hn != null && String(info.hn).trim() !== '') ? String(info.hn).trim() : null;
    }

    function evaluateRpp(info, points) {
        const annotated = points
            .map((p) => ({
                ...p,
                dist: (p.lon != null && p.lat != null) ? distMeters(info.lon, info.lat, p.lon, p.lat) : Infinity,
            }))
            .sort((a, b) => a.dist - b.dist);

        const rppHn = rppHnString(info);

        if (!points.length) {
            return { code: 'no-gis', msg: 'no authoritative points within radius (coverage gap / rural / off-area)', annotated };
        }
        if (rppHn == null) {
            return { code: 'no-hn', msg: 'RPP has no house number to check', annotated };
        }

        const hnStreetMatches = annotated.filter((p) => String(p.hn) === rppHn && streetsMatch(p.street, info.street));
        if (hnStreetMatches.length) {
            const own = hnStreetMatches[0];
            // Fast path: matched point essentially on top of the RPP → definitely the right lot.
            if (own.dist <= CONFIG.wellPlacedM) {
                return { code: 'ok', msg: `HN ${rppHn} correct & well-placed — ${own.dist.toFixed(1)}m from "${own.address}"`, target: own, annotated };
            }
            // Nearest-point rule: if a DIFFERENT address sits clearly closer than the RPP's own
            // point, the pin is on the wrong lot (misplaced). Otherwise the RPP's own point is
            // (effectively) the nearest → it's on its own lot, just offset from the GIS point
            // (rooftop-vs-frontyard jitter — NOT an error). Robust to lot size / setback.
            const nearestOther = annotated.find((p) => p.address !== own.address);
            if (nearestOther && nearestOther.dist + CONFIG.misplacedMarginM < own.dist) {
                return {
                    code: 'misplaced',
                    msg: `MISPLACED — pin is ${own.dist.toFixed(1)}m from its own "${own.address}", but "${nearestOther.address}" sits closer (${nearestOther.dist.toFixed(1)}m) → likely on the wrong lot; correct location (${own.lon.toFixed(6)}, ${own.lat.toFixed(6)})`,
                    target: own,
                    annotated,
                };
            }
            // Sparse-country cap (v.23): own-point-nearest is no excuse beyond
            // farOwnM — with no neighbors for 100m+, a badly misplaced rural pin
            // otherwise verdicts `ok` (Mesa Co 2026-07-21).
            if (own.dist > CONFIG.farOwnM) {
                return {
                    code: 'misplaced',
                    msg: `MISPLACED — pin is ${own.dist.toFixed(1)}m from its own "${own.address}" (beyond the ${CONFIG.farOwnM}m cap; no other address nearer); correct location (${own.lon.toFixed(6)}, ${own.lat.toFixed(6)})`,
                    target: own,
                    annotated,
                };
            }
            return {
                code: 'ok',
                msg: `HN ${rppHn} on its own lot — own point is nearest at ${own.dist.toFixed(1)}m (offset from the GIS point, not misplaced)`,
                target: own,
                annotated,
            };
        }

        const hnAnyMatches = annotated.filter((p) => String(p.hn) === rppHn);
        if (hnAnyMatches.length) {
            const n = hnAnyMatches[0];
            return {
                code: 'hn-diff-street',
                msg: `HN ${rppHn} exists ${n.dist.toFixed(1)}m away but on "${n.street}" (RPP street "${info.street || '∅'}") — verify street`,
                target: n,
                annotated,
            };
        }

        const closest = annotated[0];
        if (closest && closest.dist <= CONFIG.wrongHnCloseM) {
            return {
                code: 'wrong-hn',
                msg: `possible WRONG HN — closest authoritative point is ${closest.dist.toFixed(1)}m away: "${closest.address}" (HN ${closest.hn}), RPP says ${rppHn}`,
                target: closest,
                annotated,
            };
        }
        return {
            code: 'no-match',
            msg: `no authoritative HN ${rppHn} nearby; closest is "${closest.address}" at ${closest.dist.toFixed(1)}m — review`,
            target: closest,
            annotated,
        };
    }

    function verdictStyle(code) {
        if (code === 'ok') {
            return 'color:#0a0;font-weight:bold';
        }
        if (code === 'no-gis' || code === 'no-hn') {
            return 'color:#888';
        }
        return 'color:#d80;font-weight:bold';
    }

    // ---- main probe -----------------------------------------------------------

    async function probeVisibleRPPs() {
        const zoom = getZoom();
        if (zoom != null && zoom < CONFIG.minZoom) {
            console.warn(`${LOG} zoom ${zoom} < ${CONFIG.minZoom} — zoom in before probing (RPP data not fully loaded).`);
            setProbeStatus(`⚠️ Zoom in to level ${CONFIG.minZoom}+ before probing (RPP data isn't fully loaded at zoom ${zoom}).`, '#b26a00');
            return;
        }

        const rpps = getVisibleRPPs();
        setProbeScanning(true);
        clearProbeResults();
        if (!rpps.length) {
            setProbeScanning(false);
            setProbeStatus('No RPPs in view — pan/zoom to an area with residential point places, then probe.', '#444');
            return;
        }

        // Pick the GIS source ONCE for this scan, by the view centre: prefer a
        // local county/city service whose bbox covers it, else the statewide
        // composite. (A single WME view sits within one jurisdiction.) If the
        // chosen local source errors mid-scan, switch to statewide for the rest.
        const vb = getMapExtentBbox();
        const center = vb
            ? [(vb[0] + vb[2]) / 2, (vb[1] + vb[3]) / 2]
            : [getRppInfo(rpps[0]).lon, getRppInfo(rpps[0]).lat];
        const requestedLocal = pickLocalSource(center[0], center[1]);
        let activeSource = requestedLocal || STATEWIDE_SOURCE;
        let usedFallback = false;
        console.log(`%c${LOG} probing ${rpps.length} visible RPP(s) vs ${activeSource.name} [${sourceHost(activeSource)}] — READ-ONLY, no edits.`, 'color:#0a7;font-weight:bold');

        const tally = {};
        const misplaced = [];   // → result rows with a Snap button
        // wrong-hn / hn-diff-street / no-match → report-only rows (v.21: these
        // were console-only; a found problem showed an empty tab).
        const review = [];
        // EVERY scanned RPP with its pin→GIS-point distance (v.27, Josh: "so I
        // know the RPPs being seen actually show on GIS").
        const allScanned = [];
        for (let idx = 0; idx < rpps.length; idx++) {
            const rpp = rpps[idx];
            setProbeStatus(`⏳ Scanning ${idx + 1}/${rpps.length} via ${sourceHost(activeSource)}…`, '#06c');
            const info = getRppInfo(rpp);
            console.group(`${LOG} RPP ${info.id} — HN=${info.hn ?? '∅'} St="${info.street || '∅'}" @ (${info.lon.toFixed(6)}, ${info.lat.toFixed(6)})`);
            let { error, points } = await queryOneSource(activeSource, info.lon, info.lat, CONFIG.queryRadiusM);
            if (error && activeSource.id !== STATEWIDE_SOURCE.id) {
                console.warn(`${LOG} ${activeSource.name} failed (${error}) → falling back to ${STATEWIDE_SOURCE.name} for the rest of this scan.`);
                usedFallback = true;
                activeSource = STATEWIDE_SOURCE;
                ({ error, points } = await queryOneSource(activeSource, info.lon, info.lat, CONFIG.queryRadiusM));
            }
            if (error) {
                console.warn(`GIS query error: ${error}`);
                tally.error = (tally.error || 0) + 1;
                console.groupEnd();
                continue;
            }
            const verdict = evaluateRpp(info, points);
            console.log(`GIS: ${points.length} authoritative point(s) within ${CONFIG.queryRadiusM}m`);
            const rppHn = rppHnString(info);
            verdict.annotated.slice(0, CONFIG.maxListedPoints).forEach((p) => {
                const hnFlag = (rppHn != null && String(p.hn) === rppHn) ? 'HN✓' : 'HN✗';
                const stFlag = streetsMatch(p.street, info.street) ? 'St✓' : 'St✗';
                const d = (p.dist === Infinity) ? '?' : `${p.dist.toFixed(1)}m`;
                console.log(`  • ${d.padStart(7)}  ${p.address || `${p.hn} ${p.street}`}  [${p.subtype || '—'}]  ${hnFlag} ${stFlag}`);
            });
            console.log(`%cVERDICT [${verdict.code}]: ${verdict.msg}`, verdictStyle(verdict.code));
            tally[verdict.code] = (tally[verdict.code] || 0) + 1;
            if (verdict.code === 'misplaced' && verdict.target) {
                misplaced.push({
                    id: info.id,
                    address: verdict.target.address,
                    dist: verdict.target.dist,
                    lon: verdict.target.lon,      // target (GIS point) — where Snap moves the pin
                    lat: verdict.target.lat,
                    rppLon: info.lon,             // RPP's current location — where Go pans to
                    rppLat: info.lat,
                });
            } else if (verdict.code === 'wrong-hn' || verdict.code === 'hn-diff-street' || verdict.code === 'no-match') {
                review.push({
                    code: verdict.code,
                    hn: rppHn ?? '∅',
                    street: info.street || '∅',
                    rppLon: info.lon,
                    rppLat: info.lat,
                });
            }
            allScanned.push({
                hn: rppHn ?? '∅',
                street: info.street || '∅',
                code: verdict.code,
                // pin → its verdict target (own GIS point for ok/misplaced;
                // nearest relevant point otherwise); null = nothing in range.
                distM: (verdict.target && isFinite(verdict.target.dist)) ? verdict.target.dist : null,
                msg: verdict.msg,
                rppLon: info.lon,
                rppLat: info.lat,
            });

            console.groupEnd();
        }

        const summary = Object.entries(tally).filter(([, n]) => n).map(([k, n]) => `${k}:${n}`).join('  |  ') || '(none)';
        console.log(`%c${LOG} SUMMARY — ${rpps.length} RPP(s): ${summary}`, 'color:#06c;font-weight:bold');

        setProbeScanning(false);
        renderProbeResults(misplaced, review, allScanned);
        const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // Describe the source actually used: local, local-with-fallback, or
        // statewide-because-no-local-configured.
        let srcDesc;
        if (usedFallback) {
            srcDesc = `🗺️ ${STATEWIDE_SOURCE.name} — <b>fallback</b> (${requestedLocal.name} unavailable) · ${sourceHost(STATEWIDE_SOURCE)}`;
        } else if (activeSource.id === STATEWIDE_SOURCE.id) {
            srcDesc = `🗺️ ${STATEWIDE_SOURCE.name} · ${sourceHost(STATEWIDE_SOURCE)} <span style="color:#888;">(no local source configured for this area)</span>`;
        } else {
            srcDesc = `🗺️ ${activeSource.name} <b>(local)</b> · ${sourceHost(activeSource)}`;
        }
        const foot = `<br><span style="color:#235;">${srcDesc}</span><br><span style="color:#888;">${summary}</span>`;
        if (misplaced.length === 0) {
            setProbeStatus(`✅ Done ${at} — scanned ${rpps.length} RPP(s), no misplaced pins found.${foot}`, '#0a7');
        } else {
            setProbeStatus(`⚠️ Done ${at} — ${rpps.length} RPP(s): <b>${misplaced.length} misplaced</b>. See below.${foot}`, '#b26a00');
        }
    }

    // ---- snap (the ONLY map-writing action — reviewed, one at a time) ---------

    function snapRpp(venueId, lon, lat) {
        if (!wmeSdk || !wmeSdk.DataModel || !wmeSdk.DataModel.Venues) {
            return { ok: false, err: 'SDK Venues unavailable' };
        }
        try {
            wmeSdk.DataModel.Venues.updateVenue({
                venueId,
                geometry: { type: 'Point', coordinates: [lon, lat] },
            });
            return { ok: true };
        } catch (e) {
            return { ok: false, err: e.message };
        }
    }

    // Pan + zoom the WME map to a location (read-only; just moves the view).
    function goToRpp(lon, lat) {
        const lonLat = { lon, lat };
        try {
            if (wmeSdk && wmeSdk.Map && wmeSdk.Map.setMapCenter) {
                wmeSdk.Map.setMapCenter({ lonLat, zoomLevel: CONFIG.goZoomLevel });
                return;
            }
        } catch { /* fall back to legacy */ }
        try {
            W.map.setCenter(lonLat, CONFIG.goZoomLevel);
        } catch (e) {
            console.warn(`${LOG} go-to failed:`, e.message);
        }
    }

    function makeGoButton(lon, lat) {
        const b = document.createElement('button');
        b.textContent = 'Go';
        b.title = 'Pan & zoom the map to this RPP';
        b.style.cssText = 'padding:3px 8px;background:#06c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;';
        b.addEventListener('click', () => goToRpp(lon, lat));
        return b;
    }

    function makeRow(text) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:5px 8px;border-bottom:1px solid #eee;font-size:11px;display:flex;align-items:center;gap:8px;';
        const span = document.createElement('span');
        span.textContent = text;
        span.style.cssText = 'flex:1;';
        row.appendChild(span);
        return { row, span };
    }

    // ---- result rows (shared by the sidebar tab and the floating fallback) ----

    function makeSectionHeader(text) {
        const h = document.createElement('div');
        h.textContent = text;
        h.style.cssText = 'padding:5px 8px;font-size:11px;font-weight:bold;color:#444;background:#f6f6f6;margin-top:6px;';
        return h;
    }

    // A misplaced-RPP row: "Go" pans to the pin, "Snap" moves the pin to its GIS
    // point (the ONLY map-writing action — reviewed, one at a time).
    function makeMisplacedRow(m) {
        const { row, span } = makeRow(`${m.address} — ${m.dist.toFixed(0)}m off`);
        const btn = document.createElement('button');
        btn.textContent = 'Snap';
        btn.style.cssText = 'padding:3px 8px;background:#0a7;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;';
        btn.addEventListener('click', () => {
            const res = snapRpp(m.id, m.lon, m.lat);
            if (res.ok) {
                span.textContent = `✓ snapped — ${m.address}`;
                span.style.color = '#0a0';
                btn.remove();
            } else {
                span.textContent = `✗ ${m.address}: ${res.err}`;
                span.style.color = '#c00';
            }
        });
        row.appendChild(makeGoButton(m.rppLon, m.rppLat));
        row.appendChild(btn);
        return row;
    }

    function appendResultSections(container, misplaced) {
        if (misplaced.length) {
            container.appendChild(makeSectionHeader('MISPLACED — snap pin to its GIS point:'));
            misplaced.forEach((m) => container.appendChild(makeMisplacedRow(m)));
        }
    }

    // ---- sidebar tab UI -------------------------------------------------------

    function setProbeStatus(html, color) {
        if (!probeStatusRef) {
            return;
        }
        probeStatusRef.innerHTML = html;
        probeStatusRef.style.color = color || '#444';
    }

    function setProbeScanning(on) {
        if (!probeButtonRef) {
            return;
        }
        probeButtonRef.disabled = on;
        probeButtonRef.textContent = on ? '⏳ Scanning…' : '🔬 Probe visible RPPs';
        probeButtonRef.style.opacity = on ? '0.6' : '1';
        probeButtonRef.style.cursor = on ? 'default' : 'pointer';
    }

    function clearProbeResults() {
        if (probeResultsRef) {
            probeResultsRef.innerHTML = '';
        }
    }

    // Render results into the sidebar tab if it's present; otherwise fall back to
    // a floating panel (only happens if registerSidebarTab was unavailable).
    function renderProbeResults(misplaced, review, allScanned) {
        if (probeResultsRef) {
            clearProbeResults();
            appendResultSections(probeResultsRef, misplaced);
            if (review && review.length) {
                probeResultsRef.appendChild(makeSectionHeader('REVIEW — other verdicts (console has per-point detail):'));
                review.forEach((r) => {
                    const { row } = makeRow(`[${r.code}] ${r.hn} — ${r.street}`);
                    row.appendChild(makeGoButton(r.rppLon, r.rppLat));
                    probeResultsRef.appendChild(row);
                });
            }
            // Every scanned RPP with its measured pin→GIS distance (v.27) —
            // the at-a-glance "does GIS actually have this one" audit.
            if (allScanned && allScanned.length) {
                probeResultsRef.appendChild(makeSectionHeader('ALL SCANNED — pin → GIS point distance:'));
                allScanned.forEach((r) => {
                    const d = (r.distM == null) ? 'no GIS point in range' : `${r.distM.toFixed(0)}m`;
                    const { row, span } = makeRow(`${r.hn} — ${r.street} · ${r.code} · ${d}`);
                    span.title = r.msg;
                    if (r.distM == null) {
                        span.style.color = '#c00';
                    }
                    row.appendChild(makeGoButton(r.rppLon, r.rppLat));
                    probeResultsRef.appendChild(row);
                });
            }
        } else {
            refreshSnapPanel(misplaced);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 🔢 HN FILLER — select road segment(s), list GIS house numbers missing from
    // the map, add them one reviewed click at a time (added 2026-07-21).
    // ════════════════════════════════════════════════════════════════════════

    // Sidebar-tab UI references (populated by setupHnTab once WME is ready).
    let hnStatusRef = null;
    let hnResultsRef = null;
    let hnButtonRef = null;
    let hnSelLineRef = null;
    let hnAddAllRef = null;

    let hnSelectionSummary = '';      // last rendered selection line (skip redundant DOM writes)
    const hnSessionAdded = new Set(); // "street|hn" keys added this session (fetch won't see unsaved adds)
    let hnPendingRows = [];           // current scan's missing rows — {c, span, btn, done}; Add-all walks this

    // User-adjustable search distance BAND (min–max from the road centerline).
    // Max = the corridor; min > 0 excludes near-road houses so the far-off ones
    // can be targeted for RPPs (Josh's ask 2026-07-21). Min defaults to 0 =
    // band off, identical to the old single-distance behavior.
    const HN_CORRIDOR_STORE = 'hnFiller.corridorM';        // max (pre-band saves carry over)
    const HN_CORRIDOR_MIN_STORE = 'hnFiller.corridorMinM';

    function clampCorridor(v) {
        const n = Math.round(Number(v));
        if (!isFinite(n)) {
            return HN_CONFIG.corridorM;
        }
        return Math.min(HN_CONFIG.corridorMaxM, Math.max(HN_CONFIG.corridorMinM, n));
    }

    function hnCorridorM() {
        try {
            const saved = localStorage.getItem(HN_CORRIDOR_STORE);
            return saved == null ? HN_CONFIG.corridorM : clampCorridor(saved);
        } catch {
            return HN_CONFIG.corridorM;
        }
    }

    function setHnCorridorM(v) {
        try {
            localStorage.setItem(HN_CORRIDOR_STORE, String(clampCorridor(v)));
        } catch { /* private mode etc. — session keeps the default */ }
    }

    function clampCorridorMin(v) {
        const n = Math.round(Number(v));
        if (!isFinite(n) || n < 0) {
            return 0;
        }
        return Math.min(hnCorridorM() - 10, n);   // always leave a 10m band open
    }

    function hnCorridorMinM() {
        try {
            const saved = localStorage.getItem(HN_CORRIDOR_MIN_STORE);
            return saved == null ? 0 : clampCorridorMin(saved);
        } catch {
            return 0;
        }
    }

    function setHnCorridorMinM(v) {
        try {
            localStorage.setItem(HN_CORRIDOR_MIN_STORE, String(clampCorridorMin(v)));
        } catch { /* private mode etc. */ }
    }

    // GIS radius per sample: must cover half a sample step along the road plus
    // the corridor across it, whatever the user set the corridor to.
    function hnQueryRadiusM() {
        return Math.round(Math.hypot(HN_CONFIG.sampleStepM / 2, hnCorridorM())) + 15;
    }

    // House-number strings compare as normalized text ("123 A" == "123a"; letters + ½ pass
    // through; leading zeros drop so Summit-style "0902" == "902").
    function normHn(v) {
        const s = String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ').replace(/^0+(?=\d)/, '');
        return s === '' ? null : s;
    }

    function hnKey(street, hn) {
        return `${streetCore(street)}|${normHn(hn)}`;
    }

    function setHnStatus(html, color) {
        if (hnStatusRef) {
            hnStatusRef.innerHTML = html;
            hnStatusRef.style.color = color || '#444';
        }
    }

    function setHnScanning(on) {
        if (hnButtonRef) {
            hnButtonRef.disabled = on;
            hnButtonRef.textContent = on ? '⏳ Scanning…' : '🔢 Scan selected segment(s)';
            hnButtonRef.style.opacity = on ? '0.6' : '1';
        }
    }

    // ---- selection poll (no reachable selection event on current WME) --------

    function currentSegmentSelection() {
        if (!wmeSdk) {
            return null;
        }
        try {
            const sel = wmeSdk.Editing.getSelection();
            return (sel && sel.objectType === 'segment' && sel.ids.length) ? sel.ids.slice() : null;
        } catch {
            return null;
        }
    }

    function refreshHnSelectionLine() {
        if (!hnSelLineRef) {
            return;
        }
        const ids = currentSegmentSelection();
        let summary;
        if (!wmeSdk) {
            summary = '⚠️ WME SDK unavailable — the HN Filler cannot run.';
        } else if (!ids) {
            summary = 'Select a road segment on the map (multi-select OK).';
        } else {
            let street = '';
            try {
                const addr = wmeSdk.DataModel.Segments.getAddress({ segmentId: ids[0] });
                street = addr?.street?.name || '';
            } catch { /* unloaded street — leave blank */ }
            summary = `Selected: <b>${ids.length}</b> segment(s)${street ? ` — <b>${street}</b>` : ''}`;
        }
        if (summary !== hnSelectionSummary) {
            hnSelectionSummary = summary;
            hnSelLineRef.innerHTML = summary;
            if (hnButtonRef) {
                hnButtonRef.disabled = !ids;
            }
        }
    }

    function startHnSelectionPoll() {
        setInterval(refreshHnSelectionLine, HN_CONFIG.selectionPollMs);
    }

    // ---- GIS along-the-segment query -----------------------------------------

    // Sample coordinates every sampleStepM along the line (both endpoints included).
    function samplePointsAlong(line) {
        const lenKm = turf.length(line, { units: 'kilometers' });
        const stepKm = HN_CONFIG.sampleStepM / 1000;
        const pts = [];
        for (let d = 0; d < lenKm; d += stepKm) {
            pts.push(turf.along(line, d, { units: 'kilometers' }).geometry.coordinates);
        }
        pts.push(turf.along(line, lenKm, { units: 'kilometers' }).geometry.coordinates);
        return pts;
    }

    function metersToLine(lon, lat, line) {
        return turf.pointToLineDistance(turf.point([lon, lat]), line, { units: 'kilometers' }) * 1000;
    }

    // All samples along every selected segment against ONE source; merge +
    // dedupe by (street, hn). Samples outside the view are skipped (v.20: a
    // single rural segment can run for MILES with one end on screen — the
    // visible-segment test alone still walked its whole length).
    async function querySamplesWithSource(segInfos, source, radius, scanBbox) {
        const seen = new Map();   // key → point
        for (const si of segInfos) {
            for (const [lon, lat] of samplePointsAlong(si.line)) {
                if (scanBbox && !coordInBbox(lon, lat, scanBbox)) {
                    continue;
                }
                const { error, points } = await queryOneSource(source, lon, lat, radius);
                if (error) {
                    return { error, points: [] };
                }
                for (const p of points) {
                    if (p.lon == null || p.lat == null || normHn(p.hn) == null) {
                        continue;
                    }
                    const key = hnKey(p.street, p.hn);
                    if (!seen.has(key)) {
                        seen.set(key, p);
                    }
                }
            }
        }
        return { error: null, points: [...seen.values()] };
    }

    // Query the picked local source; fall back to statewide on ERROR **or on
    // ZERO points** (2026-07-21: 13 counties of bbox rectangles inevitably
    // overlap neighbors — a mispick must degrade to statewide, not to a silent
    // empty scan). Returns { error, points, source, usedFallback }.
    async function queryGisAlongSegments(segInfos, scanBbox) {
        const mid = samplePointsAlong(segInfos[0].line)[0];
        const requestedLocal = pickLocalSource(mid[0], mid[1]);
        const radius = hnQueryRadiusM();
        if (requestedLocal) {
            const local = await querySamplesWithSource(segInfos, requestedLocal, radius, scanBbox);
            if (!local.error && local.points.length) {
                return { error: null, points: local.points, source: requestedLocal, usedFallback: false };
            }
            console.warn(`${HN_LOG} ${requestedLocal.name} ${local.error ? `failed (${local.error})` : 'returned no points'} → statewide fallback.`);
            const state = await querySamplesWithSource(segInfos, STATEWIDE_SOURCE, radius, scanBbox);
            return { error: state.error, points: state.points, source: STATEWIDE_SOURCE, usedFallback: true };
        }
        const state = await querySamplesWithSource(segInfos, STATEWIDE_SOURCE, radius, scanBbox);
        return { error: state.error, points: state.points, source: STATEWIDE_SOURCE, usedFallback: false };
    }

    // ---- scan ----------------------------------------------------------------

    // The ACTIVE VIEW, slightly padded — every model sweep below clips to it
    // (v.17, Josh: "it is scanning areas of the map that are not in the active
    // view"). The WME model retains everything panned across this session, so
    // without the clip the street family / RPP sweep / dedupe reached loaded
    // same-named streets kilometers away.
    function paddedViewBbox() {
        const b = getMapExtentBbox();
        if (!b) {
            return null;
        }
        const pad = 0.0015;   // ≈150 m — keeps edge-of-screen context without re-opening the far-model hole
        return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
    }

    function coordInBbox(lon, lat, b) {
        return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
    }

    function lineTouchesBbox(coords, b) {
        return coords.some((c) => coordInBbox(c[0], c[1], b));
    }

    // Loaded unnamed PLR segments (roadType 20, no primary street) — the
    // "houses on an unnamed parking-lot-road offshoot" detector (2026-07-21).
    // When one of these sits closer to a GIS point than the named street does,
    // the CO convention is an RPP addressed to the parent road (stop point then
    // dragged onto the PLR by hand — no SDK write path for navigationPoints).
    // ALL drawn (loaded) segments in view except the selection — the competitor
    // set for the nearest-segment rule (v.30, Josh: a GIS point may only be
    // added when its NEAREST drawn segment is a SELECTED one; a point nearer
    // any other segment belongs to that road/stretch — selecting 20m of a
    // fully-drawn mile must not inherit the whole mile's numbers — and points
    // along undrawn continuations resolve to whatever IS drawn nearby).
    // Unnamed PLRs (roadType 20, no street) are flagged, not competitors:
    // nearest-PLR candidates stay proposable via the 🅿/+RPP workflow.
    function loadedDrawnSegments(viewBbox, excludeIds) {
        const out = [];
        const segObjs = (W && W.model && W.model.segments && W.model.segments.objects) ? W.model.segments.objects : {};
        for (const sid in segObjs) {
            const attrs = segObjs[sid].attributes || {};
            if (attrs.id == null || excludeIds.has(attrs.id)) {
                continue;
            }
            const seg = wmeSdk.DataModel.Segments.getById({ segmentId: attrs.id });
            if (!seg || !seg.geometry || !seg.geometry.coordinates || seg.geometry.coordinates.length < 2) {
                continue;
            }
            const coords = seg.geometry.coordinates;
            if (viewBbox && !lineTouchesBbox(coords, viewBbox)) {
                continue;
            }
            let minLon = Infinity;
            let minLat = Infinity;
            let maxLon = -Infinity;
            let maxLat = -Infinity;
            for (const c of coords) {
                minLon = Math.min(minLon, c[0]);
                maxLon = Math.max(maxLon, c[0]);
                minLat = Math.min(minLat, c[1]);
                maxLat = Math.max(maxLat, c[1]);
            }
            let street = '';
            try {
                street = wmeSdk.DataModel.Segments.getAddress({ segmentId: attrs.id })?.street?.name || '';
            } catch { /* unresolved — treated as a non-competitor (only same-street stretches compete) */ }
            out.push({
                id: attrs.id,
                line: turf.lineString(coords),
                bounds: [minLon, minLat, maxLon, maxLat],
                street,
                barePlr: attrs.roadType === 20 && (attrs.primaryStreetID ?? attrs.primaryStreetId) == null,
            });
        }
        return out;
    }

    // Existing RPP house numbers covering the selection — venues, not segment
    // HNs, so fetchHouseNumbers never sees them; and an RPP takes PRECEDENCE
    // over a segment HN for search/navigation (Josh 2026-07-21), so a covered
    // address must never be proposed. Matched by street NAME via streetsMatch
    // (v.15 — street-object ids miss city-variant duplicates like the
    // "No city"/"Parker" pair on one road), with a geometric fallback: an RPP
    // with an unresolvable street still covers if it sits in the corridor.
    function existingRppNumbers(segInfos, corridor, viewBbox) {
        const nums = new Set();
        const venueObjs = (W && W.model && W.model.venues && W.model.venues.objects) ? W.model.venues.objects : {};
        for (const vid in venueObjs) {
            const venue = W.model.venues.getObjectById(vid);
            const attrs = venue && venue.attributes;
            if (!attrs || !attrs.categories || !attrs.categories.includes('RESIDENCE_HOME')) {
                continue;
            }
            const norm = normHn(attrs.houseNumber);
            if (norm == null) {
                continue;
            }
            const pt = venueCentroidLonLat(venue);
            // View clip (v.17): a same-named street's RPPs from a far-off loaded
            // area must not suppress candidates here.
            if (viewBbox && (!pt || !coordInBbox(pt[0], pt[1], viewBbox))) {
                continue;
            }
            let street = '';
            try {
                street = W.model.streets.getObjectById(attrs.streetID)?.attributes?.name || '';
            } catch { /* unresolved street — geometric fallback below */ }
            if (street && segInfos.some((si) => si.match(street))) {
                nums.add(norm);
                continue;
            }
            if (pt && segInfos.some((si) => metersToLine(pt[0], pt[1], si.line) <= corridor)) {
                nums.add(norm);
            }
        }
        return nums;
    }

    // Directional-SIBLING detection (v.29): the one-sided directional ignore
    // ("E Woodmen Rd" matches bare "WOODMEN RD") is DANGEROUS exactly when both
    // sides exist — small towns run "E Aspen St" and "W Aspen St" with the SAME
    // house numbers on each, and cross-side matching duplicates everything.
    // When a loaded street shares the selected street's dirless core but
    // carries a DIFFERENT directional, matching for that street goes STRICT:
    // the candidate must carry the SAME directional; bare names refuse.
    function hasDirSibling(streetName) {
        const n = normalizeStreet(streetName);
        const d = dirOf(n);
        if (!d) {
            return false;
        }
        const core = stripDirs(n);
        const stObjs = (W && W.model && W.model.streets && W.model.streets.objects) ? W.model.streets.objects : {};
        for (const k in stObjs) {
            const name = stObjs[k].attributes ? stObjs[k].attributes.name : null;
            if (!name) {
                continue;
            }
            const on = normalizeStreet(name);
            const od = dirOf(on);
            if (od && od !== d && stripDirs(on) === core) {
                return true;
            }
        }
        return false;
    }

    // Suggested WME name for a mis-typed segment: keep the segment's own text
    // and casing, swap its trailing type for the GIS one ("St. Andrews Dr" +
    // GIS "ST ANDREWS PL" → "St. Andrews Pl"). Falls back to a title-cased GIS
    // name if the difference isn't a clean trailing-type swap.
    function titleCaseType(t) {
        return t.charAt(0) + t.slice(1).toLowerCase();
    }

    function titleCaseName(name) {
        return String(name).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    }

    function suggestedRename(segName, gisName) {
        const gisTokens = normalizeStreet(gisName).split(' ');
        const gisType = gisTokens[gisTokens.length - 1];
        const segTokens = String(segName).trim().split(/\s+/);
        const segLastNorm = normalizeStreet(segTokens[segTokens.length - 1]);
        if (TYPE_ABBREVS.has(gisType) && segTokens.length > 1 && TYPE_ABBREVS.has(segLastNorm)) {
            segTokens[segTokens.length - 1] = titleCaseType(gisType);
            return segTokens.join(' ');
        }
        return titleCaseName(gisName);
    }

    // One matcher per segment NAME (primary + every alternate, v.35) — the
    // dir-sibling strictness is judged per name, since an alt can have a
    // sibling its primary doesn't.
    function matcherForName(name) {
        if (!hasDirSibling(name)) {
            return (gisStreet) => streetsMatch(gisStreet, name);
        }
        const want = dirOf(normalizeStreet(name));
        return (gisStreet) => dirOf(normalizeStreet(gisStreet)) === want && streetsMatch(gisStreet, name);
    }

    function hnStreetMatchFn(si) {
        const matchers = [si.streetName, ...(si.altNames || [])].map(matcherForName);
        return (gisStreet) => matchers.some((m) => m(gisStreet));
    }

    // Loaded segments sharing a street with the selection — the HN dedupe
    // universe AND the snap-target candidates (numbers near a segment end may
    // belong on the neighboring same-street segment). v.35: "sharing" means
    // ANY street id in common, primary or alternate on either side, so a
    // stretch carrying the road name only as an alt still dedupes.
    function sameStreetFamily(streetIds, viewBbox) {
        const family = [];
        const segObjs = (W && W.model && W.model.segments && W.model.segments.objects) ? W.model.segments.objects : {};
        for (const sid in segObjs) {
            const attrs = segObjs[sid].attributes || {};
            if (attrs.id == null) {
                continue;
            }
            const seg = wmeSdk.DataModel.Segments.getById({ segmentId: attrs.id });
            if (!seg || !seg.geometry || !seg.geometry.coordinates || seg.geometry.coordinates.length < 2) {
                continue;
            }
            const segStreetIds = [seg.primaryStreetId, ...(seg.alternateStreetIds || [])];
            if (!segStreetIds.some((x) => x != null && streetIds.has(x))) {
                continue;
            }
            if (!viewBbox || lineTouchesBbox(seg.geometry.coordinates, viewBbox)) {
                family.push({ id: attrs.id, line: turf.lineString(seg.geometry.coordinates) });
            }
        }
        return family;
    }

    async function hnScanSelected() {

        if (!wmeSdk) {
            setHnStatus('✗ WME SDK unavailable — cannot scan.', '#c00');
            return;
        }
        const zoom = getZoom();
        if (zoom != null && zoom < HN_CONFIG.minZoom) {
            setHnStatus(`⚠️ Zoom in to level ${HN_CONFIG.minZoom}+ first (segment/HN data isn't reliably loaded at zoom ${zoom}).`, '#b26a00');
            return;
        }
        const ids = currentSegmentSelection();
        if (!ids) {
            setHnStatus('Select a road segment first.', '#444');
            return;
        }
        setHnScanning(true);
        if (hnResultsRef) {
            hnResultsRef.innerHTML = '';
        }

        try {
            // v.19 ROOT-CAUSE fix for "getting stuff miles away": the SELECTION
            // itself was never view-clipped — "select entire street" (or a
            // selection surviving a pan) made the scan sample GIS along
            // segments anywhere on the map. Only VISIBLE selected segments are
            // scanned now; the off-view remainder is reported, not walked.
            const scanBbox = paddedViewBbox();
            const visibleIds = scanBbox
                ? ids.filter((id) => {
                    const seg = wmeSdk.DataModel.Segments.getById({ segmentId: id });
                    return seg && seg.geometry && lineTouchesBbox(seg.geometry.coordinates, scanBbox);
                })
                : ids;
            const offView = ids.length - visibleIds.length;
            const capped = visibleIds.length > HN_CONFIG.maxSegmentsPerScan;
            const scanIds = visibleIds.slice(0, HN_CONFIG.maxSegmentsPerScan);
            if (!scanIds.length) {
                setHnScanning(false);
                setHnStatus(`✗ None of the ${ids.length} selected segment(s) are in the current view — pan to the part of the street you want to work, then rescan.`, '#c00');
                return;
            }

            // Per-segment info; skip segments whose street isn't resolvable (the RPP
            // fixer's v4.5.2 lesson: never act on an unloaded street).
            const segInfos = [];
            const skipped = [];
            for (const id of scanIds) {
                const seg = wmeSdk.DataModel.Segments.getById({ segmentId: id });
                let streetName = '';
                let altNames = [];
                try {
                    const addr = wmeSdk.DataModel.Segments.getAddress({ segmentId: id });
                    streetName = addr?.street?.name || '';
                    // Alternate street names count as on-street too (v.35, Josh:
                    // GIS often carries the alt — Berthoud "W COUNTY ROAD 4" vs
                    // primary "W CR-4" with the GIS name sitting in the alts).
                    altNames = (addr?.altStreets || []).map((alt) => alt?.street?.name).filter(Boolean);
                } catch { /* treated as unresolvable below */ }
                if (!seg || !streetName) {
                    skipped.push(id);
                    continue;
                }
                segInfos.push({
                    id,
                    streetName,
                    altNames,
                    primaryStreetId: seg.primaryStreetId,
                    altStreetIds: (seg.alternateStreetIds || []).filter((x) => x != null),
                    line: turf.lineString(seg.geometry.coordinates),
                    strictDir: hasDirSibling(streetName),
                });
            }
            for (const si of segInfos) {
                si.match = hnStreetMatchFn(si);
                if (si.strictDir) {
                    console.log(`${HN_LOG} "${si.streetName}" has a directional SIBLING loaded — strict side matching for this scan (bare GIS names refuse).`);
                }
            }
            if (!segInfos.length) {
                setHnScanning(false);
                setHnStatus('✗ No selected segment has a resolvable street (street not loaded?) — pan/zoom and retry.', '#c00');
                return;
            }

            const streetIds = new Set(segInfos.flatMap((s) => [s.primaryStreetId, ...s.altStreetIds])
                .filter((x) => x != null));
            // v.18 split: KNOWLEDGE is model-wide, WRITES are view-only.
            // familyAll feeds the dedupe fetch (clipping it caused real
            // "House number already exists" save errors — numbers on loaded
            // same-street segments just off-screen were re-proposed); attach
            // targets come only from the visible subset, so the script never
            // EDITS a segment outside the active view.
            const viewBbox = paddedViewBbox();
            const familyAll = sameStreetFamily(streetIds, null);
            const familyIds = new Set(familyAll.map((f) => f.id));
            setHnStatus(`⏳ Fetching existing house numbers for ${familyIds.size} same-street segment(s)…`, '#06c');

            // Existing numbers = server state (fetch) + any unsaved local INSERTs
            // (fetchHouseNumbers does NOT see unsaved adds — spike finding 2026-07-21).
            const existing = await wmeSdk.DataModel.HouseNumbers.fetchHouseNumbers({ segmentIds: [...familyIds] });
            const existingNums = new Set(existing.map((h) => normHn(h.number)).filter(Boolean));
            const hnStore = (W && W.model && W.model.segmentHouseNumbers && W.model.segmentHouseNumbers.objects) || {};
            for (const k in hnStore) {
                const a = hnStore[k].attributes || hnStore[k];
                const segRef = a.segID ?? a.segmentID;
                if (familyIds.has(segRef)) {
                    existingNums.add(normHn(a.number));
                }
            }
            const rppNums = existingRppNumbers(segInfos, hnCorridorM(), viewBbox);
            const otherSegs = loadedDrawnSegments(viewBbox, new Set(scanIds));

            setHnStatus('⏳ Querying GIS address points along the selection…', '#06c');
            const gis = await queryGisAlongSegments(segInfos, scanBbox);
            if (gis.error) {
                setHnScanning(false);
                setHnStatus(`✗ GIS query failed: ${gis.error}`, '#c00');
                return;
            }

            // Classify candidates within the corridor of the SELECTED segments.
            const missing = [];
            const mismatch = [];
            let presentCount = 0;
            let rppCoveredCount = 0;
            let nearerOtherCount = 0;
            let dupCount = 0;
            // Name-conflict detector (v.33): GIS points whose CORE name matches
            // the selected street but whose TYPE/directional differs, with no
            // real alternative street drawn — i.e. the segment is likely
            // mistyped (Edwards: GIS "ST ANDREWS PL" vs WME "St. Andrews Dr").
            // Keyed by the normalized GIS name → {name, count}; surfaced as a
            // rename SUGGESTION (never auto-renamed).
            const nameConflicts = new Map();
            const selCores = new Set(segInfos.flatMap((si) => [si.streetName, ...si.altNames].map(streetCore)));
            // Unmatched GIS names that are NOT a type-swap of the selection
            // (different core) — candidate ALTERNATE names (v.35, Josh's #2):
            // normalized name → {name, count, cities}.
            const altNameCands = new Map();
            // GIS city tally over matched on-street points → consensus city
            // for the city-repair action (v.35, Josh's #3).
            const cityTally = new Map();
            // Add-key = target STREET + house number (v.31): WME house numbers
            // are unique PER STREET, so two GIS records for the same house —
            // even with different street spellings the GIS-side streetCore key
            // didn't collapse — must add ONCE (the 2nd was the "already exists"
            // save error Josh hit).
            const proposedKeys = new Set();
            const corridor = hnCorridorM();
            const corridorMin = hnCorridorMinM();
            let offScreen = 0;
            for (const p of gis.points) {
                // v.20: the SCREEN is a hard wall — the band means "distance from
                // the road", never "distance off my viewport". A wide band (1000m)
                // zoomed-in otherwise proposes points far outside the view.
                if (scanBbox && !coordInBbox(p.lon, p.lat, scanBbox)) {
                    offScreen++;
                    continue;
                }
                let dSel = Infinity;
                let selBestId = null;
                for (const si of segInfos) {
                    const d = metersToLine(p.lon, p.lat, si.line);
                    if (d < dSel) {
                        dSel = d;
                        selBestId = si.id;
                    }
                }
                if (dSel > corridor) {
                    continue;   // another block/parallel street — not this road's frontage
                }
                if (dSel < corridorMin) {
                    continue;   // inside the band's near edge — user is targeting far-off houses
                }
                // v.32 SAME-STREET nearest-segment rule (Josh): only ANOTHER
                // stretch of the SAME road that sits closer disqualifies a point
                // ("select that stretch instead") — a differently-named cross
                // street being geometrically nearer is irrelevant, because the
                // house can never be addressed to it (v.30 wrongly let a corner
                // lot's cul-de-sac steal an Arrowhead Dr address). Unnamed PLRs
                // still flag the 🅿/+RPP workflow. Bounds pre-check keeps it
                // cheap: only boxes within dSel of the point can beat dSel.
                let plr = null;
                let nearerOther = false;
                const latPad = dSel / 110540;
                const lonPad = dSel / (111320 * Math.cos((p.lat * Math.PI) / 180));
                for (const os of otherSegs) {
                    if (p.lon < os.bounds[0] - lonPad || p.lon > os.bounds[2] + lonPad
                        || p.lat < os.bounds[1] - latPad || p.lat > os.bounds[3] + latPad) {
                        continue;
                    }
                    const d = metersToLine(p.lon, p.lat, os.line);
                    if (d >= dSel) {
                        continue;
                    }
                    if (os.barePlr) {
                        if (!plr || d < plr.d) {
                            plr = { id: os.id, d };
                        }
                    } else if (os.street && streetsMatch(os.street, p.street)) {
                        nearerOther = true;   // a nearer stretch of the SAME road
                        break;
                    }
                }
                if (nearerOther) {
                    nearerOtherCount++;   // belongs to an unselected/other road — never piles onto the selection
                    continue;
                }
                if (!segInfos.some((si) => si.match(p.street))) {
                    // Near-miss: same CORE name as the selected street but the
                    // type/dir differs → candidate segment-mistype (recorded now,
                    // filtered after the loop against any real alternative road).
                    if (selCores.has(streetCore(p.street))) {
                        const key = normalizeStreet(p.street);
                        const c = nameConflicts.get(key) || { name: p.street, norm: key, count: 0 };
                        c.count++;
                        nameConflicts.set(key, c);
                    } else if (p.street) {
                        // Genuinely different name (not a type swap) → candidate
                        // ALTERNATE name for the selection (v.35): offered as a
                        // reviewed "add as alt" if it survives the post-loop
                        // filter (≥2 points, no drawn road actually named that).
                        const key = normalizeStreet(p.street);
                        const c = altNameCands.get(key) || { name: p.street, norm: key, count: 0, cities: new Map() };
                        c.count++;
                        if (p.city) {
                            c.cities.set(p.city, (c.cities.get(p.city) || 0) + 1);
                        }
                        altNameCands.set(key, c);
                    }
                    // Report-only, and only when it's AT the curb (a different street
                    // 100m out is normal geography, not a data discrepancy).
                    if (dSel <= HN_CONFIG.mismatchCorridorM) {
                        mismatch.push(p);
                    }
                    continue;
                }
                if (p.city) {
                    cityTally.set(p.city, (cityTally.get(p.city) || 0) + 1);
                }
                const norm = normHn(p.hn);
                if (rppNums.has(norm)) {
                    rppCoveredCount++;   // an RPP outranks a segment HN — never propose
                    continue;
                }
                if (existingNums.has(norm) || hnSessionAdded.has(hnKey(p.street, p.hn))) {
                    presentCount++;
                    continue;
                }
                const matchedSeg = segInfos.find((si) => si.match(p.street));
                const streetKey = matchedSeg.primaryStreetId != null
                    ? String(matchedSeg.primaryStreetId)
                    : normalizeStreet(matchedSeg.streetName);
                const addKey = `${streetKey}|${norm}`;
                if (proposedKeys.has(addKey)) {
                    dupCount++;   // same street + HN already queued this scan
                    continue;
                }
                proposedKeys.add(addKey);
                missing.push({
                    hn: String(p.hn).trim(),
                    street: p.street,
                    address: p.address || `${p.hn} ${p.street}`,
                    lon: p.lon,
                    lat: p.lat,
                    attachSegId: selBestId,
                    attachDistM: dSel,
                    streetId: matchedSeg ? matchedSeg.primaryStreetId : null,
                    plrSegId: plr ? plr.id : null,
                    plrDistM: plr ? plr.d : null,
                });
            }
            missing.sort((a, b) => (parseInt(a.hn, 10) || 0) - (parseInt(b.hn, 10) || 0));

            // Keep only conflicts with NO real alternative road drawn — if a
            // segment actually named like the GIS points exists in view, they
            // belong THERE (two real streets), not a mistype. Threshold ≥2 so a
            // single stray point doesn't nag.
            const renameSuggestions = [...nameConflicts.values()]
                .filter((c) => c.count >= 2
                    && !segInfos.some((si) => streetsMatch(si.streetName, c.name))
                    && !otherSegs.some((os) => os.street && streetsMatch(os.street, c.name)))
                .sort((a, b) => b.count - a.count);

            // Alt-name candidates survive the same sanity filter (v.35): ≥2
            // points backing the name and no drawn road actually named that —
            // then a reviewed "Add as alt" wires the name (+city) onto the
            // selection and rescans so its HNs become addable.
            const altNameSuggestions = [...altNameCands.values()]
                .filter((c) => c.count >= 2
                    && !otherSegs.some((os) => os.street && streetsMatch(os.street, c.name)))
                .sort((a, b) => b.count - a.count);

            // GIS consensus city along the selection (v.35, Josh's ruling
            // 2026-07-24) — feeds the city-repair action and new alts' cities.
            // The city NEVER touches the primary slot (city-boundary skew rule).
            const consensusCity = [...cityTally.entries()].sort((a, b) => b[1] - a[1])
                .map(([name]) => titleCaseName(name))[0] || null;

            renderHnResults(missing, mismatch, renameSuggestions, segInfos,
                { altNameSuggestions, consensusCity });
            setHnScanning(false);
            const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const streets = [...new Set(segInfos.map((s) => s.streetName))].join(', ');
            const srcDesc = gis.usedFallback
                ? `${STATEWIDE_SOURCE.name} — fallback · ${sourceHost(STATEWIDE_SOURCE)}`
                : `${gis.source.name}${gis.source.id === STATEWIDE_SOURCE.id ? '' : ' (local)'} · ${sourceHost(gis.source)}`;
            const notes = [
                offView ? `${offView} selected segment(s) OFF-VIEW skipped — pan there and rescan for the rest` : '',
                capped ? `first ${HN_CONFIG.maxSegmentsPerScan} of ${visibleIds.length} visible selected segments` : '',
                skipped.length ? `${skipped.length} segment(s) skipped (street not loaded)` : '',
            ].filter(Boolean).join(' · ');
            const onStreet = presentCount + rppCoveredCount + missing.length;
            const bandDesc = corridorMin > 0 ? `${corridorMin}–${corridor}m band` : `within ${corridor}m`;
            const tallyLine = `GIS: ${gis.points.length} point(s) fetched, ${onStreet} on-street (${bandDesc}) · ${presentCount} already mapped`
                + `${rppCoveredCount ? ` · ${rppCoveredCount} covered by RPPs` : ''}`
                + ` · <b>${missing.length} missing</b> · ${mismatch.length} street-mismatch`
                + `${dupCount ? ` · ${dupCount} duplicate GIS record(s) collapsed` : ''}`
                + `${nearerOtherCount ? ` · ${nearerOtherCount} nearest to an UNSELECTED segment (select that stretch to work them)` : ''}`
                + `${offScreen ? ` · ${offScreen} off-screen (pan/zoom out to reach them)` : ''}`
                + `<br><span style="color:#235;">🗺️ ${srcDesc}</span>${notes ? `<br><span style="color:#888;">${notes}</span>` : ''}`;
            if (onStreet === 0) {
                // "Nothing in GIS" must never read as "all mapped" — new construction
                // can lag the source (that's this tool's whole use case).
                setHnStatus(`⚠️ Done ${at} — <b>${streets}</b>: the GIS source has NO on-street address points along this`
                    + ' selection. That means no data to compare — NOT that the map is complete (new construction may'
                    + ` lag the source).<br>${tallyLine}`, '#b26a00');
            } else if (missing.length === 0) {
                setHnStatus(`✅ Done ${at} — <b>${streets}</b>: all ${onStreet} GIS house number(s) here are already mapped.<br>${tallyLine}`, '#0a7');
            } else {
                setHnStatus(`⚠️ Done ${at} — <b>${streets}</b>: ${missing.length} house number(s) missing. Review below.<br>${tallyLine}`, '#b26a00');
            }
            console.log(`%c${HN_LOG} ${streets}: GIS on-street=${presentCount + missing.length} present=${presentCount} missing=${missing.length} mismatch=${mismatch.length} via ${srcDesc}`, 'color:#06c;font-weight:bold');
        } catch (e) {
            setHnScanning(false);
            setHnStatus(`✗ Scan failed: ${e.message}`, '#c00');
            console.error(`${HN_LOG} scan failed:`, e);
        }
    }

    // ---- add (the map-writing action — reviewed, one at a time) --------------

    function hnAddOne(c) {
        if (!wmeSdk) {
            return { ok: false, err: 'SDK unavailable' };
        }
        if (wmeSdk.Editing.getUnsavedChangesCount() >= HN_CONFIG.saveQueueLimit) {
            return { ok: false, err: `WME's save queue is full (${HN_CONFIG.saveQueueLimit}) — SAVE in WME, then rescan` };
        }
        if (!wmeSdk.DataModel.Segments.getById({ segmentId: c.attachSegId })) {
            return { ok: false, err: 'target segment no longer loaded — rescan' };
        }
        const before = wmeSdk.Editing.getUnsavedChangesCount();
        try {
            wmeSdk.DataModel.HouseNumbers.addHouseNumber({
                number: c.hn,
                point: { type: 'Point', coordinates: [c.lon, c.lat] },
                segmentId: c.attachSegId,
            });
        } catch (e) {
            return { ok: false, err: `${e.name || 'error'}: ${e.message}` };
        }
        if (wmeSdk.Editing.getUnsavedChangesCount() <= before) {
            return { ok: false, err: 'no edit registered — check the console' };
        }

        hnSessionAdded.add(hnKey(c.street, c.hn));
        console.log(`${HN_LOG} added HN ${c.hn} (${c.street}) @ (${c.lon.toFixed(6)}, ${c.lat.toFixed(6)}) → segment ${c.attachSegId} [${c.attachDistM.toFixed(0)}m] — UNSAVED until you save in WME.`);
        return { ok: true };
    }

    // Create an RPP (residential venue) addressed to the parent street at the
    // GIS point — the unnamed-PLR-offshoot workflow (2026-07-21). The stop
    // point CANNOT be set by script (SDK updateVenue has no navigationPoints
    // arg) — Josh drags it onto the PLR in the venue editor afterwards.
    function hnAddRppOne(c) {
        if (!wmeSdk) {
            return { ok: false, err: 'SDK unavailable' };
        }
        if (c.streetId == null) {
            return { ok: false, err: 'no resolvable street id for this candidate' };
        }
        if (wmeSdk.Editing.getUnsavedChangesCount() >= HN_CONFIG.saveQueueLimit) {
            return { ok: false, err: `WME's save queue is full (${HN_CONFIG.saveQueueLimit}) — SAVE in WME, then rescan` };
        }
        let venueId;
        try {
            venueId = wmeSdk.DataModel.Venues.addVenue({
                category: 'RESIDENTIAL',
                geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
            });
            wmeSdk.DataModel.Venues.updateAddress({
                venueId: String(venueId),
                houseNumber: c.hn,
                streetId: c.streetId,
            });
        } catch (e) {
            return { ok: false, err: `${e.name || 'error'}: ${e.message}` };
        }
        hnSessionAdded.add(hnKey(c.street, c.hn));
        console.log(`${HN_LOG} added RPP ${c.hn} (${c.street}) @ (${c.lon.toFixed(6)}, ${c.lat.toFixed(6)}) venue ${venueId}`
            + `${c.plrSegId ? ` — PLR seg ${c.plrSegId} ${c.plrDistM.toFixed(0)}m away; drag the stop point onto it` : ''} — UNSAVED.`);
        return { ok: true };
    }

    // One reviewed add applied to a result row — shared by the row's own Add
    // button and the Add-all walk, so both paths look and behave identically.
    function applyAddToRow(entry) {
        if (entry.done) {
            return { ok: true };
        }
        const res = hnAddOne(entry.c);
        if (res.ok) {
            entry.done = true;
            entry.span.textContent = `✓ added — ${entry.c.hn} ${entry.c.street}`;
            entry.span.style.color = '#0a0';
            entry.btn.remove();
        } else {
            entry.span.textContent = `✗ ${entry.c.hn}: ${res.err}`;
            entry.span.style.color = '#c00';
        }
        return res;
    }

    function makeHnMissingRow(c) {
        const plrNote = c.plrSegId ? ` · 🅿 PLR ${c.plrDistM.toFixed(0)}m` : '';
        const { row, span } = makeRow(`${c.hn} — ${c.street} (→ seg ${c.attachSegId}, ${c.attachDistM.toFixed(0)}m)${plrNote}`);
        const btn = document.createElement('button');
        btn.textContent = 'Add';
        btn.title = 'Create this house number at the GIS point, snapped to the segment shown (unsaved until you save in WME)';
        btn.style.cssText = 'padding:3px 8px;background:#0a7;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;';
        const entry = { c, span, btn, done: false };
        hnPendingRows.push(entry);
        btn.addEventListener('click', () => {
            applyAddToRow(entry);
        });
        const rppBtn = document.createElement('button');
        rppBtn.textContent = '+RPP';
        rppBtn.title = 'Create a residential point place addressed to the parent street instead of a segment HN '
            + '(the unnamed-PLR-offshoot workflow). Stop point must be dragged onto the PLR by hand afterwards.';
        rppBtn.style.cssText = 'padding:3px 8px;background:#85f;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;';
        rppBtn.addEventListener('click', () => {
            if (entry.done) {
                return;
            }
            const res = hnAddRppOne(c);
            if (res.ok) {
                entry.done = true;
                span.textContent = `✓ RPP added — ${c.hn} ${c.street}${c.plrSegId ? ' (drag its stop point onto the PLR)' : ''}`;
                span.style.color = '#63c';
                btn.remove();
                rppBtn.remove();
            } else {
                span.textContent = `✗ ${c.hn}: ${res.err}`;
                span.style.color = '#c00';
            }
        });
        row.appendChild(makeGoButton(c.lon, c.lat));
        row.appendChild(btn);
        row.appendChild(rppBtn);
        return row;
    }

    // Add-all (enabled 2026-07-21 after the per-row flow proved out in the
    // field): walks the current scan's rows through the SAME reviewed-add path.
    // Everything stays unsaved until Josh saves in WME — the bulk is still
    // reviewable there, and the save-queue gate applies per add.
    function hnAddAll() {
        let added = 0;
        let failed = 0;
        for (const entry of hnPendingRows) {
            if (entry.done) {
                continue;
            }
            const res = applyAddToRow(entry);
            if (res.ok) {
                added++;
            } else {
                failed++;
                if (/save queue is full/.test(res.err || '')) {
                    break;
                }
            }
        }
        const remaining = hnPendingRows.filter((e) => !e.done).length;
        setHnStatus(`Add-all: <b>${added} added</b>${failed ? ` · ${failed} failed` : ''}`
            + `${remaining ? ` · ${remaining} still pending` : ''} — all UNSAVED until you save in WME.`,
        failed ? '#b26a00' : '#0a7');
        if (hnAddAllRef) {
            hnAddAllRef.style.display = remaining ? 'inline-block' : 'none';
        }
    }

    // ---- alt-name + city writes (v.35 — reviewed, save-stack edits) ----------

    function ensureCity(cityName) {
        return wmeSdk.DataModel.Cities.getCity({ cityName })
            || wmeSdk.DataModel.Cities.addCity({ cityName });
    }

    function ensureStreet(streetName, cityId) {
        const args = cityId != null ? { streetName, cityId } : { streetName };
        return wmeSdk.DataModel.Streets.getStreet(args)
            || wmeSdk.DataModel.Streets.addStreet(args);
    }

    // The city a NEW alt should carry: the candidate's own GIS majority city,
    // else the scan's consensus, else the primary street's existing city id
    // (which may be the empty city — better than silently inheriting the top
    // city, which is what an omitted cityId would do).
    function altCandidateCity(cand, consensusCity, si) {
        const own = [...cand.cities.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => titleCaseName(n))[0];
        const cityName = own || consensusCity;
        if (cityName) {
            return { cityId: ensureCity(cityName).id, cityName };
        }
        const primaryCityId = si.primaryStreetId != null
            ? wmeSdk.DataModel.Streets.getById({ streetId: si.primaryStreetId })?.cityId
            : null;
        return { cityId: primaryCityId ?? null, cityName: null };
    }

    // Add a GIS-attested name as an ALTERNATE street (+city) on the selected
    // segments — Josh's #2. Never touches the primary (city-boundary rule).
    function addGisAltName(cand, segInfos, consensusCity) {
        if (!wmeSdk) {
            return { ok: false, err: 'SDK unavailable' };
        }
        if (wmeSdk.Editing.getUnsavedChangesCount() >= HN_CONFIG.saveQueueLimit) {
            return { ok: false, err: `WME's save queue is full (${HN_CONFIG.saveQueueLimit}) — SAVE in WME, then retry` };
        }
        try {
            const altName = titleCaseName(cand.name);
            const { cityId, cityName } = altCandidateCity(cand, consensusCity, segInfos[0]);
            const street = ensureStreet(altName, cityId);
            wmeSdk.DataModel.Segments.addAlternateStreet({
                segmentIds: segInfos.map((si) => si.id),
                streetId: street.id,
            });
            console.log(`${HN_LOG} added alt "${altName}${cityName ? `, ${cityName}` : ''}" (street ${street.id}) to segment(s) ${segInfos.map((si) => si.id).join(', ')} — UNSAVED.`);
            return { ok: true, altName, cityName };
        } catch (e) {
            return { ok: false, err: `${e.name || 'error'}: ${e.message}` };
        }
    }

    // City repair plan for one selected segment — Josh's #3. Rules:
    //   • primary's city slot is NEVER touched (only in-boundary segments may
    //     carry a primary city — manual call);
    //   • a city-less PRIMARY gets a "primary name + city" ALT (unless a
    //     same-name alt already carries a city);
    //   • every NAMED city-less alt is upgraded to "name + city" and the bare
    //     one is DROPPED (alt slots are limited);
    //   • name-less alts (the city-only alt pattern) are kept untouched.
    // keep[] holds street ids to retain as-is, or {needStreet} placeholders
    // resolved against the repair city at apply time.
    function planCityRepair(si, cityName) {
        let addr;
        try {
            addr = wmeSdk.DataModel.Segments.getAddress({ segmentId: si.id });
        } catch {
            return null;
        }
        const primaryName = addr?.street?.name || '';
        const primaryHasCity = !!(addr?.city && !addr.city.isEmpty && addr.city.name);
        const alts = addr?.altStreets || [];
        if (alts.some((a) => a?.street?.id == null)) {
            return null;   // can't rebuild the alt list faithfully — leave manual
        }
        const actions = [];
        const keep = [];
        for (const a of alts) {
            const altName = a.street.name || '';
            const altCity = (a.city && !a.city.isEmpty && a.city.name) || '';
            if (altCity || !altName) {
                keep.push(a.street.id);
                continue;
            }
            actions.push(`upgrade “${altName}” → “${altName}, ${cityName}” (drop the city-less alt)`);
            keep.push({ needStreet: altName });
        }
        if (!primaryHasCity && primaryName) {
            const covered = alts.some((a) => {
                const altCity = (a.city && !a.city.isEmpty && a.city.name) || '';
                return altCity && a.street.name
                    && normalizeStreet(a.street.name) === normalizeStreet(primaryName);
            });
            if (!covered) {
                actions.push(`add alt “${primaryName}, ${cityName}”`);
                keep.push({ needStreet: primaryName });
            }
        }
        return actions.length ? { si, cityName, actions, keep } : null;
    }

    function applyCityRepair(plan) {
        if (!wmeSdk) {
            return { ok: false, err: 'SDK unavailable' };
        }
        if (wmeSdk.Editing.getUnsavedChangesCount() >= HN_CONFIG.saveQueueLimit) {
            return { ok: false, err: `WME's save queue is full (${HN_CONFIG.saveQueueLimit}) — SAVE in WME, then retry` };
        }
        const seg = wmeSdk.DataModel.Segments.getById({ segmentId: plan.si.id });
        if (!seg) {
            return { ok: false, err: 'segment no longer loaded — rescan' };
        }
        try {
            const city = ensureCity(plan.cityName);
            const altIds = plan.keep.map((k) => (typeof k === 'number' ? k : ensureStreet(k.needStreet, city.id).id));
            wmeSdk.DataModel.Segments.updateAddress({
                segmentId: plan.si.id,
                // primaryStreetId passed back EXPLICITLY so the full-list alt
                // replace can never disturb the primary address.
                addressData: {
                    primaryStreetId: seg.primaryStreetId,
                    alternateStreetIds: [...new Set(altIds)],
                },
            });
            console.log(`${HN_LOG} city repair on segment ${plan.si.id}: ${plan.actions.join(' · ')} — UNSAVED.`);
            return { ok: true };
        } catch (e) {
            return { ok: false, err: `${e.name || 'error'}: ${e.message}` };
        }
    }

    function renderHnResults(missing, mismatch, renameSuggestions, segInfos, extra) {
        if (!hnResultsRef) {
            return;
        }
        const { altNameSuggestions = [], consensusCity = null } = extra || {};
        hnResultsRef.innerHTML = '';
        hnPendingRows = [];
        if (hnAddAllRef) {
            hnAddAllRef.style.display = missing.length ? 'inline-block' : 'none';
            hnAddAllRef.textContent = `Add all (${missing.length})`;
        }
        // Rename suggestion first — it usually BLOCKS the real adds (matched on
        // type), so surface it before MISSING so Josh sees it up top.
        if (renameSuggestions && renameSuggestions.length) {
            const segName = segInfos && segInfos.length ? segInfos[0].streetName : 'this segment';
            renameSuggestions.forEach((c) => {
                const target = suggestedRename(segName, c.name);
                const box = document.createElement('div');
                box.style.cssText = 'margin:6px 0;padding:7px 9px;background:#fff6e5;border-left:3px solid #e8a300;border-radius:4px;font-size:11px;color:#663c00;';
                box.innerHTML = `⚠️ <b>Possible segment mis-name.</b> ${c.count} GIS address(es) here read `
                    + `<b>"${titleCaseName(c.name)}"</b>, but the selected segment is <b>"${segName}"</b> and `
                    + 'no such road is drawn nearby.<br>If the sign matches GIS, rename the segment to '
                    + `→ <b style="font-size:12px;">${target}</b> ← in WME, then rescan.`;
                hnResultsRef.appendChild(box);
            });
        }
        // GIS name that matches neither primary nor alts and is NOT a type
        // swap → reviewed "add as alternate name" (v.35, Josh's #2). On
        // success the scan re-runs so the name's HNs surface as Add rows.
        if (altNameSuggestions.length && segInfos && segInfos.length) {
            const segName = segInfos[0].streetName;
            altNameSuggestions.forEach((c) => {
                const { cityName } = (() => {
                    try {
                        return altCandidateCity(c, consensusCity, segInfos[0]);
                    } catch {
                        return { cityName: null };
                    }
                })();
                const label = `${titleCaseName(c.name)}${cityName ? `, ${cityName}` : ''}`;
                const box = document.createElement('div');
                box.style.cssText = 'margin:6px 0;padding:7px 9px;background:#eef3ff;border-left:3px solid #4a6fd0;border-radius:4px;font-size:11px;color:#1c2c5e;';
                const txt = document.createElement('div');
                txt.innerHTML = `🔀 <b>GIS uses another name here.</b> ${c.count} GIS address(es) along the selection read `
                    + `<b>"${titleCaseName(c.name)}"</b> (segment: <b>"${segName}"</b>, not in its alternates; no road of that name drawn nearby).`;
                const btn = document.createElement('button');
                btn.textContent = `Add alt "${label}" + rescan`;
                btn.title = 'Add this name as an ALTERNATE street on the selected segment(s) (unsaved), then rescan so its house numbers become addable. The primary name and city are not touched.';
                btn.style.cssText = 'margin-top:5px;padding:4px 9px;background:#4a6fd0;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;';
                btn.addEventListener('click', () => {
                    const res = addGisAltName(c, segInfos, consensusCity);
                    if (res.ok) {
                        btn.remove();
                        txt.innerHTML = `✓ alt <b>"${res.altName}${res.cityName ? `, ${res.cityName}` : ''}"</b> added (unsaved) — rescanning…`;
                        hnScanSelected().catch((e) => setHnStatus(`✗ Rescan failed: ${e.message}`, '#c00'));
                    } else {
                        txt.innerHTML = `✗ add alt failed: ${res.err}`;
                        txt.style.color = '#c00';
                    }
                });
                box.appendChild(txt);
                box.appendChild(btn);
                hnResultsRef.appendChild(box);
            });
        }
        // City repair (v.35, Josh's #3): GIS consensus city + any city-less
        // primary/alt on the selection → one reviewed Apply. Never touches the
        // primary's city slot.
        if (consensusCity && segInfos && segInfos.length) {
            const plans = segInfos.map((si) => planCityRepair(si, consensusCity)).filter(Boolean);
            if (plans.length) {
                const box = document.createElement('div');
                box.style.cssText = 'margin:6px 0;padding:7px 9px;background:#eafaef;border-left:3px solid #0a7;border-radius:4px;font-size:11px;color:#0c4028;';
                const txt = document.createElement('div');
                txt.innerHTML = `🏙️ <b>City repair — GIS consensus: ${consensusCity}.</b><br>`
                    + plans.map((p) => `seg ${p.si.id} (“${p.si.streetName}”): ${p.actions.join(' · ')}`).join('<br>');
                const btn = document.createElement('button');
                btn.textContent = `Apply city repair (${plans.length} segment${plans.length > 1 ? 's' : ''})`;
                btn.title = 'Add the name+city alternates and drop the superseded city-less alternates (unsaved until you save in WME). The primary city slot is never changed.';
                btn.style.cssText = 'margin-top:5px;padding:4px 9px;background:#0a7;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;';
                btn.addEventListener('click', () => {
                    const fails = [];
                    let done = 0;
                    for (const p of plans) {
                        const res = applyCityRepair(p);
                        if (res.ok) {
                            done++;
                        } else {
                            fails.push(`seg ${p.si.id}: ${res.err}`);
                        }
                    }
                    if (fails.length) {
                        txt.innerHTML = `✗ city repair — ${done} ok, ${fails.length} failed:<br>${fails.join('<br>')}`;
                        txt.style.color = '#c00';
                    } else {
                        btn.remove();
                        txt.innerHTML = `✓ city repair applied to ${done} segment(s) — UNSAVED until you save in WME.`;
                    }
                });
                box.appendChild(txt);
                box.appendChild(btn);
                hnResultsRef.appendChild(box);
            }
        }
        if (missing.length) {
            hnResultsRef.appendChild(makeSectionHeader('MISSING — in GIS, not on the map:'));
            missing.forEach((c) => hnResultsRef.appendChild(makeHnMissingRow(c)));
        }
        if (mismatch.length) {
            hnResultsRef.appendChild(makeSectionHeader('STREET MISMATCH — GIS says another street fronts here (report-only):'));
            mismatch.forEach((p) => {
                const { row } = makeRow(`${p.hn} ${p.street} — ${p.address || ''}`);
                row.appendChild(makeGoButton(p.lon, p.lat));
                hnResultsRef.appendChild(row);
            });
        }
    }

    function setupHnTab() {
        let reg;
        try {
            reg = W.userscripts.registerSidebarTab('hn-filler');
        } catch (e) {
            console.warn(`${HN_LOG} sidebar tab unavailable:`, e.message);
            return;
        }
        const { tabLabel, tabPane } = reg;
        tabLabel.innerText = '🔢 HN';
        tabLabel.title = 'HN Filler — add house numbers missing from the map, from authoritative GIS address points';
        tabPane.innerHTML = `
            <div style="font-family:sans-serif;font-size:12px;">
              <h2 style="font-size:14px;margin:6px 0;">🔢 HN Filler <span style="font-weight:normal;color:#888;font-size:10px;">v${SCRIPT_VERSION}</span></h2>
              <p style="color:#555;margin:4px 0 8px;">Select road segment(s), scan, review the house numbers GIS has but the map is missing, add each with one click. Adds are <b>unsaved</b> until you save in WME — review with the House Numbers layer on.</p>
              <div id="hn-filler-selline" style="margin:4px 0 8px;padding:5px 8px;background:#f3f6ff;border-left:3px solid #06c;border-radius:3px;font-size:11px;color:#235;">Select a road segment on the map (multi-select OK).</div>
              <div style="margin:4px 0 8px;font-size:11px;color:#444;">
                Search distance:
                <input id="hn-filler-corridor-min" type="number" min="0" max="${HN_CONFIG.corridorMaxM - 10}" step="10" style="width:55px;padding:2px 4px;" title="Minimum distance from the road centerline (meters). Set above 0 to see ONLY far-off houses — e.g. 150 to target the ones that should become RPPs.">
                –
                <input id="hn-filler-corridor" type="number" min="${HN_CONFIG.corridorMinM}" max="${HN_CONFIG.corridorMaxM}" step="10" style="width:55px;padding:2px 4px;" title="Maximum distance from the road centerline (meters). Raise it on big rural parcels where houses sit far up their driveways.">
                m from the road <span style="color:#888;">(default 0–${HN_CONFIG.corridorM})</span>
              </div>
              <button id="hn-filler-scan" disabled style="padding:7px 12px;background:#06c;color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:bold;cursor:pointer;">🔢 Scan selected segment(s)</button>
              <button id="hn-filler-addall" title="Add every listed missing house number (same reviewed path as the row buttons; all unsaved until you save in WME)" style="display:none;margin-left:6px;padding:7px 12px;background:#0a7;color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:bold;cursor:pointer;">Add all</button>
              <div id="hn-filler-status" style="margin:8px 0;padding:6px 8px;background:#f3f3f3;border-radius:4px;font-size:11px;color:#444;">Idle — select a segment and click <b>Scan</b>.</div>
              <div id="hn-filler-results"></div>
            </div>`;
        hnSelLineRef = tabPane.querySelector('#hn-filler-selline');
        hnStatusRef = tabPane.querySelector('#hn-filler-status');
        hnResultsRef = tabPane.querySelector('#hn-filler-results');
        hnButtonRef = tabPane.querySelector('#hn-filler-scan');
        hnAddAllRef = tabPane.querySelector('#hn-filler-addall');
        hnAddAllRef.addEventListener('click', hnAddAll);
        const corridorInput = tabPane.querySelector('#hn-filler-corridor');
        const corridorMinInput = tabPane.querySelector('#hn-filler-corridor-min');
        corridorInput.value = hnCorridorM();
        corridorMinInput.value = hnCorridorMinM();
        corridorInput.addEventListener('change', () => {
            setHnCorridorM(corridorInput.value);
            corridorInput.value = hnCorridorM();          // reflect the clamped value back
            setHnCorridorMinM(corridorMinInput.value);    // re-clamp min against the new max
            corridorMinInput.value = hnCorridorMinM();
        });
        corridorMinInput.addEventListener('change', () => {
            setHnCorridorMinM(corridorMinInput.value);
            corridorMinInput.value = hnCorridorMinM();
        });
        hnButtonRef.addEventListener('click', () => {
            hnScanSelected().catch((e) => {
                setHnScanning(false);
                setHnStatus(`✗ Scan failed: ${e.message}`, '#c00');
                console.error(`${HN_LOG} scan failed:`, e);
            });
        });
        startHnSelectionPoll();
        console.log(`%c${HN_LOG} ready — "🔢 HN" tab added. Scan is read-only; each "Add" is a reviewed unsaved edit.`, 'color:#06c;font-weight:bold');
    }

    // ---- bootstrap ------------------------------------------------------------

    function setupProbeTab() {
        let reg;
        try {
            reg = W.userscripts.registerSidebarTab('rpp-gis-probe');
        } catch (e) {
            console.warn(`${LOG} sidebar tab unavailable — falling back to a floating button:`, e.message);
            addProbeButton();
            return;
        }
        const { tabLabel, tabPane } = reg;
        tabLabel.innerText = '🔬 Probe';
        tabLabel.title = 'RPP GIS Address Probe — read-only cross-check of visible RPPs vs the State of Colorado GIS address points';
        tabPane.innerHTML = `
            <div style="font-family:sans-serif;font-size:12px;">
              <h2 style="font-size:14px;margin:6px 0;">🔬 RPP GIS Address Probe <span style="font-weight:normal;color:#888;font-size:10px;">v${SCRIPT_VERSION}</span></h2>
              <p style="color:#555;margin:4px 0 8px;">Read-only. Cross-checks each visible RPP's house number &amp; street against the authoritative GIS address points below. The only map-writing action is a reviewed <b>Snap</b>.</p>
              <div style="margin:4px 0 8px;padding:5px 8px;background:#eef6f3;border-left:3px solid #0a7;border-radius:3px;font-size:11px;color:#235;">🗺️ <b>GIS source:</b> local-first — uses the county/city service where configured (${LOCAL_SOURCE_NAMES}), otherwise the State of Colorado composite (${sourceHost(STATEWIDE_SOURCE)}). Each scan shows which it used.</div>
              <button id="rpp-gis-probe-run" style="padding:7px 12px;background:#0a7;color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:bold;cursor:pointer;">🔬 Probe visible RPPs</button>
              <div id="rpp-gis-probe-status" style="margin:8px 0;padding:6px 8px;background:#f3f3f3;border-radius:4px;font-size:11px;color:#444;">Idle — click <b>Probe</b> to scan the RPPs currently in view.</div>
              <div id="rpp-gis-probe-results"></div>
            </div>`;
        probeStatusRef = tabPane.querySelector('#rpp-gis-probe-status');
        probeResultsRef = tabPane.querySelector('#rpp-gis-probe-results');
        probeButtonRef = tabPane.querySelector('#rpp-gis-probe-run');
        probeButtonRef.addEventListener('click', () => {
            probeVisibleRPPs().catch((e) => {
                console.error(`${LOG} probe failed:`, e);
                setProbeScanning(false);
                setProbeStatus(`✗ Probe failed: ${e.message}`, '#c00');
            });
        });
        console.log(`%c${LOG} ready — "🔬 Probe" tab added to the scripts side panel. Scan is read-only; "Snap" is the only map edit.`, 'color:#0a7;font-weight:bold');
    }

    // Floating review panel — FALLBACK only (used if the sidebar tab can't be
    // registered). Misplaced RPPs get a Snap button.
    function refreshSnapPanel(misplaced) {
        const old = document.getElementById('rpp-gis-probe-panel');
        if (old) {
            old.remove();
        }
        if (!misplaced.length) {
            return;
        }
        const panel = document.createElement('div');
        panel.id = 'rpp-gis-probe-panel';
        panel.style.cssText = [
            'position:fixed', 'top:60px', 'right:12px', 'z-index:10000', 'width:360px',
            'max-height:70vh', 'overflow:auto', 'background:#fff', 'border:1px solid #999',
            'border-radius:6px', 'box-shadow:0 2px 10px rgba(0,0,0,.35)', 'font-family:sans-serif',
        ].join(';');

        const header = document.createElement('div');
        header.style.cssText = 'padding:6px 8px;background:#0a7;color:#fff;font-weight:bold;font-size:12px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;';
        const title = document.createElement('span');
        title.textContent = `🔬 Review — ${misplaced.length} misplaced`;
        const close = document.createElement('button');
        close.textContent = '✕';
        close.style.cssText = 'background:transparent;border:none;color:#fff;font-size:14px;cursor:pointer;';
        close.addEventListener('click', () => panel.remove());
        header.appendChild(title);
        header.appendChild(close);
        panel.appendChild(header);
        appendResultSections(panel, misplaced);
        document.body.appendChild(panel);
    }

    function addProbeButton() {
        if (document.getElementById('rpp-gis-probe-btn')) {
            return;
        }
        const btn = document.createElement('button');
        btn.id = 'rpp-gis-probe-btn';
        btn.textContent = '🔬 Probe RPPs';
        btn.title = 'READ-ONLY: cross-check visible RPP house numbers vs the State of Colorado GIS address points (logs to console; no map edits)';
        btn.style.cssText = [
            'position:fixed', 'bottom:12px', 'left:12px', 'z-index:10000',
            'padding:8px 12px', 'background:#0a7', 'color:#fff', 'border:none',
            'border-radius:6px', 'font-size:13px', 'font-weight:bold', 'cursor:pointer',
            'box-shadow:0 2px 6px rgba(0,0,0,.3)',
        ].join(';');
        btn.addEventListener('click', () => {
            probeVisibleRPPs().catch((e) => console.error(`${LOG} probe failed:`, e));
        });
        document.body.appendChild(btn);
    }

    function onReady() {
        setupProbeTab();
        setupHnTab();
    }

    // Bind the WME SDK if it's available — OPTIONAL. We mostly use legacy reads
    // (W.model / W.map), so the probe works even if the SDK never binds.
    function bindSdkWhenReady() {
        if (typeof getWmeSdk !== 'function') {
            return;
        }
        const sdkReady = window.SDK_INITIALIZED || Promise.resolve();
        sdkReady.then(() => {
            try {
                wmeSdk = getWmeSdk({ scriptId: 'wme-rpp-gis-probe', scriptName: SCRIPT_NAME });
            } catch (e) {
                console.warn(`${LOG} SDK bind failed (legacy reads only):`, e.message);
            }
        }).catch((e) => console.warn(`${LOG} SDK init error (legacy reads only):`, e.message));
    }

    function startProbeScript() {
        bindSdkWhenReady();
        onReady();
    }

    // Expose for manual console use.
    window.rppGisProbe = () => probeVisibleRPPs().catch((e) => console.error(`${LOG} probe failed:`, e));
    window.hnFillerScan = () => hnScanSelected().catch((e) => console.error(`${HN_LOG} scan failed:`, e));

    // Entry point — mirror the RPP fixer: run when WME signals ready (not on a
    // poll of window.SDK_INITIALIZED, which Tampermonkey's sandbox never exposes).
    if (W?.userscripts?.state?.isReady) {
        startProbeScript();
    } else {
        document.addEventListener('wme-ready', startProbeScript, { once: true });
    }
})();
