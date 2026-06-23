# WME RPP GIS Address Probe

Custom Waze Map Editor userscript: a **read-only** diagnostic that cross-checks each
visible RPP against the **Colorado Springs authoritative address-point GIS layer**
(`gis.coloradosprings.gov`). It flags misplaced pins, wrong/typo'd streets, bad house
numbers, and entry points on the wrong street, then logs a per-RPP verdict. The scan
never edits the map; a reviewed one-click "Snap" corrects a misplaced pin. Test in the
WME sandbox.

Click the **🔬 Probe RPPs** button (bottom-left) or call `rppGisProbe()` in the console.

Loaded in Tampermonkey via a small loader that `@require`s the raw file from this repo's
`master` branch, so it works on both Windows and CachyOS. The loader keeps
`@grant GM_xmlhttpRequest`, `@connect gis.coloradosprings.gov`, and the turf `@require`.
Deploy a code change with `git push`.
