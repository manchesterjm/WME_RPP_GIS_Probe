/* eslint-env node */
/**
 * Regression harness for the PROBE's per-RPP GIS source fallback (v.44).
 *
 * Field case that motivated it (2026-07-29, Josh): scanning RPPs in ADAMS
 * County reported "Arapahoe County (local)" and returned no-gis for every pin.
 * Cause: LOCAL_SOURCES bboxes are RECTANGLES and Arapahoe's legitimately
 * reaches 39.787 (its service's own reported data extent) while its DATA stops
 * at the Colfax county line (~39.74). Arapahoe therefore answered with zero
 * points and NO error, and the old error-only fallback never fired.
 *
 * Two behaviours are pinned here, and the second matters as much as the first:
 *   1. zero-from-local + statewide HAS data  -> switch (real coverage hole)
 *   2. zero-from-local + statewide also zero -> DO NOT switch (genuinely empty
 *      rural spot; must stay no-gis and must not flip the source for the rest
 *      of the scan)
 *
 * ⚠️ SCOPE LIMIT, stated honestly: the shipped decision is inline inside
 * probeVisibleRpps(), which needs a live WME/SDK to execute, so this harness
 * REPLICATES that branch rather than importing it. To stop the two drifting,
 * `assertShippedSourceMatches()` greps the shipped file for the load-bearing
 * conditions — if someone edits the real branch without updating this file,
 * the harness fails instead of silently passing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SHIPPED = path.join(__dirname, 'wme-rpp-gis-probe.user.js');
const STATEWIDE = { id: 'co-state', name: 'State of Colorado' };

/** Replica of the shipped branch. Returns the post-decision state. */
async function resolveForRpp(activeSource, queryOneSource, lon, lat, radius) {
    let usedFallback = false;
    let { error, points } = await queryOneSource(activeSource, lon, lat, radius);

    if (error && activeSource.id !== STATEWIDE.id) {
        usedFallback = 'error';
        activeSource = STATEWIDE;
        ({ error, points } = await queryOneSource(activeSource, lon, lat, radius));
    } else if (!error && !points.length && activeSource.id !== STATEWIDE.id) {
        const stateProbe = await queryOneSource(STATEWIDE, lon, lat, radius);
        if (!stateProbe.error && stateProbe.points.length) {
            usedFallback = 'coverage';
            activeSource = STATEWIDE;
            points = stateProbe.points;
        }
    }
    return { sourceId: activeSource.id, usedFallback, pointCount: points.length, error };
}

/** Stub factory: canned answers per source id. */
function stubQuery(answers) {
    let calls = 0;
    const fn = async (source) => {
        calls += 1;
        return answers[source.id] || { error: null, points: [] };
    };
    fn.callCount = () => calls;
    return fn;
}

const pts = (n) => Array.from({ length: n }, (_, i) => ({ hn: String(100 + i) }));
const ARAPAHOE = { id: 'arapahoe', name: 'Arapahoe County' };

const CASES = [
    {
        name: 'local has data -> stays local, no fallback, no extra query',
        source: ARAPAHOE,
        answers: { arapahoe: { error: null, points: pts(5) }, 'co-state': { error: null, points: pts(9) } },
        expect: { sourceId: 'arapahoe', usedFallback: false, pointCount: 5 },
        expectCalls: 1,
    },
    {
        name: 'local ERRORS -> fallback "error" to statewide (pre-existing behaviour)',
        source: ARAPAHOE,
        answers: { arapahoe: { error: 'HTTP 502', points: [] }, 'co-state': { error: null, points: pts(7) } },
        expect: { sourceId: 'co-state', usedFallback: 'error', pointCount: 7 },
        expectCalls: 2,
    },
    {
        name: 'THE ADAMS CASE: local zero + statewide HAS data -> fallback "coverage"',
        source: ARAPAHOE,
        answers: { arapahoe: { error: null, points: [] }, 'co-state': { error: null, points: pts(12) } },
        expect: { sourceId: 'co-state', usedFallback: 'coverage', pointCount: 12 },
        expectCalls: 2,
    },
    {
        name: 'GUARD: local zero + statewide zero -> stay local, genuine no-gis',
        source: ARAPAHOE,
        answers: { arapahoe: { error: null, points: [] }, 'co-state': { error: null, points: [] } },
        expect: { sourceId: 'arapahoe', usedFallback: false, pointCount: 0 },
        expectCalls: 2,
    },
    {
        name: 'GUARD: local zero + statewide ERRORS -> stay local, do not flip on a failed probe',
        source: ARAPAHOE,
        answers: { arapahoe: { error: null, points: [] }, 'co-state': { error: 'HTTP 500', points: [] } },
        expect: { sourceId: 'arapahoe', usedFallback: false, pointCount: 0 },
        expectCalls: 2,
    },
    {
        name: 'already on statewide + zero -> no self-fallback, no extra query',
        source: STATEWIDE,
        answers: { 'co-state': { error: null, points: [] } },
        expect: { sourceId: 'co-state', usedFallback: false, pointCount: 0 },
        expectCalls: 1,
    },
    {
        name: 'already on statewide + error -> reported, not retried',
        source: STATEWIDE,
        answers: { 'co-state': { error: 'HTTP 503', points: [] } },
        expect: { sourceId: 'co-state', usedFallback: false, pointCount: 0, error: 'HTTP 503' },
        expectCalls: 1,
    },
];

/** Fail loudly if the shipped branch no longer looks like the replica. */
function assertShippedSourceMatches() {
    const src = fs.readFileSync(SHIPPED, 'utf8');
    const required = [
        "usedFallback = 'error'",
        "usedFallback = 'coverage'",
        '!error && !points.length && activeSource.id !== STATEWIDE_SOURCE.id',
        'const stateProbe = await queryOneSource(STATEWIDE_SOURCE',
        '!stateProbe.error && stateProbe.points.length',
    ];
    const missing = required.filter((s) => !src.includes(s));
    if (missing.length) {
        console.error('FAIL: shipped source no longer matches this harness. Missing:');
        missing.forEach((m) => console.error(`   - ${m}`));
        return false;
    }
    console.log('shipped-source guard: OK (all 5 load-bearing conditions present)');
    return true;
}

(async () => {
    let pass = 0;
    let fail = 0;

    if (!assertShippedSourceMatches()) {
        process.exit(1);
    }

    for (const c of CASES) {
        const q = stubQuery(c.answers);
        const got = await resolveForRpp(c.source, q, -104.83, 39.76, 60);
        const errs = [];
        for (const [k, v] of Object.entries(c.expect)) {
            if (got[k] !== v) {
                errs.push(`${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`);
            }
        }
        if (c.expectCalls !== undefined && q.callCount() !== c.expectCalls) {
            errs.push(`query calls: expected ${c.expectCalls}, got ${q.callCount()}`);
        }
        if (errs.length) {
            fail += 1;
            console.error(`FAIL  ${c.name}`);
            errs.forEach((e) => console.error(`        ${e}`));
        } else {
            pass += 1;
            console.log(`ok    ${c.name}`);
        }
    }

    console.log(`\n${pass} passed, ${fail} failed (${CASES.length} cases)`);
    process.exit(fail ? 1 : 0);
})();
