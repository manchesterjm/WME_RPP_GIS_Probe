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

/* global W, turf, GM_xmlhttpRequest, getWmeSdk */

(function() {
    'use strict';

    const SCRIPT_NAME = 'WME RPP GIS Address Probe';
    const SCRIPT_VERSION = '2026.06.24.4';
    const LOG = '🔬 [RPP-GIS-Probe]';

    // Sidebar-tab UI references (populated by setupProbeTab once WME is ready).
    let probePaneRef = null;
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
            hn: a.AddrNum,
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
            name: 'City of Colorado Springs',
            url: 'https://gis.coloradosprings.gov/arcgis/rest/services/GeneralUse/LandRecords/MapServer/0/query',
            bbox: [-104.93, 38.74, -104.62, 39.07], // COSP metro (approx); edges fall back to statewide on empty
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
            // Same Esri-hosted FeatureServer WME GIS Layers uses (the county's own
            // apps.douglas.co.us server 502s; this Esri mirror is reliable). Note
            // STREET_NAME_FULL is the full ADDRESS ("230 THIRD ST"), so build the
            // bare street from the split fields instead.
            url: 'https://services.arcgis.com/seTexOicoRXDvRsJ/ArcGIS/rest/services/Address/FeatureServer/0/query',
            bbox: [-105.33, 39.12, -104.55, 39.57], // Douglas County extent
            fields: (a) => ({
                hn: a.ADDRESS_NUMBER,
                street: joinStreet([a.STREET_PREDIRECTION_CODE, a.STREET_NAME, a.STREET_TYPE_CODE, a.STREET_POSTDIRECTION_CODE]),
                address: a.STREET_NAME_FULL || '',
                city: a.POSTAL_NAME || '',
                zip: a.ZIP_CODE || '',
                subtype: a.ADDRESS_USE || '',
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
        try { return new URL(src.url).hostname; } catch { return src.url; }
    }

    // Configured local jurisdictions, for the tab's persistent "source" line.
    const LOCAL_SOURCE_NAMES = LOCAL_SOURCES.map((s) => s.name).join(', ') || '(none configured yet)';

    // Tunables (Josh can dial these as we learn what the data looks like).
    const CONFIG = {
        queryRadiusM: 60,      // how far around an RPP to pull authoritative points
        wellPlacedM: 12,       // fast-path: matched point this close → definitely on the right lot, skip the neighbor check
        misplacedMarginM: 8,   // a DIFFERENT address must be at least this much closer than the RPP's own point to call it misplaced (robust to rooftop-vs-frontyard offset; tune up = more conservative)
        wrongHnCloseM: 8,      // a *different*-HN point this close suggests the RPP's HN is wrong
        minZoom: 17,           // below this, RPP data isn't reliably loaded
        maxListedPoints: 8,    // cap per-RPP point list in the console
        goZoomLevel: 19,          // zoom used by the "Go" button (house-level review)
    };

    // Street-type normalization so "Springnite Drive" (WME) matches "SPRINGNITE DR" (GIS).
    const STREET_TYPES = {
        DRIVE: 'DR', STREET: 'ST', AVENUE: 'AVE', ROAD: 'RD', COURT: 'CT', LANE: 'LN',
        CIRCLE: 'CIR', BOULEVARD: 'BLVD', PLACE: 'PL', TRAIL: 'TRL', PARKWAY: 'PKWY',
        TERRACE: 'TER', POINT: 'PT', HEIGHTS: 'HTS', SQUARE: 'SQ', HIGHWAY: 'HWY',
        CRESCENT: 'CRES', GROVE: 'GRV', VIEW: 'VW',
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

    function normalizeStreet(name) {
        if (!name) {
            return '';
        }
        const cleaned = String(name).toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
        return cleaned.split(' ').map((tok) => STREET_TYPES[tok] || tok).join(' ');
    }

    function streetCore(name) {
        const tokens = normalizeStreet(name).split(' ');
        const typeAbbrevs = new Set(Object.values(STREET_TYPES));
        if (tokens.length > 1 && typeAbbrevs.has(tokens[tokens.length - 1])) {
            tokens.pop();
        }
        return tokens.join(' ');
    }

    function streetsMatch(a, b) {
        return normalizeStreet(a) === normalizeStreet(b) || streetCore(a) === streetCore(b);
    }

    // ---- GIS query ------------------------------------------------------------

    // Join non-empty street parts in reading order, e.g. ["N","ACADEMY","BLVD"] →
    // "N ACADEMY BLVD". Used by sources whose schema splits the street into
    // directional/name/type columns. (streetsMatch/normalizeStreet handle case +
    // type abbreviations downstream.)
    function joinStreet(parts) {
        return parts.map((p) => (p == null ? '' : String(p).trim())).filter(Boolean).join(' ');
    }

    // The statewide composite's component column names.
    function composeStreet(a) {
        return joinStreet([a.PreDir, a.PreType, a.StreetName, a.PostType, a.PostDir]);
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
        const center = vb ? [(vb[0] + vb[2]) / 2, (vb[1] + vb[3]) / 2] : [getRppInfo(rpps[0]).lon, getRppInfo(rpps[0]).lat];
        const requestedLocal = pickLocalSource(center[0], center[1]);
        let activeSource = requestedLocal || STATEWIDE_SOURCE;
        let usedFallback = false;
        console.log(`%c${LOG} probing ${rpps.length} visible RPP(s) vs ${activeSource.name} [${sourceHost(activeSource)}] — READ-ONLY, no edits.`, 'color:#0a7;font-weight:bold');

        const tally = {};
        const misplaced = [];   // → result rows with a Snap button
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
            }

            console.groupEnd();
        }

        const summary = Object.entries(tally).filter(([, n]) => n).map(([k, n]) => `${k}:${n}`).join('  |  ') || '(none)';
        console.log(`%c${LOG} SUMMARY — ${rpps.length} RPP(s): ${summary}`, 'color:#06c;font-weight:bold');

        setProbeScanning(false);
        renderProbeResults(misplaced);
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
    function renderProbeResults(misplaced) {
        if (probeResultsRef) {
            clearProbeResults();
            appendResultSections(probeResultsRef, misplaced);
        } else {
            refreshSnapPanel(misplaced);
        }
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
        probePaneRef = tabPane;
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

    // Entry point — mirror the RPP fixer: run when WME signals ready (not on a
    // poll of window.SDK_INITIALIZED, which Tampermonkey's sandbox never exposes).
    if (W?.userscripts?.state?.isReady) {
        startProbeScript();
    } else {
        document.addEventListener('wme-ready', startProbeScript, { once: true });
    }
})();
