/* eslint-env node */
/**
 * Regression harness for the v.45 RPP-street-disagreement classifier.
 *
 * Field case (Josh, 2026-07-29, E Warren Cir / Aurora): the HN Filler reported
 * "5 covered by RPPs · 0 missing" while FOUR of those five RPPs carried the
 * wrong street name. `existingRppNumbers()` returned house NUMBERS ONLY, and
 * its geometric fallback added a number whenever the RPP sat in the corridor —
 * even when the RPP's street resolved fine and simply disagreed.
 *
 * The three cases that had been collapsed into two:
 *   a) street resolves AND matches a selected segment -> covered, silent
 *   b) street does NOT resolve, but is in corridor     -> covered, silent
 *      (the fallback's ORIGINAL intent, preserved verbatim)
 *   c) street resolves and DISAGREES, in corridor      -> rename candidate
 *
 * 🔑 The case that decides the whole design is `18845`: it sits 29 m from the
 * selected E Warren Cir loop but 76 m from E Warren Dr — 2.6x closer to the
 * road being scanned — yet GIS says E WARREN DR and the RPP already says
 * E Warren Dr. Both are CORRECT. A "nearest drawn road wins" rule would have
 * silently corrupted it. GIS is the authority; geometry is never the decider.
 *
 * ⚠️ SCOPE LIMIT, stated plainly: `indexRpps()` reads the live `W.model`, so it
 * cannot be imported here. This harness REPLICATES its branch logic and then
 * `assertShippedSourceMatches()` greps the shipped file for the load-bearing
 * lines, so the replica fails loudly rather than drifting out of sync.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SHIPPED = path.join(__dirname, 'wme-rpp-gis-probe.user.js');

/** Replica of indexRpps()'s per-venue decision. */
function classify(rpp, segStreets, corridor) {
    const matches = (s) => segStreets.some((ss) => ss.toUpperCase() === String(s).toUpperCase());
    const resolved = !!rpp.street;
    if (resolved && matches(rpp.street)) {
        return 'covered';               // (a)
    }
    if (rpp.dSel > corridor) {
        return 'out-of-range';
    }
    if (!resolved) {
        return 'covered';               // (b) unresolvable street — original fallback
    }
    return 'disagree';                  // (c)
}

const SEL = ['E Warren Cir'];
const CORRIDOR = 320;

const CASES = [
    // --- the real field data (RPP street vs GIS street), selection = E Warren Cir
    { name: '18909 correct on the selected street', rpp: { street: 'E Warren Cir', dSel: 14 }, expect: 'covered' },
    { name: '18919 MIS-NAMED (GIS: Cir)', rpp: { street: 'E Warren Dr', dSel: 21 }, expect: 'disagree' },
    { name: '18929 MIS-NAMED (GIS: Cir, 13m)', rpp: { street: 'E Warren Dr', dSel: 13 }, expect: 'disagree' },
    { name: '18930 MIS-NAMED (GIS: Cir)', rpp: { street: 'E Warren Dr', dSel: 36 }, expect: 'disagree' },
    { name: '18939 MIS-NAMED (GIS: Cir)', rpp: { street: 'E Warren Dr', dSel: 23 }, expect: 'disagree' },

    // --- 🔑 THE GUARD CASE: correct RPP that is CLOSER to the scanned road.
    // classify() flags it "disagree" purely on the name; it is the GIS-street
    // gate at the call site that keeps it silent (its GIS street is E Warren
    // Dr, which never matches a selected segment, so the loop `continue`s long
    // before the RPP index is consulted). Pinned so the ordering is not lost.
    { name: '18845 correct-on-Dr but 29m from Cir vs 76m from Dr', rpp: { street: 'E Warren Dr', dSel: 29 }, expect: 'disagree', note: 'gated upstream by the GIS street, NOT by distance' },

    // --- the preserved fallback + range guards
    { name: 'unresolvable street in corridor -> still silently covered (b)', rpp: { street: '', dSel: 40 }, expect: 'covered' },
    { name: 'unresolvable street OUT of corridor -> ignored', rpp: { street: '', dSel: 900 }, expect: 'out-of-range' },
    { name: 'disagreeing street OUT of corridor -> ignored', rpp: { street: 'E Baltic Pl', dSel: 900 }, expect: 'out-of-range' },
    { name: 'matching street far away -> still covered (name beats distance)', rpp: { street: 'E Warren Cir', dSel: 5000 }, expect: 'covered' },
    { name: 'case-insensitive match', rpp: { street: 'E WARREN CIR', dSel: 10 }, expect: 'covered' },
];

function assertShippedSourceMatches() {
    const src = fs.readFileSync(SHIPPED, 'utf8');
    const required = [
        'function indexRpps(',
        'const disagree = new Map();',
        'covered.add(norm);      // (a) name agrees',
        'covered.add(norm);      // (b) street won\'t resolve',
        'const badRpp = rppIdx.disagree.get(norm);',
        'function hnRenameRppOne(c)',
        'renameRpps.set(badRpp.venueId',
    ];
    const missing = required.filter((s) => !src.includes(s));
    if (missing.length) {
        console.error('FAIL: shipped source no longer matches this harness. Missing:');
        missing.forEach((m) => console.error(`   - ${m}`));
        return false;
    }
    // the old number-only function must be gone, or the bug can come back
    if (src.includes('function existingRppNumbers')) {
        console.error('FAIL: existingRppNumbers() is back — the number-only bug would return.');
        return false;
    }
    console.log('shipped-source guard: OK (7 conditions present, old function retired)');
    return true;
}

let pass = 0;
let fail = 0;
if (!assertShippedSourceMatches()) {
    process.exit(1);
}
for (const c of CASES) {
    const got = classify(c.rpp, SEL, CORRIDOR);
    if (got === c.expect) {
        pass += 1;
        console.log(`ok    ${c.name}${c.note ? `  [${c.note}]` : ''}`);
    } else {
        fail += 1;
        console.error(`FAIL  ${c.name}: expected ${c.expect}, got ${got}`);
    }
}
console.log(`\n${pass} passed, ${fail} failed (${CASES.length} cases)`);
process.exit(fail ? 1 : 0);
