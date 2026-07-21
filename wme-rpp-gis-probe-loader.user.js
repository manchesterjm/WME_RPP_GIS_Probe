// ==UserScript==
// @name         WME RPP GIS Address Probe
// @namespace    http://tampermonkey.net/
// @version      2026.07.21.26
// @description  RPP vs Colorado authoritative GIS (LOCAL-first: 15 county sources + statewide last-resort fallback): flags misplaced pins, wrong/typo'd streets, and bad house numbers in a "🔬 Probe" side-panel tab (reviewed one-click "Snap"), PLUS a "🔢 HN" tab that adds house numbers missing from selected road segments, from the same GIS points (reviewed per-row "Add" + Add-all, unsaved until you save in WME).
// @match        https://www.waze.com/*editor*
// @match        https://beta.waze.com/*editor*
// @require      https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js
// @require      https://raw.githubusercontent.com/manchesterjm/WME_RPP_GIS_Probe/master/wme-rpp-gis-probe.user.js?v=2026.07.21.26
// @grant        GM_xmlhttpRequest
// @connect      gis.colorado.gov
// @connect      gis.coloradosprings.gov
// @connect      services.arcgis.com
// @connect      services1.arcgis.com
// @connect      services6.arcgis.com
// @connect      services7.arcgis.com
// @connect      gisapp.adcogov.org
// @connect      gis.arapahoegov.com
// @connect      maps.bouldercounty.org
// @connect      map.eaglecounty.us
// @connect      gis.co.grand.co.us
// @connect      mapservices2.jeffco.us
// @connect      gis-server.co.montezuma.co.us
// @connect      gispub.cityofaspen.com
// @connect      maps.co.pueblo.co.us
// @connect      mcgis.mesacounty.us
// ==/UserScript==

// Stub loader — the real code loads via @require from the raw GitHub file above
// (cross-OS: works on Windows + CachyOS, no local file:// path). Deploy a change with git push.
