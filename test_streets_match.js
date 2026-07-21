// Street-matching regression harness — run with: node test_streets_match.js
// Extracts STREET_TYPES + normalizeStreet/streetCore/streetsMatch from the
// userscript (no browser needed; they're pure) and checks every WME-vs-GIS
// name pair that has bitten us in the field, plus must-refuse controls.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'wme-rpp-gis-probe.user.js'), 'utf8');
const grab = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
eval(grab('const STREET_TYPES', 'let wmeSdk') + grab('function normalizeStreet', '// ---- GIS query'));

const cases = [
    // [WME side, GIS side, expected] — field bugs (all 2026-07-21):
    ['Needle Leaf Ln', 'NEEDLELEAF', true],          // word-boundary variance + bare type
    ['Needle Leaf Ln', 'NEEDLELEAF LN', true],
    ['Needleleaf Ln', 'NEEDLE LEAF LN', true],
    ['Sunset View Way', 'SUNSET VIEW', true],        // name ends in a type-looking word, GIS bare
    ['Sunset View Way', 'SUNSET VIEW WAY', true],
    ['Sunset View Way', 'SUNSET VIEW WY', true],
    ['Loblolly Pine Way', 'LOBLOLLY PINE WY', true], // USPS variant Wy
    ['Timber Vw', 'TIMBER VIEW', true],              // WME uses both View and Vw
    // General coverage:
    ['Mountain View Dr', 'MOUNTAIN VW DR', true],
    ['Mountain View Dr', 'MOUNTAIN VIEW', true],
    ['Springnite Drive', 'SPRINGNITE DR', true],
    ['Loblolly Pine Cir', 'LOBLOLLY PINE CIR', true],
    ['Aspen Trl', 'ASPEN TRAIL', true],
    ['Old Ranch Pkwy', 'OLD RANCH PKY', true],
    ['Vista Pointe', 'VISTA PT', true],
    ['Alder Pl', 'ALDER PLACE', true],
    ['Crystal Park Rd', 'CRYSTAL PARK ROAD', true],  // PARK mid-name must survive
    ['Spring Creek Dr', 'SPG CRK DR', true],         // mid-name tokens canonicalize both sides
    ['Loblolly Pine', 'LOBLOLLY PINE WY', true],     // WME side missing the type
    ['Big Johnson Dr', 'BIG JOHNSON', true],         // GIS side missing the type
    // Must REFUSE:
    ['E Woodmen Rd', 'WOODMEN RD', false],           // missing directional = real flag (intentional gap)
    ['Estes St', 'ESTES PARK', false],
    ['Sage Brush Way', 'SAGE BRUSH TRL', false],     // conflicting types = different streets
    ['Sunset View', 'SUNSET WAY', false],
];

let failures = 0;
for (const [wme, gis, expected] of cases) {
    const got = streetsMatch(wme, gis);
    if (got !== expected) {
        failures++;
        console.error(`FAIL: "${wme}" vs "${gis}" → ${got}, expected ${expected}`);
    }
}
if (failures) {
    console.error(`${failures}/${cases.length} FAILED`);
    process.exit(1);
}
console.log(`ALL ${cases.length} CASES PASS`);
