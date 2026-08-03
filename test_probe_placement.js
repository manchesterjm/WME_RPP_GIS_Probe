/* eslint-env node */
/**
 * Regression harness for the 🔬 Probe's placement ladder and its v.47
 * user-settable misplacement tolerance.
 *
 * Josh's ask 2026-08-03: a box for "the distance that the RPP is from where the
 * GIS says it should be". That distance is `own.dist` — pin to its OWN matched
 * GIS point — and the knob that decides how much of it is too much is the
 * `farOwnM` cap (30 m by default since the Mesa Co case, 2026-07-21).
 *
 * This harness runs the SHIPPED `evaluateRpp` / `rppHnString` / `distMeters`,
 * lifted out of the userscript by brace-matching, so it cannot drift from what
 * actually ships. Only `streetsMatch` is stubbed (exact, case-insensitive) —
 * street matching has its own 85-case harness and every case here uses one
 * spelling, so a real matcher would add nothing but a dependency.
 *
 * The ladder being pinned, in order:
 *   1. own point within wellPlacedM (capped by the user's cap) -> ok
 *   2. a DIFFERENT address at least misplacedMarginM closer    -> misplaced
 *   3. own point beyond the user's cap, nothing else nearer    -> misplaced
 *   4. otherwise                                               -> ok
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

// Real values, read off the shipped CONFIG so a retune shows up here as a
// failing expectation rather than as silently different behavior.
function shippedConfigNumber(key) {
    const m = new RegExp(`${key}:\\s*(\\d+)`).exec(src);
    if (!m) {
        throw new Error(`CONFIG.${key} not found in the shipped source.`);
    }
    return Number(m[1]);
}
const CONFIG = {
    farOwnM: shippedConfigNumber('farOwnM'),
    wellPlacedM: shippedConfigNumber('wellPlacedM'),
    misplacedMarginM: shippedConfigNumber('misplacedMarginM'),
    wrongHnCloseM: shippedConfigNumber('wrongHnCloseM'),
};

const streetsMatch = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();

// The shipped distMeters() calls turf, which the page loads via @require. Rather
// than pull the library in, hand it a haversine of the same shape — every case
// here offsets due north, where the two agree to well under a metre.
const turf = {
    point: (coords) => coords,
    distance: (a, b) => {
        const toRad = (d) => (d * Math.PI) / 180;
        const [lon1, lat1] = a;
        const [lon2, lat2] = b;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const h = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return 6371.0088 * 2 * Math.asin(Math.sqrt(h));   // kilometres, as turf returns
    },
};

// Compiled in one scope with CONFIG + streetsMatch injected, because a strict-mode
// `eval` of a function declaration does not publish it to the enclosing scope.
const lifted = new Function('CONFIG', 'streetsMatch', 'turf', `
    ${liftFunction('distMeters')}
    ${liftFunction('rppHnString')}
    ${liftFunction('evaluateRpp')}
    return { evaluateRpp };
`)(CONFIG, streetsMatch, turf);
const evaluateRpp = lifted.evaluateRpp;

// Fixed origin (Josh's own neighborhood) — points are placed by offsetting
// latitude, so "N metres away" in a case is N metres on the ground.
const LON = -104.7494;
const LAT = 38.9199;
const M_PER_DEG_LAT = 111320;
const north = (metres) => LAT + metres / M_PER_DEG_LAT;

const rpp = { id: 1, hn: '6219', street: 'Stemwood Dr', lon: LON, lat: LAT };
const at = (metres, hn, street) => ({ hn, street, address: `${hn} ${street}`, lon: LON, lat: north(metres) });
const own = (metres) => at(metres, '6219', 'Stemwood Dr');
const neighbor = (metres) => at(metres, '6225', 'Stemwood Dr');

const CASES = [
    // --- default cap (30): the behavior that shipped before the box existed ---
    { name: 'own point 5m away -> ok (well-placed fast path)', points: [own(5)], cap: 30, expect: 'ok' },
    { name: 'own point 25m away, nothing nearer -> ok (long driveway, not an error)', points: [own(25)], cap: 30, expect: 'ok' },
    { name: 'own point 45m away, nothing nearer -> misplaced (past the cap)', points: [own(45)], cap: 30, expect: 'misplaced' },
    { name: 'own 40m but a neighbor at 5m -> misplaced (wrong lot)', points: [own(40), neighbor(5)], cap: 30, expect: 'misplaced' },

    // --- THE ASK: the cap is what the box moves ---
    { name: 'own 45m with the cap raised to 100 -> ok', points: [own(45)], cap: 100, expect: 'ok' },
    { name: 'own 25m with the cap tightened to 20 -> misplaced', points: [own(25)], cap: 20, expect: 'misplaced' },
    { name: 'exactly AT the cap is ok (strictly greater flags)', points: [own(30)], cap: 30, expect: 'ok' },
    { name: 'one metre past the cap flags', points: [own(31)], cap: 30, expect: 'misplaced' },

    // 🔑 A cap BELOW wellPlacedM must still bite. The 12m fast path returns `ok`
    // before the cap check is ever reached, so it has to be clamped to the cap —
    // otherwise Josh sets 8 and a pin 10m out silently passes.
    { name: 'cap 8 (under the 12m fast path): own 10m -> misplaced, NOT swallowed by well-placed', points: [own(10)], cap: 8, expect: 'misplaced' },
    { name: 'cap 8: own 6m -> still ok', points: [own(6)], cap: 8, expect: 'ok' },

    // --- the neighbor rule is independent of the cap (raising it must not blind the probe) ---
    { name: 'huge cap does NOT suppress a clearly-closer different address', points: [own(40), neighbor(5)], cap: 1000, expect: 'misplaced' },
    { name: 'neighbor closer but inside the margin -> not misplaced', points: [own(20), neighbor(15)], cap: 30, expect: 'ok' },

    // --- the other verdicts must be untouched by the cap ---
    { name: 'no points at all -> no-gis whatever the cap', points: [], cap: 1000, expect: 'no-gis' },
    { name: 'different HN sitting on the pin -> wrong-hn', points: [neighbor(3)], cap: 30, expect: 'wrong-hn' },
    { name: 'own HN on a different street -> hn-diff-street', points: [at(20, '6219', 'Stemwood Ct')], cap: 30, expect: 'hn-diff-street' },
    { name: 'no matching HN nearby -> no-match', points: [neighbor(200)], cap: 30, expect: 'no-match' },
];

function assertShippedSourceMatches() {
    const required = [
        'function evaluateRpp(info, points, farCap = CONFIG.farOwnM)',
        'const wellPlacedM = Math.min(CONFIG.wellPlacedM, farCap);',
        'if (own.dist > farCap) {',
        'const farCapM = probeFarOwnM();',
        'evaluateRpp(info, points, farCapM)',
        "const PROBE_FAR_STORE = 'rppProbe.farOwnM';",
        'id="rpp-gis-probe-farown"',
        // v.48 — Snap must also remake the stop point. Not unit-testable (it is
        // a live SDK write), so the wiring is pinned here instead: the reset is
        // called from snapRpp, and its outcome reaches the row so a half-done
        // snap can't render as a clean one.
        'function resetNavigationPoints(venueId, lon, lat)',
        'venues.replaceNavigationPoints({',
        'const nav = resetNavigationPoints(venueId, lon, lat);',
        'return { ok: true, navOk: nav.ok, navErr: nav.err };',
        'if (res.navOk) {',
    ];
    const missing = required.filter((s) => !src.includes(s));
    if (missing.length) {
        console.error('FAIL: the shipped source no longer wires the user cap. Missing:');
        missing.forEach((m) => console.error(`   - ${m}`));
        return false;
    }
    if (/own\.dist > CONFIG\.farOwnM/.test(src)) {
        console.error('FAIL: the ladder reads CONFIG.farOwnM directly again — the box would stop working.');
        return false;
    }
    console.log(`shipped-source guard: OK (12 conditions present; defaults far=${CONFIG.farOwnM} wellPlaced=${CONFIG.wellPlacedM} margin=${CONFIG.misplacedMarginM})`);
    return true;
}

let pass = 0;
let fail = 0;
if (!assertShippedSourceMatches()) {
    process.exit(1);
}
for (const c of CASES) {
    const got = evaluateRpp(rpp, c.points, c.cap).code;
    if (got === c.expect) {
        pass += 1;
        console.log(`ok    ${c.name}`);
    } else {
        fail += 1;
        console.error(`FAIL  ${c.name}: expected ${c.expect}, got ${got}`);
    }
}
console.log(`\n${pass} passed, ${fail} failed (${CASES.length} cases)`);
process.exit(fail ? 1 : 0);
