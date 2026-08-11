/* eslint-env node */
/**
 * Regression harness for queryOneSource's paging (v.51).
 *
 * Why it exists: ArcGIS caps one response at the layer's maxRecordCount and
 * returns the first N **by object id, NOT the nearest N**. Every verdict in
 * this script is a distance argument — the probe's whole placement rule is
 * "is the RPP's own point the nearest one" — so a truncated response is not a
 * smaller answer, it is a WRONG one, and it looks exactly like a clean scan.
 * Measured 2026-08-11: Steamboat's city layer caps at 500 and a 500 m probe
 * radius downtown returned exactly 500; the radius box goes to 2000 m.
 *
 * The caps differ per service (500 there, 2000 on most), so the page size we
 * ASK for is not the page size we GET — the offset must advance by what the
 * page actually returned. That is the one bug this file exists to prevent.
 *
 * The shipped queryOneSource is lifted out by brace-matching and driven with a
 * stub page fetcher, so the loop under test is the one that ships.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SHIPPED = path.join(__dirname, 'wme-rpp-gis-probe.user.js');
const src = fs.readFileSync(SHIPPED, 'utf8');

function liftFunction(name) {
    const start = src.indexOf(`async function ${name}(`);
    if (start < 0) {
        throw new Error(`${name}() is not in the shipped source as an async function — this harness is stale.`);
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

function shippedConst(name) {
    const m = new RegExp(`const ${name} = (\\d+);`).exec(src);
    if (!m) {
        throw new Error(`${name} not found in the shipped source.`);
    }
    return Number(m[1]);
}
const QUERY_PAGE_SIZE = shippedConst('QUERY_PAGE_SIZE');
const QUERY_MAX_PAGES = shippedConst('QUERY_MAX_PAGES');

/**
 * Stub of one service. `cap` is the service's own maxRecordCount, which may be
 * smaller than the page size we request — Steamboat's is 500 against our 2000.
 */
function service(total, cap, { errorOnPage = null, lieAboutMore = false } = {}) {
    const calls = [];
    const fetchPage = async (source, lon, lat, radius, offset) => {
        calls.push(offset);
        if (errorOnPage === calls.length - 1) {
            return { error: 'HTTP 502', points: [], more: false };
        }
        const size = Math.min(cap, QUERY_PAGE_SIZE, Math.max(0, total - offset));
        const points = Array.from({ length: size }, (_, i) => ({ hn: String(offset + i) }));
        const more = lieAboutMore ? true : offset + size < total;
        return { error: null, points, more };
    };
    fetchPage.calls = calls;
    return fetchPage;
}

const run = new Function('queryOneSourcePage', 'QUERY_MAX_PAGES', `
    ${liftFunction('queryOneSource')}
    return queryOneSource;
`);

const CASES = [
    {
        name: 'one short page — a single request, no paging',
        svc: () => service(22, 2000),
        check: (res, svc) => res.error === null && res.points.length === 22 && svc.calls.length === 1,
    },
    {
        name: 'exactly one full page and no more — stops without a wasted request',
        svc: () => service(2000, 2000),
        check: (res, svc) => res.error === null && res.points.length === 2000 && svc.calls.length === 1,
    },
    {
        name: '🔑 service caps BELOW the requested page size — offset advances by what came back',
        svc: () => service(1288, 500),
        check: (res, svc) => res.error === null
            && res.points.length === 1288
            && JSON.stringify(svc.calls) === JSON.stringify([0, 500, 1000]),
    },
    {
        name: 'the Steamboat downtown shape: 2600 points at a 500 cap',
        svc: () => service(2600, 500),
        check: (res, svc) => res.error === null && res.points.length === 2600 && svc.calls.length === 6,
    },
    {
        name: 'every point is kept exactly once, in order',
        svc: () => service(1288, 500),
        check: (res) => res.points.length === 1288 && res.points.every((p, i) => p.hn === String(i)),
    },
    {
        name: 'an error on the FIRST page is reported, with no points',
        svc: () => service(5000, 500, { errorOnPage: 0 }),
        check: (res) => res.error === 'HTTP 502' && res.points.length === 0,
    },
    {
        name: '⛔ an error MID-paging is an error, never a quiet partial answer',
        svc: () => service(5000, 500, { errorOnPage: 2 }),
        check: (res) => res.error === 'HTTP 502' && res.points.length === 0,
    },
    {
        name: '⛔ blowing the page cap is an ERROR, not a truncated list',
        svc: () => service(500000, 500),
        check: (res, svc) => typeof res.error === 'string'
            && /too many points/.test(res.error)
            && res.points.length === 0
            && svc.calls.length === QUERY_MAX_PAGES,
    },
    {
        name: 'a service that claims another page while sending none must not spin forever',
        svc: () => service(30, 500, { lieAboutMore: true }),
        check: (res, svc) => res.error === null && res.points.length === 30 && svc.calls.length === 2,
    },
    {
        name: 'zero points is a clean empty answer (the v.44 coverage signal must survive)',
        svc: () => service(0, 500),
        check: (res) => res.error === null && res.points.length === 0,
    },
];

function assertShippedSourceMatches() {
    const required = [
        // The page request must actually ask for a page.
        'resultOffset: String(offset)',
        'resultRecordCount: String(QUERY_PAGE_SIZE)',
        // `more` must come from the service's own signal, not from a count guess.
        'more: data.exceededTransferLimit === true',
        // The offset must follow the delivered page, not the requested size.
        'offset += res.points.length',
    ];
    const missing = required.filter((r) => !src.includes(r));
    for (const m of missing) {
        console.error(`FAIL  shipped-source guard: missing \`${m}\``);
    }
    if (/offset \+= QUERY_PAGE_SIZE/.test(src)) {
        console.error('FAIL  shipped-source guard: the offset advances by the REQUESTED page size — a service with a smaller cap would silently skip records.');
        return false;
    }
    if (!missing.length) {
        console.log(`shipped-source guard: OK (page size ${QUERY_PAGE_SIZE}, cap ${QUERY_MAX_PAGES} pages)`);
    }
    return missing.length === 0;
}

(async () => {
    let pass = 0;
    let fail = 0;
    if (!assertShippedSourceMatches()) {
        process.exit(1);
    }
    for (const c of CASES) {
        const svc = c.svc();
        const queryOneSource = run(svc, QUERY_MAX_PAGES);
        const res = await queryOneSource({ id: 'stub' }, -106.8317, 40.485, 500);
        if (c.check(res, svc)) {
            pass += 1;
            console.log(`ok    ${c.name}`);
        } else {
            fail += 1;
            console.error(`FAIL  ${c.name}: got ${JSON.stringify({ error: res.error, points: res.points.length, calls: svc.calls })}`);
        }
    }
    console.log(`\n${pass} passed, ${fail} failed (${CASES.length} cases)`);
    process.exit(fail ? 1 : 0);
})();
