/* eslint-env node */
/**
 * Regression harness for the City of Steamboat Springs source (v.51, source #18).
 *
 * Field case (Josh, 2026-08-11): "HN filler is not finding addresses in Routt
 * County, though the GIS layers script finds 3 sources of address points."
 * Measured live: the wired `routt` county source and the statewide composite
 * BOTH return ZERO within 800 m of downtown Steamboat, because the CITY does
 * its own addressing (the county layer's JDX values are ROUTT / HAYDEN /
 * OAK CREEK / YAMPA / OUT OF THE COUNTY — no Steamboat) and the state composite
 * is the county's own submission. The missing piece was never a bug in the
 * matcher: it was the third GIS Layers source, the city's, not being wired.
 *
 * What this pins is the FIELD MAPPER, because the city's schema has three traps
 * and two of them fail SILENTLY — the point resolves to a plausible-looking
 * record that simply never produces an offer:
 *
 *   1. AddrNum is NULL on every record outside city limits (3,705 of 10,944),
 *      with the number in AddrNumFull / AddrFull. This is the Bayfield disease
 *      of v.43, and reading the dedicated column alone yields a correct street
 *      with an EMPTY house number — invisible, not broken.
 *   2. AddrNumFull is the only column carrying the "1/2" suffix. AddrNum alone
 *      collapses "502 1/2 Pine St" onto "502 Pine St" — two real, different
 *      properties becoming one.
 *   3. 25 records have no street name at all AND an AddrFull that is the bare
 *      house number ("28440"). composeStreetFromFull has nothing to strip there
 *      and hands the number back as if it were a road name.
 *
 * The mapper is lifted out of the shipped file (brace-matched from its
 * `id: 'steamboat'` entry) and run against attribute rows CAPTURED FROM THE
 * LIVE SERVICE on 2026-08-11 — downtown, the outside-city band, and every
 * street-less record — so the cases are the service's real output, not a guess
 * at its schema.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SHIPPED = path.join(__dirname, 'wme-rpp-gis-probe.user.js');
const src = fs.readFileSync(SHIPPED, 'utf8');

/** Lift a whole function declaration out of the shipped file by brace-matching. */
function liftFunction(name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) {
        throw new Error(`${name}() is not in the shipped source — this harness is stale.`);
    }
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') {
            depth += 1;
        } else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                return src.slice(start, i + 1);
            }
        }
    }
    throw new Error(`${name}() has unbalanced braces.`);
}

/** Lift one LOCAL_SOURCES entry, found by its id, as an object literal. */
function liftSource(id) {
    const marker = src.indexOf(`id: '${id}'`);
    if (marker < 0) {
        throw new Error(`LOCAL_SOURCES has no '${id}' entry — this harness is stale.`);
    }
    const start = src.lastIndexOf('{', marker);
    let depth = 0;
    for (let i = start; i < src.length; i++) {
        if (src[i] === '{') {
            depth += 1;
        } else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                return src.slice(start, i + 1);
            }
        }
    }
    throw new Error(`the '${id}' entry has unbalanced braces.`);
}

// One scope, so the mapper closes over the same helpers it does in the page.
const steamboat = new Function(`
    ${liftFunction('plainHn')}
    ${liftFunction('composeHn')}
    ${liftFunction('composeStreetFromFull')}
    ${src.match(/const LEADING_HN_RE = .*;/)[0]}
    return ${liftSource('steamboat')};
`)();
const map = steamboat.fields;

// Captured live 2026-08-11 from
// maps.steamboatsprings.net/.../InteractiveMapBase/MapServer/1.
const CASES = [
    // --- inside city limits: the ordinary downtown shape ---
    {
        name: 'downtown, AddrNum populated',
        row: { AddrNum: 613, AddrNumFull: '613', StreetNameFull: 'Oak St', AddrFull: '613 Oak St', CityLimits: 1, PropertyType: 'Exempt' },
        expect: { hn: '613', street: 'Oak St', city: 'Steamboat Springs' },
    },
    {
        name: 'downtown, numbered street name is left alone',
        row: { AddrNum: 24, AddrNumFull: '24', StreetNameFull: '5th St', AddrFull: '24 5th St', CityLimits: 1, PropertyType: 'Commercial' },
        expect: { hn: '24', street: '5th St', city: 'Steamboat Springs' },
    },
    {
        name: 'AddrFull missing entirely — the split columns still answer',
        row: { AddrNum: 348, AddrNumFull: '348', StreetNameFull: 'Oak St', AddrFull: null, CityLimits: 1, PropertyType: 'Single Family' },
        expect: { hn: '348', street: 'Oak St', city: 'Steamboat Springs' },
    },

    // --- trap 1: the outside-city band, AddrNum NULL (the Bayfield disease) ---
    {
        name: 'outside city limits: AddrNum NULL -> hn from AddrNumFull, NOT empty',
        row: { AddrNum: null, AddrNumFull: '42255', StreetNameFull: 'CADDIS HATCH TRL', AddrFull: '42255 CADDIS HATCH TRL', CityLimits: 0, PropertyType: null },
        expect: { hn: '42255', street: 'CADDIS HATCH TRL', city: '' },
    },
    {
        name: 'outside city limits: short rural number survives too',
        row: { AddrNum: null, AddrNumFull: '70', StreetNameFull: 'DEER CLOVER LN', AddrFull: '70 DEER CLOVER LN', CityLimits: 0, PropertyType: null },
        expect: { hn: '70', street: 'DEER CLOVER LN', city: '' },
    },
    {
        name: 'unincorporated points are NOT labelled Steamboat Springs',
        row: { AddrNum: null, AddrNumFull: '100', StreetNameFull: 'ALPINE DR', AddrFull: '100 ALPINE DR', CityLimits: 0, PropertyType: null },
        expect: { hn: '100', street: 'ALPINE DR', city: '' },
    },

    // --- trap 2: the eight half-numbers are distinct properties ---
    {
        name: '"502 1/2 Pine St" keeps its suffix (AddrNum alone would say 502)',
        row: { AddrNum: 502, AddrNumSuf: '1/2', AddrNumFull: '502 1/2', StreetNameFull: 'Pine St', AddrFull: '502 1/2 Pine St', CityLimits: 1, PropertyType: 'Single Family' },
        expect: { hn: '502 1/2', street: 'Pine St', city: 'Steamboat Springs' },
    },
    {
        name: 'plain "502 Pine St" stays a different house number from "502 1/2"',
        row: { AddrNum: 502, AddrNumFull: '502', StreetNameFull: 'Pine St', AddrFull: '502 Pine St', CityLimits: 1, PropertyType: 'Single Family' },
        expect: { hn: '502', street: 'Pine St', city: 'Steamboat Springs' },
    },
    {
        name: 'AddrFull spells the half "429.5" — AddrNumFull wins with "429 1/2"',
        row: { AddrNum: 429, AddrNumSuf: '1/2', AddrNumFull: '429 1/2', StreetNameFull: 'Pine St', AddrFull: '429.5 Pine St', CityLimits: 1, PropertyType: 'Single Family' },
        expect: { hn: '429 1/2', street: 'Pine St', city: 'Steamboat Springs' },
    },

    // --- trap 3: no street name, AddrFull is the bare number ---
    {
        name: 'street-less record: NO street invented from the bare number',
        row: { AddrNum: null, AddrNumFull: '28440', StreetNameFull: null, AddrFull: '28440', CityLimits: 0, PropertyType: null },
        expect: { hn: '28440', street: '', city: '' },
    },
    {
        name: 'street-less record with a null AddrFull too',
        row: { AddrNum: 1585, AddrNumFull: '1585', StreetNameFull: null, AddrFull: null, CityLimits: 1, PropertyType: null },
        expect: { hn: '1585', street: '', city: 'Steamboat Springs' },
    },

    // --- the AddrFull fallback still works when the street column is blank ---
    {
        name: 'blank street column but a real AddrFull -> street recovered, not the number',
        row: { AddrNum: null, AddrNumFull: '30500', StreetNameFull: '', AddrFull: '30500 Marabou Loop', CityLimits: 0, PropertyType: null },
        expect: { hn: '30500', street: 'Marabou Loop', city: '' },
    },
];

/**
 * Pin the parts of the shipped entry this harness cannot execute its way to:
 * the endpoint, the bbox, the county the gate compares against, and the
 * ordering rule that makes the city win its own ground.
 */
function assertShippedSourceMatches() {
    const problems = [];
    if (steamboat.county !== 'Routt') {
        problems.push(`county is ${JSON.stringify(steamboat.county)}, expected 'Routt' (the county gate compares against it)`);
    }
    if (!/^https:\/\/maps\.steamboatsprings\.net\//.test(steamboat.url)) {
        problems.push(`url is not the city's service: ${steamboat.url}`);
    }
    const [w, s, e, n] = steamboat.bbox;
    // Downtown Steamboat (40.4850, -106.8317) must fall inside, or the source
    // is never picked and the whole fix is inert.
    if (!(w <= -106.8317 && -106.8317 <= e && s <= 40.485 && 40.485 <= n)) {
        problems.push(`bbox ${JSON.stringify(steamboat.bbox)} does not contain downtown Steamboat`);
    }
    if (src.indexOf("id: 'steamboat'") > src.indexOf("id: 'routt'")) {
        problems.push("'steamboat' is listed AFTER 'routt' — pickLocalSource takes the FIRST bbox match, so the county would win the city's own ground");
    }
    if (!/@connect\s+maps\.steamboatsprings\.net/.test(fs.readFileSync(path.join(__dirname, 'wme-rpp-gis-probe-loader.user.js'), 'utf8'))) {
        problems.push('the loader has no @connect for maps.steamboatsprings.net — every query would fail as a network error');
    }
    if (!/AddrNumFull/.test(src)) {
        problems.push('the mapper no longer reads AddrNumFull — half-numbers and the whole outside-city band lose their house number');
    }
    for (const p of problems) {
        console.error(`FAIL  shipped-source guard: ${p}`);
    }
    if (!problems.length) {
        console.log(`shipped-source guard: OK (${steamboat.name}, county ${steamboat.county}, listed before routt, @connect present)`);
    }
    return problems.length === 0;
}

let pass = 0;
let fail = 0;
if (!assertShippedSourceMatches()) {
    process.exit(1);
}
for (const c of CASES) {
    const got = map(c.row);
    const bad = Object.keys(c.expect).filter((k) => got[k] !== c.expect[k]);
    if (!bad.length) {
        pass += 1;
        console.log(`ok    ${c.name}`);
    } else {
        fail += 1;
        for (const k of bad) {
            console.error(`FAIL  ${c.name}: ${k} expected ${JSON.stringify(c.expect[k])}, got ${JSON.stringify(got[k])}`);
        }
    }
}
console.log(`\n${pass} passed, ${fail} failed (${CASES.length} cases)`);
process.exit(fail ? 1 : 0);
