/* eslint-env node */
/**
 * Regression harness for the v.49 COUNTY GATE.
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

/** Replica of pickSourceForView()'s decision table. `county` = what statewide said (null = couldn't tell). */
function pick(lon, lat, county) {
    const bboxPick = SOURCES.find((s) => inBbox(s, lon, lat)) || null;
    if (!bboxPick) {
        return { id: STATEWIDE.id, gate: 'no-local' };
    }
    if (!county) {
        return { id: bboxPick.id, gate: 'unverified' };
    }
    if (countyOf(bboxPick) === county.toUpperCase()) {
        return { id: bboxPick.id, gate: 'confirmed' };
    }
    const byCounty = SOURCES.find((s) => countyOf(s) === county.toUpperCase() && inBbox(s, lon, lat));
    if (byCounty) {
        return { id: byCounty.id, gate: 'reassigned' };
    }
    return { id: STATEWIDE.id, gate: 'wrong-county' };
}

// Josh's exact field case: the midpoint of his 4 selected W 120th Ave segments.
const W120TH = [-105.049518, 39.914070];

const CASES = [
    {
        name: '🔑 W 120th Ave, ADAMS side — Broomfield bbox claims it, gate sends it to statewide',
        lon: W120TH[0], lat: W120TH[1], county: 'Adams',
        expect: { id: 'co-state', gate: 'wrong-county' },
    },
    {
        name: 'same spot, Broomfield side of the line — Broomfield is CORRECT there',
        lon: W120TH[0], lat: W120TH[1], county: 'Broomfield',
        expect: { id: 'broomfield', gate: 'confirmed' },
    },
    {
        name: '⚠️ FAIL OPEN: statewide cannot say (empty county / service down) → keep the bbox pick',
        lon: W120TH[0], lat: W120TH[1], county: null,
        expect: { id: 'broomfield', gate: 'unverified' },
    },
    {
        name: 'the v.44 Adams/Arapahoe band — Arapahoe bbox reaches 39.787, ground is Adams',
        lon: -104.83, lat: 39.76, county: 'Adams',
        expect: { id: 'co-state', gate: 'wrong-county' },
    },
    {
        name: 'the same band on the Arapahoe side stays local',
        lon: -104.83, lat: 39.70, county: 'Arapahoe',
        expect: { id: 'arapahoe', gate: 'confirmed' },
    },
    {
        name: 'Colorado Springs — El Paso confirmed, untouched by the gate',
        lon: -104.8, lat: 38.85, county: 'El Paso',
        expect: { id: 'cosp', gate: 'confirmed' },
    },
    {
        name: 'Otero County (ZERO statewide rows) — county unknowable, must NOT be gated to nothing',
        lon: -103.54, lat: 37.98, county: null,
        expect: { id: 'co-state', gate: 'no-local' },
    },
    {
        name: 'two-word county name matches exactly (Las Animas)',
        lon: -104.5, lat: 37.2, county: 'Las Animas',
        expect: { id: 'lasanimas', gate: 'confirmed' },
    },
    {
        name: 'county names compare case-insensitively',
        lon: -104.8, lat: 38.85, county: 'EL PASO',
        expect: { id: 'cosp', gate: 'confirmed' },
    },
];

function assertShippedSourceMatches() {
    const required = [
        'async function pickSourceForView(lon, lat)',
        'function resolveViewCounty(lon, lat)',
        // the polygon layer, NOT an address-point majority — see the header
        "const COUNTY_LAYER_URL = 'https://gis.colorado.gov/public/rest/services/OIT/County_GIS_Webpages/MapServer/0/query';",
        "return { source: bboxPick, requestedLocal: bboxPick, county: null, gate: 'unverified' };",
        "return { source: STATEWIDE_SOURCE, requestedLocal: bboxPick, county, gate: 'wrong-county' };",
        "gate: 'reassigned'",
        'const picked = await pickSourceForView(center[0], center[1]);',   // probe tab
        'const picked = await pickSourceForView(mid[0], mid[1]);',         // HN tab
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
    console.log(`shipped-source guard: OK (8 conditions present; ${SOURCES.length} local sources all declare a county)`);
    return true;
}

let pass = 0;
let fail = 0;
if (!assertShippedSourceMatches()) {
    process.exit(1);
}
for (const c of CASES) {
    const got = pick(c.lon, c.lat, c.county);
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
