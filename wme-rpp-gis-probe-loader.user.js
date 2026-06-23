// ==UserScript==
// @name         WME RPP GIS Address Probe
// @namespace    http://tampermonkey.net/
// @version      2026.06.23.2
// @description  RPP vs Colorado Springs authoritative GIS: flags misplaced pins, wrong/typo'd streets, bad house numbers, and entry points on the wrong street. Scan is read-only; a reviewed one-click "Snap" corrects a misplaced pin. Test in WME sandbox.
// @match        https://www.waze.com/*editor*
// @match        https://beta.waze.com/*editor*
// @require      https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js
// @require      https://raw.githubusercontent.com/manchesterjm/WME_RPP_GIS_Probe/master/wme-rpp-gis-probe.user.js
// @grant        GM_xmlhttpRequest
// @connect      gis.coloradosprings.gov
// ==/UserScript==

// Stub loader — the real code loads via @require from the raw GitHub file above
// (cross-OS: works on Windows + CachyOS, no local file:// path). Deploy a change with git push.
