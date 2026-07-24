// Street-matching regression harness — run with: node test_streets_match.js
// Extracts STREET_TYPES + normalizeStreet/streetCore/streetsMatch from the
// userscript (no browser needed; they're pure) and checks every WME-vs-GIS
// name pair that has bitten us in the field, plus must-refuse controls.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'wme-rpp-gis-probe.user.js'), 'utf8');
const grab = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
eval(grab('const STREET_TYPES', 'let wmeSdk') + grab('// ---- street matching', '// ---- GIS query'));

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
    // Numbered routes (WME CO conventions vs GIS spellings, 2026-07-21):
    ['CR-123', 'COUNTY ROAD 123', true],
    ['CR-123', 'COUNTY RD 123', true],
    ['CR-7', 'COUNTY ROAD 007', true],               // leading zeros
    ['SH-23', 'CO-23', true],
    ['SH-134', 'COLORADO 134', true],
    ['SH-105', 'HIGHWAY 105', true],
    ['SH-83', 'STATE HIGHWAY 83', true],
    ['WCR-45', 'COUNTY ROAD 45', true],              // Weld: WCR folds into CR
    ['WCR-45', 'WELD COUNTY ROAD 45', true],
    ['US-85', 'US HIGHWAY 85', true],
    ['I-25', 'INTERSTATE 25', true],
    ['CR-59A', 'COUNTY ROAD 59A', true],             // letter-suffixed route number
    // Route concurrencies + ambiguous HIGHWAY (2026-07-21, Mesa US-6/US-50):
    ['US-50', 'HIGHWAY 6 AND 50', true],             // concurrency matches either member
    ['US-50', 'HWY 6 AND 50', true],                 // Mesa E911's actual stored spelling
    ['US-6', 'HWY 6 AND 50', true],
    ['US-50', 'HIGHWAY 50', true],                   // bare HIGHWAY wildcards against US
    ['SH-105', 'HIGHWAY 105', true],                 // …and against SH
    ['US-50', 'US 6 AND 50', true],
    ['SH-340', 'HIGHWAY 6 AND 50', false],           // number not in the concurrency
    ['CR-50', 'HIGHWAY 50', false],                  // HWY wildcard never covers county roads
    ['US-50', 'Main St', false],                     // route vs real name never match
    ['Smith-Jones Rd', 'SMITH JONES RD', true],      // hyphen = space in real names too
    ['Talon Loop', 'TALON LP', true],                // WME uses both Loop and Lp
    ['Talon Lp', 'TALON LOOP', true],
    ['Talon Loop', 'TALON', true],                   // GIS bare form, one-sided strip
    ['Talon Loop', 'TALON TRL', false],              // conflicting types still refuse
    ['Highway View Dr', 'HIGHWAY VIEW DR', true],    // route words inside a real name: untouched
    // Directional-prefixed routes (2026-07-24, Berthoud W CR-4 — closes the
    // old "E County Road 30 passes through unrouted" gap):
    ['W CR-4', 'W COUNTY ROAD 4', true],
    ['W CR-4', 'WEST COUNTY ROAD 4', true],          // spelled-out directional
    ['W CR-4', 'COUNTY ROAD 4', true],               // one-sided directional ignored
    ['E County Road 30', 'CR-30', true],             // the documented gap case itself
    ['W CR-4', 'COUNTY ROAD 4 W', true],             // trailing directional, position-blind
    ['W CR-4', 'E COUNTY ROAD 4', false],            // conflicting directionals refuse
    ['W CR-4', 'W COUNTY ROAD 5', false],            // different numbers still refuse
    ['N Highway View Dr', 'N HIGHWAY VIEW DR', true],// dir + route words inside a real name: untouched
    // Cardinal directionals (2026-07-21, Josh: translate + one-sided ignore):
    ['E Woodmen Rd', 'WOODMEN RD', true],            // FLIPPED from the old intentional gap: one-sided dir ignored
    ['E Woodmen Rd', 'EAST WOODMEN RD', true],       // spelled-out translator
    ['Woodmen Rd', 'EAST WOODMEN ROAD', true],
    ['North Pines Trl', 'N PINES TRL', true],        // name-leading North still matches its abbreviated twin
    ['North Pines Trl', 'PINES TRL', true],          // one-sided ignore (accepted looseness, corridor limits damage)
    ['N Academy Blvd', 'ACADEMY BLVD N', true],      // same dir, position-blind
    ['S Union Blvd', 'UNION BOULEVARD SOUTH', true],
    // Ordinal names (2026-07-21): GIS spells out, signs/WME use digits:
    ['1st St', 'FIRST ST', true],
    ['2nd Ave', 'SECOND AVENUE', true],
    ['3rd Pl', 'THIRD PLACE', true],
    ['4th St', 'FOURTH', true],                      // GIS bare, one-sided type strip composes
    ['21st Ave', 'TWENTY FIRST AVE', true],
    ['21st Ave', 'TWENTY-FIRST AVENUE', true],
    ['30th St', 'THIRTIETH ST', true],
    ['E 12th St', 'TWELFTH ST', true],               // ordinal + one-sided directional
    ['1st St', 'SECOND ST', false],
    // Must REFUSE:
    ['E Woodmen Rd', 'W WOODMEN RD', false],         // conflicting directionals = different streets
    ['NE Circle Dr', 'SW CIRCLE DR', false],
    ['Estes St', 'ESTES PARK', false],
    ['Sage Brush Way', 'SAGE BRUSH TRL', false],     // conflicting types = different streets
    ['Sunset View', 'SUNSET WAY', false],
    ['CR-123', 'COUNTY ROAD 124', false],            // different route numbers
    ['SH-23', 'US-23', false],                       // different route systems
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
