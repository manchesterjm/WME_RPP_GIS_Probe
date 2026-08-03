/* eslint-env node */
/**
 * Regression harness for the COUNTY GATE (v.49, rebuilt on AREAS in v.50).
 *
 * Field case (Josh, 2026-08-03, W 120th Ave): W 120th IS the Adams/Broomfield
 * county line. His view sat on the ADAMS side. Broomfield's bbox covers that
 * ground, so the scan used Broomfield — which holds the NORTH side, an office
 * park genuinely addressed W 121ST AVE. Broomfield answered 188 points, so
 * v.44's zero-point guard never fired, and the tab reported "GIS reads
 * W 121st Ave" for a road correctly named W 120th Ave.
 *
 * The gate asks the statewide composite which county the spot is ACTUALLY in
 * (its `County` attribute is correct on both sides of the line) and refuses a
 * local source that governs a different one.
 *
 * 🔑 The rule that matters most is FAIL OPEN: 16 of Colorado's 64 counties have
 * ZERO rows in the statewide composite (Otero, Crowley, Fremont…), and the
 * service can be down. Silence must never be read as a wrong-county verdict, or
 * the gate would strip working local sources across a quarter of the state.
 *
 * ⚠️ v.50 — the gate judges the SCAN AREA, not one point. Josh found the hole in
 * v.49 immediately: on W 120th Ave the ROAD centreline is in Adams while
 * `5005 W 120TH AVE`, a house number he wants, is in BROOMFIELD. Road and house
 * numbers on the same street can sit in different counties, so probing the road
 * answers a question nobody asked. His corridor actually touches THREE counties
 * (Adams / Broomfield / Jefferson). A scan area crossing a county line cannot be
 * served by ANY local source — each stops at its own boundary — so statewide,
 * the only source that spans the line, wins outright.
 *
 * ⚠️ The county is resolved by POINT-IN-POLYGON against Colorado's county layer,
 * NOT by the majority county among nearby address points. The address-point
 * version was written first and failed on this very case: at Josh's view centre
 * the nearest 10 points ran Broomfield 6 / Adams 4, because the office park
 * across the line is denser than the Adams frontage — so it answered
 * "Broomfield" for a spot plainly in Adams. A proxy for "which side of the line"
 * is worthless AT the line, which is the only place the gate is consulted.
 *
 * pickSourceForView() is async and network-bound, so this harness REPLICATES its
 * decision table and then greps the shipped file for the load-bearing lines, the
 * same pattern test_rpp_rename.js uses.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SHIPPED = path.join(__dirname, 'wme-rpp-gis-probe.user.js');
const src = fs.readFileSync(SHIPPED, 'utf8');

// Real bboxes/counties lifted from the shipped source so a retune breaks here.
function shippedSource(id) {
    const i = src.indexOf(`id: '${id}'`);
    if (i < 0) {
        throw new Error(`source '${id}' is not in the shipped file`);
    }
    // Cut at the NEXT source so a long comment block (cosp has ~8 lines between
    // id and bbox) can't push this entry's bbox out of the window, and a source
    // that lacks one can't silently borrow its neighbour's.
    const next = src.indexOf("id: '", i + 5);
    const chunk = src.slice(i, next > i ? next : i + 2000);
    const county = /county: '([^']+)'/.exec(chunk);
    const bbox = /bbox: \[([^\]]+)\]/.exec(chunk);
    if (!county) {
        throw new Error(`source '${id}' has no county — the gate cannot judge it`);
    }
    return {
        id,
        county: county[1],
        bbox: bbox ? bbox[1].split(',').map((n) => Number(n.trim())) : null,
    };
}

const IDS = ['cosp', 'douglas', 'broomfield', 'boulder', 'jefferson', 'arapahoe', 'pitkin',
    'montezuma', 'eagle', 'summit', 'pueblo', 'routt', 'grand', 'weld', 'mesa', 'lasanimas', 'laplata'];
const SOURCES = IDS.map(shippedSource);
const STATEWIDE = { id: 'co-state', county: null };

const inBbox = (s, lon, lat) => s.bbox && lon >= s.bbox[0] && lon <= s.bbox[2] && lat >= s.bbox[1] && lat <= s.bbox[3];
const countyOf = (s) => (s && s.county ? s.county.toUpperCase() : null);

/** Replica of pickSourceForArea()'s decision table. `counties` = every county the
 *  scan AREA touches (null/[] = couldn't tell). */
function pick(lon, lat, counties) {
    const bboxPick = SOURCES.find((s) => inBbox(s, lon, lat)) || null;
    if (!bboxPick) {
        return { id: STATEWIDE.id, gate: 'no-local' };
    }
    if (!counties || !counties.length) {
        return { id: bboxPick.id, gate: 'unverified' };
    }
    if (counties.length > 1) {
        return { id: STATEWIDE.id, gate: 'multi-county' };
    }
    const only = counties[0];
    if (countyOf(bboxPick) === only.toUpperCase()) {
        return { id: bboxPick.id, gate: 'confirmed' };
    }
    const byCounty = SOURCES.find((s) => countyOf(s) === only.toUpperCase() && inBbox(s, lon, lat));
    if (byCounty) {
        return { id: byCounty.id, gate: 'reassigned' };
    }
    return { id: STATEWIDE.id, gate: 'wrong-county' };
}

// Josh's exact field case: the midpoint of his 4 selected W 120th Ave segments.
const W120TH = [-105.049518, 39.914070];

const CASES = [
    {
        name: '🔑 W 120th Ave — corridor straddles Adams/Broomfield/Jefferson → statewide',
        lon: W120TH[0], lat: W120TH[1], counties: ['Adams', 'Broomfield', 'Jefferson'],
        expect: { id: 'co-state', gate: 'multi-county' },
    },
    {
        name: '🔑 the v.49 HOLE: road in Adams, its HNs in Broomfield — two counties, not one',
        lon: W120TH[0], lat: W120TH[1], counties: ['Adams', 'Broomfield'],
        expect: { id: 'co-state', gate: 'multi-county' },
    },
    {
        name: 'a scan wholly inside Broomfield still uses Broomfield',
        lon: W120TH[0], lat: W120TH[1], counties: ['Broomfield'],
        expect: { id: 'broomfield', gate: 'confirmed' },
    },
    {
        name: 'wholly inside Adams (no local source) → statewide',
        lon: W120TH[0], lat: W120TH[1], counties: ['Adams'],
        expect: { id: 'co-state', gate: 'wrong-county' },
    },
    {
        name: '⚠️ FAIL OPEN: county unknowable (service down / no extent) → keep the bbox pick',
        lon: W120TH[0], lat: W120TH[1], counties: null,
        expect: { id: 'broomfield', gate: 'unverified' },
    },
    {
        name: '⚠️ FAIL OPEN on an empty array too',
        lon: W120TH[0], lat: W120TH[1], counties: [],
        expect: { id: 'broomfield', gate: 'unverified' },
    },
    {
        name: 'the v.44 Adams/Arapahoe band, wholly in Adams → statewide',
        lon: -104.83, lat: 39.76, counties: ['Adams'],
        expect: { id: 'co-state', gate: 'wrong-county' },
    },
    {
        name: 'the same band wholly in Arapahoe stays local',
        lon: -104.83, lat: 39.70, counties: ['Arapahoe'],
        expect: { id: 'arapahoe', gate: 'confirmed' },
    },
    {
        name: 'Colorado Springs, wholly in El Paso — untouched by the gate',
        lon: -104.8, lat: 38.85, counties: ['El Paso'],
        expect: { id: 'cosp', gate: 'confirmed' },
    },
    {
        name: 'multi-county beats a matching bbox pick — Broomfield must NOT win its own line',
        lon: W120TH[0], lat: W120TH[1], counties: ['Broomfield', 'Jefferson'],
        expect: { id: 'co-state', gate: 'multi-county' },
    },
    {
        name: 'Otero (ZERO statewide address rows) — polygons still answer, no local source',
        lon: -103.54, lat: 37.98, counties: ['Otero'],
        expect: { id: 'co-state', gate: 'no-local' },
    },
    {
        name: 'two-word county name matches exactly (Las Animas)',
        lon: -104.5, lat: 37.2, counties: ['Las Animas'],
        expect: { id: 'lasanimas', gate: 'confirmed' },
    },
    {
        name: 'county names compare case-insensitively',
        lon: -104.8, lat: 38.85, counties: ['EL PASO'],
        expect: { id: 'cosp', gate: 'confirmed' },
    },
];

function assertShippedSourceMatches() {
    const required = [
        'async function pickSourceForArea(bbox, lon, lat)',
        'function resolveAreaCounties(bbox)',
        // the polygon layer, NOT an address-point majority — see the header
        "const COUNTY_LAYER_URL = 'https://gis.colorado.gov/public/rest/services/OIT/County_GIS_Webpages/MapServer/0/query';",
        "return { source: bboxPick, requestedLocal: bboxPick, counties: null, gate: 'unverified' };",
        "return { source: STATEWIDE_SOURCE, requestedLocal: bboxPick, counties, gate: 'multi-county' };",
        "return { source: STATEWIDE_SOURCE, requestedLocal: bboxPick, counties, gate: 'wrong-county' };",
        "gate: 'reassigned'",
        'const picked = await pickSourceForArea(vb, center[0], center[1]);',   // probe tab — VIEW EXTENT
        'const picked = await pickSourceForArea(scanBbox, mid[0], mid[1]);',   // HN tab — SCAN AREA
        "geometryType: 'esriGeometryEnvelope',",
    ];
    const missing = required.filter((s) => !src.includes(s));
    if (missing.length) {
        console.error('FAIL: the shipped source no longer wires the county gate. Missing:');
        missing.forEach((m) => console.error(`   - ${m}`));
        return false;
    }
    // Every local source MUST declare a county or the gate silently can't judge it.
    const withoutCounty = SOURCES.filter((s) => !s.county);
    if (withoutCounty.length) {
        console.error('FAIL: local sources with no county:', withoutCounty.map((s) => s.id));
        return false;
    }
    console.log(`shipped-source guard: OK (11 conditions present; ${SOURCES.length} local sources all declare a county)`);
    return true;
}

let pass = 0;
let fail = 0;
if (!assertShippedSourceMatches()) {
    process.exit(1);
}
for (const c of CASES) {
    const got = pick(c.lon, c.lat, c.counties);
    if (got.id === c.expect.id && got.gate === c.expect.gate) {
        pass += 1;
        console.log(`ok    ${c.name}  →  ${got.id} [${got.gate}]`);
    } else {
        fail += 1;
        console.error(`FAIL  ${c.name}: expected ${c.expect.id} [${c.expect.gate}], got ${got.id} [${got.gate}]`);
    }
}
console.log(`\n${pass} passed, ${fail} failed (${CASES.length} cases)`);
process.exit(fail ? 1 : 0);
